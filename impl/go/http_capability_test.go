package northtalk

import (
	"context"
	"reflect"
	"testing"
	"time"
)

type httpHost struct {
	calls []*Call
	heard [][]any
}

func (h *httpHost) Serve(c *Call, name, prefix, message string, options Value) error {
	h.calls = append(h.calls, c)
	h.heard = append(h.heard, []any{"serve", name, prefix, message, options.String()})
	return nil
}
func (h *httpHost) Unserve(_ *Call, name string) error {
	h.heard = append(h.heard, []any{"unserve", name})
	return nil
}
func (h *httpHost) Respond(_ *Call, exchange *Object, response Value) error {
	json, _ := response.Get("json").AsText()
	h.heard = append(h.heard, []any{"respond", exchange.ID(), json})
	return nil
}

var httpCosts = Costs{"serve": {Fuel: 5}, "unserve": {Fuel: 2}, "respond": {Fuel: 3}}

func TestHTTPFactoryRefusesMissingCostsAndImplementation(t *testing.T) {
	core := New()
	for name := range httpCosts {
		costs := Costs{}
		for k, v := range httpCosts {
			if k != name {
				costs[k] = v
			}
		}
		if _, err := core.HTTPCapability(&httpHost{}, costs); err == nil {
			t.Fatalf("missing %s cost accepted", name)
		}
	}
	if _, err := core.HTTPCapability(nil, httpCosts); err == nil {
		t.Fatal("nil implementation accepted")
	}
}

// Serve hears the effective message and an empty options map, Respond hears
// json as its JSON text, and the Core refuses an invalid serve and response
// before the Host runs.
func TestHTTPFactoryResolvesArgumentsAndChecks(t *testing.T) {
	core := New()
	host := &httpHost{}
	def, err := core.HTTPCapability(host, httpCosts)
	if err != nil {
		t.Fatal(err)
	}
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "httpExchange"})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	exchange, err := g.Object(kind, "e1", nil)
	if err != nil {
		t.Fatal(err)
	}
	source := "script variable got = []\non go x\n" +
		" try\n  ask http to serve \"\", \"/\" and wait\n catch {code: code, field: f}\n  put [code, f] after got\n end try\n" +
		" try\n  ask http to respond x, {status: 600}\n catch {code: code, field: f}\n  put [code, f] after got\n end try\n" +
		" ask http to respond x, {json: {id: 7}}\n" +
		" ask http to serve \"site\", \"/\" and wait\n return the port of it\nend go\n"
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"http": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go", Args: []Value{exchange.Value()}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(host.calls) != 1 {
		t.Fatalf("serve calls = %d", len(host.calls))
	}
	hostText, _ := Text("127.0.0.1")
	address, _ := Map(KV("host", hostText), KV("port", Int(8080)))
	host.calls[0].Answer(address)
	if _, err := g.Pump(now.Add(time.Millisecond), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	value, failure := p.Result()
	if failure != nil || value.String() != "8080" {
		t.Fatalf("result %v %v", value, failure)
	}
	want := [][]any{{"respond", "e1", `{"id":7}`}, {"serve", "site", "/", "httpRequest", "{}"}}
	if !reflect.DeepEqual(host.heard, want) {
		t.Fatalf("heard %#v", host.heard)
	}
}

type fetchHost struct{ heard []string }

func (h *fetchHost) Fetch(c *Call, url string, request Value) error {
	h.heard = append(h.heard, url, request.String())
	c.Fail(&ScriptError{Code: "network error", Message: "offline"})
	return nil
}

// A Host may offer fetch alone, the server Operations alone, or both; fetch
// hears the normalized URL with query added and the request without it, and
// the Core refuses an invalid request before the Host runs.
func TestHTTPFactoryOffersFetch(t *testing.T) {
	core := New()
	host := &fetchHost{}
	if _, err := core.HTTPCapabilityWith(nil, nil, Costs{}); err == nil {
		t.Fatal("no Operations accepted")
	}
	if _, err := core.HTTPCapabilityWith(nil, host, Costs{}); err == nil {
		t.Fatal("missing fetch cost accepted")
	}
	def, err := core.HTTPCapabilityWith(nil, host, Costs{"fetch": {Fuel: 4}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	source := "script variable got = []\non go\n" +
		" try\n  ask http to fetch \"HTTPS://API.Example.com:443/users#top\", {method: \"POST\", query: {email: \"ann@example.com\", tag: [\"a b\", \"ü\"]}, json: {n: 1}} and wait\n catch {code: code}\n  put code after got\n end try\n" +
		" try\n  ask http to fetch \"https://127.1/\" and wait\n catch {code: code, field: f}\n  put [code, f] after got\n end try\n" +
		" return got\nend go\n"
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"http": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "t", Source: "on go\n ask http to unserve \"x\"\nend go\n", Grants: map[string]*Grant{"http": def.GrantAll(nil)}}); err == nil {
		t.Fatal("a fetch-only http declared unserve")
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for i := range 3 {
		if _, err := g.Pump(now.Add(time.Duration(i)*time.Millisecond), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	value, failure := p.Result()
	if failure != nil || value.String() != `["network error", ["invalid request", "url"]]` {
		t.Fatalf("result %v %v", value, failure)
	}
	want := []string{"https://api.example.com/users?email=ann%40example.com&tag=a%20b&tag=%C3%BC", `{method: "POST", json: "{" & quote & "n" & quote & ":1}"}`}
	if !reflect.DeepEqual(host.heard, want) {
		t.Fatalf("heard %#v", host.heard)
	}
}
