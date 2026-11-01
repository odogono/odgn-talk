package northtalk

import (
	"fmt"
	"strconv"
	"strings"
)

// The embedded Zig Core checks fetch's arguments by chapter 7's profile
// before Start runs (ADR 0151). These give the Host what that check
// accepted: the normalized URL, with `query` added, and the request without
// `query`.

// fetchURL normalizes a URL the Core accepted: lowercase scheme and host, no
// default port, `/` for an empty path, no fragment, and `query` added.
func fetchURL(raw string, request Value) (string, error) {
	scheme, rest, ok := strings.Cut(raw, "://")
	scheme = strings.ToLower(scheme)
	if !ok || (scheme != "http" && scheme != "https") {
		return "", &HostError{InvalidValue, "not a fetch URL: " + raw}
	}
	rest, _, _ = strings.Cut(rest, "#")
	end := strings.IndexAny(rest, "/?")
	if end < 0 {
		end = len(rest)
	}
	authority, rest := rest[:end], rest[end:]
	host, port := authority, ""
	if close := strings.LastIndexByte(authority, ']'); close >= 0 {
		host, port = authority[:close+1], strings.TrimPrefix(authority[close+1:], ":")
	} else if colon := strings.IndexByte(authority, ':'); colon >= 0 {
		host, port = authority[:colon], authority[colon+1:]
	}
	var b strings.Builder
	b.WriteString(scheme + "://" + strings.ToLower(host))
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil {
			return "", &HostError{InvalidValue, "not a fetch URL: " + raw}
		}
		if !(scheme == "http" && n == 80) && !(scheme == "https" && n == 443) {
			fmt.Fprintf(&b, ":%d", n)
		}
	}
	path, query, hasQuery := strings.Cut(rest, "?")
	if path == "" {
		path = "/"
	}
	b.WriteString(path)
	if hasQuery {
		b.WriteString("?" + query)
		return b.String(), nil
	}
	first := true
	for _, p := range request.Get("query").Entries() {
		values := []Value{p.Val}
		if p.Val.Kind() == KindList {
			values = values[:0]
			for i := 1; i <= p.Val.Len(); i++ {
				values = append(values, p.Val.Index(i))
			}
		}
		for _, v := range values {
			s, _ := v.AsText()
			if first {
				b.WriteByte('?')
				first = false
			} else {
				b.WriteByte('&')
			}
			b.WriteString(percentEncode(p.Key) + "=" + percentEncode(s))
		}
	}
	return b.String(), nil
}

// percentEncode writes every UTF-8 byte but RFC 3986's unreserved
// characters as `%` and two uppercase hexadecimal digits.
func percentEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// fetchRequest is the request the Host hears: `method` always, `headers`
// and `body` as given, and `json` as its compact JSON text.
func fetchRequest(request Value) (Value, error) {
	method := request.Get("method")
	if method.Kind() != KindText {
		method, _ = Text("GET")
	}
	pairs := []Pair{{"method", method}}
	if h := request.Get("headers"); h.Kind() == KindMap {
		pairs = append(pairs, Pair{"headers", h})
	}
	if body := request.Get("body"); body.Kind() != KindNothing {
		pairs = append(pairs, Pair{"body", body})
	}
	if request.Kind() == KindMap {
		for _, p := range request.Entries() {
			if p.Key != "json" {
				continue
			}
			written, err := EncodeJSON(p.Val)
			if err != nil {
				return Nothing, err
			}
			text, err := Text(string(written))
			if err != nil {
				return Nothing, err
			}
			pairs = append(pairs, Pair{"json", text})
		}
	}
	return Map(pairs...)
}
