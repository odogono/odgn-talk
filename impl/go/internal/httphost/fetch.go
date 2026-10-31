package httphost

// fetch's Host side (spec chapter 7, Fetching; chapter 9, The http factory;
// ADR 0151): it checks the origin against the binding and makes one buffered
// HTTP/1.1 request with net/http. It follows no redirect, decompresses
// nothing, keeps no cookies or connections between calls, and bounds what it
// buffers.

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	talk "northtalk.org/go"
)

// DefaultFetchMaxBodyBytes is the largest response body fetch reads unless
// FetchOptions says otherwise: 8 MiB.
const DefaultFetchMaxBodyBytes = 8 << 20

// DefaultFetchMaxHeaderBytes is the most response header bytes fetch reads,
// trailers included, unless FetchOptions says otherwise: 64 KiB.
const DefaultFetchMaxHeaderBytes = 64 << 10

// Origins are the origins a Grant may fetch from: any, or exactly those
// listed, each a scheme, host and optional port with no path, query or
// wildcard. The zero value allows none.
type Origins struct {
	Any  bool
	List []string
}

// FetchOptions configures a Fetcher.
type FetchOptions struct {
	// Origins gives the origins a Grant, by its binding, may fetch from. nil
	// allows none; a refused origin fails fetch with `bad address`.
	Origins func(binding any) Origins
	// RootCAs are the certificate authorities HTTPS trusts; nil means the
	// system's.
	RootCAs *x509.CertPool
	// MaxBodyBytes caps a response body; 0 means DefaultFetchMaxBodyBytes.
	MaxBodyBytes int64
	// MaxHeaderBytes caps the response's header bytes, trailers included,
	// counting each field line's name and value plus 4; 0 means
	// DefaultFetchMaxHeaderBytes.
	MaxHeaderBytes int64
	// Log is told why a call failed. It is never shown to the Script.
	Log func(string)
}

// Fetcher makes fetch's requests. It implements talk.HTTPFetchImpl.
type Fetcher struct {
	options FetchOptions
	client  *http.Client
}

var _ talk.HTTPFetchImpl = (*Fetcher)(nil)

// NewFetcher makes a Fetcher.
func NewFetcher(o FetchOptions) (*Fetcher, error) {
	if o.MaxBodyBytes < 0 || o.MaxHeaderBytes < 0 {
		return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "fetch bounds must be whole numbers"}
	}
	if o.MaxBodyBytes == 0 {
		o.MaxBodyBytes = DefaultFetchMaxBodyBytes
	}
	if o.MaxHeaderBytes == 0 {
		o.MaxHeaderBytes = DefaultFetchMaxHeaderBytes
	}
	if o.Log == nil {
		o.Log = func(string) {}
	}
	transport := &http.Transport{
		// A proxy is the Host's choice; this one uses none.
		Proxy:              nil,
		DisableCompression: true,
		// One connection per call: nothing kept between calls.
		DisableKeepAlives: true,
		// Our own count is the bound; this only stops the parser first.
		MaxResponseHeaderBytes: o.MaxHeaderBytes + 16<<10,
		TLSClientConfig:        &tls.Config{RootCAs: o.RootCAs, MinVersion: tls.VersionTLS12},
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return &Fetcher{options: o, client: client}, nil
}

// Origin is a URL's origin, scheme://host:port, always with its port, or
// false for a URL that isn't an absolute HTTP(S) URL with a host.
func Origin(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", false
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[strings.ToLower(u.Scheme)]
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("%s://%s:%d", strings.ToLower(u.Scheme), host, n), true
}

func (f *Fetcher) allowed(binding any, origin string) (bool, error) {
	if f.options.Origins == nil {
		return false, nil
	}
	o := f.options.Origins(binding)
	if o.Any {
		return true, nil
	}
	for _, given := range o.List {
		_, rest, found := strings.Cut(given, "://")
		if !found || strings.ContainsAny(rest, "/?#") {
			return false, fmt.Errorf("not an origin: %s", given)
		}
		normal, ok := Origin(given)
		if !ok {
			return false, fmt.Errorf("not an origin: %s", given)
		}
		if normal == origin {
			return true, nil
		}
	}
	return false, nil
}

func (f *Fetcher) tooLarge(c *talk.Call, field string, limit int64) {
	name, _ := talk.Text(field)
	data, _ := talk.Map(talk.KV("field", name), talk.KV("limit", talk.Int(limit)))
	c.Fail(&talk.ScriptError{Code: "response too large", Message: fmt.Sprintf("The response's %s pass %d bytes", field, limit), Data: data})
}

