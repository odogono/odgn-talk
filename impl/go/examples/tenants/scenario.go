package main

import (
	"context"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
)

//go:embed scripts/*.talk
var scripts embed.FS

func script(name string) string {
	b, err := scripts.ReadFile("scripts/" + name)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// The two demonstration tenants, on different plans and with their own
// price lists and sender addresses.
var demoTenants = []struct {
	name, plan, sender string
	catalog            Catalog
}{
	{"acme", "pro", "orders@acme.example", Catalog{"A1": "2.50", "B2": "12.00"}},
	{"globex", "free", "shop@globex.example", Catalog{"A1": "3.00", "C3": "0.75"}},
}

var scenarioStart = time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)

// step is one round: an action for each tenant that has one. The tenants'
// Groups run their actions in parallel on the Pool, and the round ends when
// every Group has settled, so each Group's Pumps fall in the same places on
// every run and its Trace is reproducible.
type step struct {
	advance time.Duration // moves the Clock first, firing due timers
	acme    action
	globex  action
}

type action struct {
	note string // written into the Trace as a comment
	do   func(h *Host, t *Tenant) error
}

func order(sku string, qty int64, to ...string) func(*Host, *Tenant) error {
	return func(h *Host, t *Tenant) error {
		recipients := make([]talk.Value, len(to))
		for i, r := range to {
			recipients[i] = mustText(r)
		}
		o := mustMap(talk.KV("sku", mustText(sku)), talk.KV("qty", talk.Int(qty)), talk.KV("to", talk.List(recipients...)))
		_, err := h.Order(context.Background(), t, o)
		if _, ok := err.(*talk.ScriptError); ok {
			return nil // a failed Run is part of the scenario
		}
		return err
	}
}

func many(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("staff%d@globex.example", i+1)
	}
	return out
}

var scenario = []step{
	{
		acme:   action{"An order is priced from acme's own catalog binding, and `notify` Charges 50 Fuel for its one recipient.", order("A1", 4, "ops@acme.example")},
		globex: action{"The same Script prices from globex's catalog binding.", order("C3", 10, "ops@globex.example")},
	},
	{
		acme:   action{"The catalog fails `unknown sku`, which the Script catches.", order("Z9", 1, "ops@acme.example")},
		globex: action{"Twenty recipients: `notify` Charges 1000 Fuel, which a free plan Run can't cover after what it has spent, so the Run has a Limit Fault at the call. Nothing is sent, and the order's Script Variable changes roll back.", order("A1", 1, many(20)...)},
	},
	{
		acme: action{"A reminder waits 10 minutes on the Group's Clock.", func(h *Host, t *Tenant) error {
			return h.Remind(t, []string{"ops@acme.example"}, "restock B2")
		}},
		globex: action{"The plan lapses: the Host revokes globex's `mail` Grant.", func(h *Host, t *Tenant) error { h.Revoke(t, "mail"); return nil }},
	},
	{
		advance: 10 * time.Minute,
		acme:    action{"The Pool's timer for acme's Group fires at the deadline, and the reminder is sent.", nil},
		globex:  action{"`notify` now raises `capability revoked`; the order still completes.", order("A1", 2, "ops@globex.example")},
	},
	{
		acme: action{"acme uploads new code, which keeps its Script Variables.", func(h *Host, t *Tenant) error {
			return h.Reload(t, script("shop-v2.talk"))
		}},
		globex: action{"A Reload that still calls `mail` is refused: the revoked Grant is gone after a Reload.", func(h *Host, t *Tenant) error {
			if err := h.Reload(t, script("shop-v2.talk")); err == nil {
				return fmt.Errorf("globex reload unexpectedly accepted")
			}
			return nil
		}},
	},
	{
		acme: action{"The new code takes 10% off ten or more.", order("B2", 10, "ops@acme.example", "buyer@acme.example")},
		globex: action{"Code without `mail` reloads, and the revoked Grant is removed.", func(h *Host, t *Tenant) error {
			return h.Reload(t, script("shop-quiet.talk"))
		}},
	},
	{
		globex: action{"Orders keep working without mail.", order("A1", 1, "ops@globex.example")},
	},
}

