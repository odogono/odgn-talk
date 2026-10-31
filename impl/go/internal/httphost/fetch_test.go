package httphost

// fetch's Host side against local HTTP servers and the shared self-signed
// TLS fixtures in impl/ts/tests/fixtures/http-tls (chapter 7, Fetching; ADR
// 0151), as impl/ts/tests/http-fetch-host.test.ts does for the TS Host.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	talk "northtalk.org/go"
	"northtalk.org/go/driver"
)

const tlsFixtures = "../../../ts/tests/fixtures/http-tls"

const fetchScript = `on get url, request
  try
    ask http to fetch url, request and wait
    return it
  catch e
    return e
  end try
end get

on bounded url
  try
    with timeout of 200 ms
      ask http to fetch url and wait
    end timeout
    return it
  catch e
    return e
  end try
end bounded
`

type fetchHarness struct {
	t      *testing.T
	script *talk.Script
}

func newFetchHarness(t *testing.T, o FetchOptions) *fetchHarness {
	t.Helper()
	core := talk.New()
	f, err := NewFetcher(o)
	if err != nil {
		t.Fatal(err)
	}
	capability, err := core.HTTPCapabilityWith(nil, f, talk.Costs{"fetch": {Fuel: 4}})
	if err != nil {
		t.Fatal(err)
	}
	pool := driver.NewPool(driver.PoolOptions{Workers: 2})
	t.Cleanup(pool.Close)
	member := pool.NewGroup(core, talk.GroupOptions{Name: "fetch"})
	var script *talk.Script
	if err := member.Do(func(g *talk.Group) error {
		script, err = g.Load(talk.LoadOptions{Name: "main", Source: fetchScript, Grants: map[string]*talk.Grant{"http": capability.GrantAll(nil)}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return &fetchHarness{t, script}
}

func (h *fetchHarness) call(name string, args ...talk.Value) talk.Value {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, p, err := h.script.Request(ctx, talk.Message{Name: name, Args: args})
	if err != nil {
		h.t.Fatal(err)
	}
	v, err := await(ctx, p)
	if err != nil {
		h.t.Fatal(err)
	}
	return v
}

func (h *fetchHarness) get(url string, request talk.Value) talk.Value {
	h.t.Helper()
	return h.call("get", text(h.t, url), request)
}

func text(t *testing.T, s string) talk.Value {
	t.Helper()
	v, err := talk.Text(s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func value(t *testing.T, pairs ...talk.Pair) talk.Value {
	t.Helper()
	v, err := talk.Map(pairs...)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func anyOrigin(any) Origins { return Origins{Any: true} }

func expectCode(t *testing.T, got talk.Value, code string) {
	t.Helper()
	if c, _ := got.Get("code").AsText(); c != code {
		t.Fatalf("got %s, wanted %s", got, code)
	}
}

func TestFetchSendsTheRequestAndGivesTheResponse(t *testing.T) {
	var seen *http.Request
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		body, _ = io.ReadAll(r.Body)
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		w.Header().Add("X-B", "1")
		w.Header().Add("X-A", "2")
		w.Header().Add("X-A", "3")
		w.WriteHeader(201)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	h := newFetchHarness(t, FetchOptions{Origins: func(any) Origins { return Origins{List: []string{server.URL}} }})
	request := value(t,
		talk.KV("method", text(t, "POST")),
		talk.KV("headers", value(t, talk.KV("X-Token", text(t, "t")))),
		talk.KV("query", value(t, talk.KV("q", text(t, "a b")))),
		talk.KV("json", value(t, talk.KV("n", talk.Int(1)))),
	)
	got := h.get(server.URL+"/echo#frag", request)
	names := []string{}
	for _, p := range got.Get("headers").Entries() {
		names = append(names, p.Key)
	}
	if got.Get("status").String() != "201" || strings.Join(names, " ") != "content-length content-type date set-cookie x-a x-b" {
		t.Fatalf("got %s", got)
	}
	if s := got.Get("headers").Get("set-cookie").String(); s != `["a=1", "b=2"]` {
		t.Fatalf("set-cookie %s", s)
	}
	if s := got.Get("headers").Get("x-a").String(); s != `"2, 3"` {
		t.Fatalf("x-a %s", s)
	}
	if b, _ := got.Get("body").AsBytes(); string(b) != "ok" {
		t.Fatalf("body %s", got.Get("body"))
	}
	if seen.Method != "POST" || seen.URL.RequestURI() != "/echo?q=a%20b" || string(body) != `{"n":1}` {
		t.Fatalf("server saw %s %s %q", seen.Method, seen.URL.RequestURI(), body)
	}
	for k, v := range map[string]string{"Content-Type": "application/json", "Accept-Encoding": "identity", "X-Token": "t", "User-Agent": "", "Cookie": ""} {
		if got := seen.Header.Get(k); got != v {
			t.Fatalf("server saw %s %q, wanted %q", k, got, v)
		}
	}
}

func TestFetchRefusesOriginsTheBindingDoesNotAllow(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request was made")
	}))
	defer server.Close()
	none := newFetchHarness(t, FetchOptions{})
	expectCode(t, none.get(server.URL, talk.Nothing), "bad address")
	other := newFetchHarness(t, FetchOptions{Origins: func(any) Origins { return Origins{List: []string{"https://example.com"}} }})
	expectCode(t, other.get(server.URL, talk.Nothing), "bad address")
}

func TestFetchFollowsNothingAndDecompressesNothing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/moved" {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte{0x1f, 0x8b, 0x01})
	}))
	defer server.Close()
	h := newFetchHarness(t, FetchOptions{Origins: anyOrigin})
	got := h.get(server.URL+"/moved", talk.Nothing)
	if s, _ := got.Get("headers").Get("location").AsText(); got.Get("status").String() != "302" || s != "/elsewhere" {
		t.Fatalf("got %s", got)
	}
	got = h.get(server.URL+"/zipped", talk.Nothing)
	if b, _ := got.Get("body").AsBytes(); string(b) != "\x1f\x8b\x01" {
		t.Fatalf("got %s", got)
	}
}

func TestFetchBoundsTheResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Long", strings.Repeat("x", 200))
		_, _ = w.Write([]byte("12345"))
	}))
	defer server.Close()
	body := newFetchHarness(t, FetchOptions{Origins: anyOrigin, MaxBodyBytes: 4})
	got := body.get(server.URL, talk.Nothing)
	expectCode(t, got, "response too large")
	if got.Get("field").String() != `"body"` || got.Get("limit").String() != "4" {
		t.Fatalf("got %s", got)
	}
	headers := newFetchHarness(t, FetchOptions{Origins: anyOrigin, MaxHeaderBytes: 100})
	got = headers.get(server.URL, talk.Nothing)
	expectCode(t, got, "response too large")
	if got.Get("field").String() != `"headers"` {
		t.Fatalf("got %s", got)
	}
}

func TestFetchFailsWithoutAResponse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	h := newFetchHarness(t, FetchOptions{Origins: anyOrigin})
	expectCode(t, h.get("http://"+address+"/", talk.Nothing), "network error")
}

func TestFetchAbortsAnAbandonedRequest(t *testing.T) {
	gone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		close(gone)
	}))
	defer server.Close()
	h := newFetchHarness(t, FetchOptions{Origins: anyOrigin})
	expectCode(t, h.call("bounded", text(t, server.URL)), "timeout")
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the request wasn't aborted")
	}
}

func tlsServer(t *testing.T, name string) *httptest.Server {
	t.Helper()
	cert, err := tls.LoadX509KeyPair(filepath.Join(tlsFixtures, name+".crt"), filepath.Join(tlsFixtures, name+".key"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("secure"))
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func TestFetchVerifiesCertificatesAndHostNames(t *testing.T) {
	roots := x509.NewCertPool()
	for _, name := range []string{"local", "other"} {
		pem, err := os.ReadFile(filepath.Join(tlsFixtures, name+".crt"))
		if err != nil {
			t.Fatal(err)
		}
		roots.AppendCertsFromPEM(pem)
	}
	trusted := newFetchHarness(t, FetchOptions{Origins: anyOrigin, RootCAs: roots})
	got := trusted.get(tlsServer(t, "local").URL, talk.Nothing)
	if b, _ := got.Get("body").AsBytes(); string(b) != "secure" {
		t.Fatalf("got %s", got)
	}
	// other.example's certificate doesn't name 127.0.0.1.
	expectCode(t, trusted.get(tlsServer(t, "other").URL, talk.Nothing), "network error")
	// Without the fixtures, the system's authorities don't trust either.
	system := newFetchHarness(t, FetchOptions{Origins: anyOrigin})
	expectCode(t, system.get(tlsServer(t, "local").URL, talk.Nothing), "network error")
}
