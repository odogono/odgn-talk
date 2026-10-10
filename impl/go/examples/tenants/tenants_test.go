package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The committed Trace Cases are what the Host records: rerecord with
// `go -C impl/go run ./examples/tenants record` after changing the Host.
func TestRecordedCasesMatchCorpus(t *testing.T) {
	dir := t.TempDir()
	if err := record(dir); err != nil {
		t.Fatal(err)
	}
	for _, d := range demoTenants {
		name := "tenants-" + d.name
		for _, file := range []string{"case.toml", "case.trace", "shop.talk"} {
			got, err := os.ReadFile(filepath.Join(dir, name, file))
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "corpus", "examples", name, file))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Errorf("%s/%s differs from the recording; rerecord it", name, file)
			}
		}
	}
}

func TestServer(t *testing.T) {
	h, err := NewHost(HostOptions{FuelSlice: 10000})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, d := range demoTenants {
		if _, err := h.AddTenant(d.name, d.plan, d.catalog, d.sender, script("shop.talk")); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(h.handler())
	defer server.Close()
	call := func(method, path, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out, _ := io.ReadAll(res.Body)
		return res.StatusCode, strings.TrimSpace(string(out))
	}
	order := `{"sku": "A1", "qty": 4, "to": ["ops@example.com"]}`
	if code, body := call("POST", "/tenants/acme/orders", order); code != 200 || body != `{"amount":"10.00","unit":"GBP"}` {
		t.Fatal(code, body)
	}
	if code, body := call("POST", "/tenants/globex/orders", order); code != 200 || body != `{"amount":"12.00","unit":"GBP"}` {
		t.Fatal(code, body)
	}
	if code, _ := call("POST", "/tenants/initech/orders", order); code != 404 {
		t.Fatal(code)
	}
	// A free plan Run can't cover twenty recipients.
	many := `{"sku": "A1", "qty": 1, "to": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20"]}`
	if code, body := call("POST", "/tenants/globex/orders", many); code != 422 || !strings.Contains(body, "limit fault") {
		t.Fatal(code, body)
	}
	if code, _ := call("POST", "/admin/tenants/globex/revoke/mail", ""); code != 202 {
		t.Fatal(code)
	}
	if code, body := call("POST", "/tenants/globex/orders", order); code != 200 || body != `{"amount":"12.00","unit":"GBP"}` {
		t.Fatal(code, body)
	}
	if code, body := call("PUT", "/admin/tenants/globex/script", script("shop-v2.talk")); code != 422 || !strings.Contains(body, "unknown operation") {
		t.Fatal(code, body)
	}
	if code, _ := call("PUT", "/admin/tenants/globex/script", script("shop-quiet.talk")); code != 204 {
		t.Fatal(code)
	}
	if code, _ := call("PUT", "/admin/tenants/acme/script", script("shop-v2.talk")); code != 204 {
		t.Fatal(code)
	}
	if code, body := call("POST", "/tenants/acme/orders", `{"sku": "B2", "qty": 10, "to": ["ops@example.com"]}`); code != 200 || body != `{"amount":"108.000","unit":"GBP"}` {
		t.Fatal(code, body)
	}
	var outbox []Mail
	_, body := call("GET", "/tenants/globex/outbox", "")
	if err := json.Unmarshal([]byte(body), &outbox); err != nil || len(outbox) != 1 || outbox[0].From != "shop@globex.example" {
		t.Fatal(body)
	}
	_, body = call("GET", "/tenants/acme/outbox", "")
	if err := json.Unmarshal([]byte(body), &outbox); err != nil || len(outbox) != 2 || outbox[1].Text != "order B2 x10: 108.000 GBP" || strings.Join(outbox[1].To, ",") != "ops@example.com" {
		t.Fatal(body)
	}
	var usage struct {
		Plan   string
		Runs   int64
		Faults int64
		Fuel   int64
	}
	_, body = call("GET", "/tenants/globex/usage", "")
	if err := json.Unmarshal([]byte(body), &usage); err != nil || usage.Plan != "free" || usage.Runs != 3 || usage.Faults != 1 || usage.Fuel == 0 {
		t.Fatal(body)
	}
}