// runScenario plays the scenario on a Host with a manual Clock, then reads
// each tenant's counters and Script Variables, which end its Trace.
func runScenario(h *Host, clock *driver.ManualClock) (map[string]*Tenant, error) {
	tenants := map[string]*Tenant{}
	for _, d := range demoTenants {
		t, err := h.AddTenant(d.name, d.plan, d.catalog, d.sender, script("shop.talk"))
		if err != nil {
			return nil, err
		}
		tenants[d.name] = t
	}
	for i, s := range scenario {
		advance := s.advance
		if i > 0 && advance == 0 {
			advance = time.Second
		}
		for _, name := range []string{"acme", "globex"} {
			a := s.acme
			if name == "globex" {
				a = s.globex
			}
			if a.note != "" && tenants[name].recorder != nil {
				tenants[name].recorder.comment(a.note)
			}
		}
		clock.Advance(advance)
		errs := make(chan error, 2)
		for name, a := range map[string]action{"acme": s.acme, "globex": s.globex} {
			go func() {
				if a.do == nil {
					errs <- nil
					return
				}
				if err := a.do(h, tenants[name]); err != nil {
					errs <- fmt.Errorf("step %d, %s: %w", i+1, name, err)
					return
				}
				errs <- nil
			}()
		}
		for range 2 {
			if err := <-errs; err != nil {
				return nil, err
			}
		}
		h.Wait()
	}
	for _, t := range tenants {
		if t.recorder != nil {
			t.recorder.comment("The Host bills from the Script's lifetime counters, and the case ends by inspecting the Group.")
		}
		h.Usage(t)
		h.Vars(t)
	}
	return tenants, nil
}

// caseFiles renders a tenant's Trace Case: case.toml, the Script it loads
// and case.trace.
func caseFiles(t *Tenant) map[string]string {
	header := fmt.Sprintf("# Unblessed: the multi-tenant Example Host's %s tenant (#143); first blessing awaits human review.\n", t.Name)
	header += fmt.Sprintf("# tenants-%s: the %s tenant of the multi-tenant Go Example Host\n", t.Name, t.Name)
	header += "# (impl/go/examples/tenants), recorded by `go run ./examples/tenants record`.\n"
	header += "# The Host recorded the `stub` lines from what its Host functions did.\n"
	header += "# Its Fuel, allocation and state figures are Cost Model 0's.\n\n"
	toml := fmt.Sprintf(`# tenants-%[1]s: the %[1]s tenant of the multi-tenant Go Example Host
# (impl/go/examples/tenants, spec Appendix B milestone 2). Its Group is one
# of several the Host pumps in parallel through the driver Pool. Grant
# bindings (the tenant's price list and sender address) never appear here.

kind = "trace"

[versions]
language = "1.0-rc.2"
costModel = "0"

[[operations]]
capability = "catalog"
name = "lookUp"
mode = "immediate"
args = ["text"]
result = { quantity = "GBP" }
cost = { fuel = 30 }
errors = [{ code = "unknown sku", fields = [{ key = "sku", shape = "text" }] }]

[[operations]]
capability = "mail"
name = "notify"
mode = "fire-and-forget"
args = [{ list = "text" }, "text"]
cost = { fuel = 20 }

# The %[2]s plan's limits.
[[scripts]]
name = "shop"
source = "shop.talk"
grants = { catalog = { ops = ["lookUp"] }, mail = { ops = ["notify"] } }
limits = { fuelPerRun = %[3]d, mailboxDepth = %[4]d }
`, t.Name, t.Plan.Name, t.Plan.Limits.FuelPerRun, t.Plan.Limits.MailboxDepth)
	return map[string]string{
		"case.toml":  toml,
		"shop.talk":  script("shop.talk"),
		"case.trace": header + strings.Join(t.recorder.trace(), "\n") + "\n",
	}
}

// record runs the scenario and writes each tenant's case under dir.
func record(dir string) error {
	clock := driver.NewManualClock(scenarioStart)
	h, err := NewHost(HostOptions{Workers: 2, Clock: clock, Record: true})
	if err != nil {
		return err
	}
	defer h.Close()
	tenants, err := runScenario(h, clock)
	if err != nil {
		return err
	}
	for name, t := range tenants {
		caseDir := filepath.Join(dir, "tenants-"+name)
		if err := os.MkdirAll(caseDir, 0o755); err != nil {
			return err
		}
		for file, text := range caseFiles(t) {
			if err := os.WriteFile(filepath.Join(caseDir, file), []byte(text), 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}