// Fetch checks the origin and starts the request; the Call is answered once
// the whole response has arrived.
func (f *Fetcher) Fetch(c *talk.Call, target string, request talk.Value) error {
	origin, ok := Origin(target)
	allowed := false
	if ok {
		var err error
		if allowed, err = f.allowed(c.Binding(), origin); err != nil {
			f.options.Log(fmt.Sprintf("fetch %s: %v", target, err))
		}
	}
	if !allowed {
		c.Fail(scriptError("bad address", origin+" isn't allowed"))
		return nil
	}
	method, _ := request.Get("method").AsText()
	header := http.Header{}
	named := map[string]bool{}
	for _, p := range request.Get("headers").Entries() {
		named[strings.ToLower(p.Key)] = true
		if s, ok := p.Val.AsText(); ok {
			header[p.Key] = append(header[p.Key], s)
			continue
		}
		for i := 1; i <= p.Val.Len(); i++ {
			s, _ := p.Val.Index(i).AsText()
			header[p.Key] = append(header[p.Key], s)
		}
	}
	var body []byte
	if s, ok := request.Get("body").AsText(); ok {
		body = []byte(s)
		if !named["content-type"] {
			header["content-type"] = []string{"text/plain; charset=utf-8"}
		}
	} else if b, ok := request.Get("body").AsBytes(); ok {
		body = b
	} else if s, ok := request.Get("json").AsText(); ok {
		body = []byte(s)
		if !named["content-type"] {
			header["content-type"] = []string{"application/json"}
		}
	}
	// net/http would add its own user-agent; an empty one sends none.
	if !named["user-agent"] {
		header["User-Agent"] = []string{""}
	}
	if !named["accept-encoding"] {
		header["accept-encoding"] = []string{"identity"}
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(c.Context(), method, target, reader)
	if err != nil {
		f.networkError(c, target, err)
		return nil
	}
	req.Header = header
	go f.do(c, target, req)
	return nil
}

func (f *Fetcher) networkError(c *talk.Call, target string, err error) {
	if c.Context().Err() != nil {
		return // abandoned: nobody waits for the answer
	}
	f.options.Log(fmt.Sprintf("fetch %s: %v", target, err))
	c.Fail(scriptError("network error", err.Error()))
}

func headerBytes(h http.Header) int64 {
	n := int64(0)
	for k, vs := range h {
		for _, v := range vs {
			n += int64(len(k) + len(v) + 4)
		}
	}
	return n
}

func (f *Fetcher) do(c *talk.Call, target string, req *http.Request) {
	res, err := f.client.Do(req)
	if err != nil {
		if strings.Contains(err.Error(), "response headers exceeded") {
			f.tooLarge(c, "headers", f.options.MaxHeaderBytes)
			return
		}
		f.networkError(c, target, err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 599 {
		f.networkError(c, target, fmt.Errorf("status %d", res.StatusCode))
		return
	}
	seen := headerBytes(res.Header)
	if seen > f.options.MaxHeaderBytes {
		f.tooLarge(c, "headers", f.options.MaxHeaderBytes)
		return
	}
	content, err := io.ReadAll(io.LimitReader(res.Body, f.options.MaxBodyBytes+1))
	if err != nil {
		f.networkError(c, target, err)
		return
	}
	if int64(len(content)) > f.options.MaxBodyBytes {
		f.tooLarge(c, "body", f.options.MaxBodyBytes)
		return
	}
	if seen+headerBytes(res.Trailer) > f.options.MaxHeaderBytes {
		f.tooLarge(c, "headers", f.options.MaxHeaderBytes)
		return
	}
	answer, err := fetchAnswer(res.StatusCode, res.Header, content)
	if err != nil {
		f.networkError(c, target, err)
		return
	}
	if c.Context().Err() == nil {
		c.Answer(answer)
	}
}

// fetchAnswer is chapter 7's response: lowercase header names in code point
// order, repeated values joined with ", ", and set-cookie a list.
func fetchAnswer(status int, header http.Header, body []byte) (talk.Value, error) {
	joined := map[string][]string{}
	for k, vs := range header {
		name := strings.ToLower(k)
		joined[name] = append(joined[name], vs...)
	}
	names := make([]string, 0, len(joined))
	for k := range joined {
		names = append(names, k)
	}
	slices.Sort(names)
	pairs := make([]talk.Pair, 0, len(names))
	for _, k := range names {
		var v talk.Value
		if k == "set-cookie" {
			items := make([]talk.Value, 0, len(joined[k]))
			for _, s := range joined[k] {
				t, err := talk.Text(s)
				if err != nil {
					return talk.Nothing, err
				}
				items = append(items, t)
			}
			v = talk.List(items...)
		} else {
			t, err := talk.Text(strings.Join(joined[k], ", "))
			if err != nil {
				return talk.Nothing, err
			}
			v = t
		}
		pairs = append(pairs, talk.KV(k, v))
	}
	headers, err := talk.Map(pairs...)
	if err != nil {
		return talk.Nothing, err
	}
	return talk.Map(talk.KV("status", talk.Int(int64(status))), talk.KV("headers", headers), talk.KV("body", talk.Bytes(body)))
}
