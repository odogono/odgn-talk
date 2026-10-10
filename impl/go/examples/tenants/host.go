package main

import (
	"context"
	"errors"
	"fmt"
	"sync"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
)

// A Plan sets the limits each of its tenants' Scripts loads with.
type Plan struct {
	Name   string
	Limits talk.Limits
}

var plans = map[string]Plan{
	"free": {Name: "free", Limits: talk.Limits{FuelPerRun: 1000, MailboxDepth: 8}},
	"pro":  {Name: "pro", Limits: talk.Limits{FuelPerRun: 50000, MailboxDepth: 64}},
}

// perRecipient is the Fuel `notify` draws with Charge for each recipient,
// before it sends anything.
const perRecipient = 50

// A Catalog is a tenant's price list, in GBP. It is the binding of the
// tenant's `catalog` Grant, so one Capability serves every tenant.
type Catalog map[string]string

// Mail is one sent notification.
type Mail struct {
	From string   `json:"from"`
	To   []string `json:"to"`
	Text string   `json:"text"`
}

// Tenant is one customer: one Group, holding one `shop` Script.
type Tenant struct {
	Name     string
	Plan     Plan
	Sender   string // the binding of the tenant's `mail` Grant
	member   *driver.Member
	script   *talk.Script
	recorder *recorder // nil unless the Host records Traces
}

// HostOptions configures a Host.
type HostOptions struct {
	Workers   int
	Clock     driver.Clock // nil: the wall clock
	FuelSlice int64        // per Script, per Pump
	Record    bool         // keep each tenant's Trace, with Stubs, as a Trace Case
	OnRunEnd  func(tenant string, end *talk.RunEnd)
}

// Host is the multi-tenant server: one Core, one driver Pool, and a Group per
// tenant, pumped in parallel.
type Host struct {
	options HostOptions
	core    *talk.Core
	pool    *driver.Pool
	catalog *talk.CapabilityDef
	mail    *talk.CapabilityDef

	mu       sync.Mutex
	tenants  map[string]*Tenant
	byGroup  map[*talk.Group]*Tenant
	outboxes map[string][]Mail
}

// NewHost defines the Capabilities once and starts the Pool.
func NewHost(o HostOptions) (*Host, error) {
	h := &Host{options: o, core: talk.New(), tenants: map[string]*Tenant{}, byGroup: map[*talk.Group]*Tenant{}, outboxes: map[string][]Mail{}}
	var err error
	if h.catalog, err = h.core.DefineCapability("catalog", h.lookUpOperation()); err != nil {
		return nil, err
	}
	if h.mail, err = h.core.DefineCapability("mail", h.notifyOperation()); err != nil {
		return nil, err
	}
	h.pool = driver.NewPool(driver.PoolOptions{Workers: o.Workers, Clock: o.Clock, Pump: talk.PumpOptions{FuelSlice: o.FuelSlice}, OnPump: h.pumped})
	return h, nil
}

func (h *Host) lookUpOperation() talk.Operation {
	return talk.Operation{
		Name: "lookUp", Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape}, Result: talk.QuantityOf("GBP"), Cost: talk.Cost{Fuel: 30},
		Errors: []talk.ErrorDecl{{Code: "unknown sku", Fields: []talk.Field{{Key: "sku", Shape: talk.TextShape}}}},
		Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
			sku, _ := args[0].AsText()
			price, ok := c.Binding().(Catalog)[sku]
			if !ok {
				failure := &talk.ScriptError{Code: "unknown sku", Data: mustMap(talk.KV("sku", args[0]))}
				h.stub(c, "catalog.lookUp", talk.Nothing, failure, 0)
				return talk.Nothing, failure
			}
			v, err := gbp(price)
			if err != nil {
				return talk.Nothing, err
			}
			h.stub(c, "catalog.lookUp", v, nil, 0)
			return v, nil
		},
	}
}

func (h *Host) notifyOperation() talk.Operation {
	return talk.Operation{
		Name: "notify", Mode: talk.FireAndForget, Args: []talk.Shape{talk.ListOf(talk.TextShape), talk.TextShape}, Cost: talk.Cost{Fuel: 20},
		Fire: func(c *talk.Call, args []talk.Value) error {
			charge := perRecipient * int64(args[0].Len())
			h.stub(c, "mail.notify", talk.Nothing, nil, charge)
			if err := c.Charge(charge); err != nil {
				return err // the Run faults at the call, and nothing is sent
			}
			m := Mail{From: c.Binding().(string), Text: textOf(args[1])}
			for i := 1; i <= args[0].Len(); i++ { // list items count from 1, as in Scripts
				m.To = append(m.To, textOf(args[0].Index(i)))
			}
			h.mu.Lock()
			h.outboxes[m.From] = append(h.outboxes[m.From], m)
			h.mu.Unlock()
			return nil
		},
	}
}

// AddTenant makes the tenant's Group and loads its Script with the plan's
// limits and Grants bound to the tenant's own data.
func (h *Host) AddTenant(name, plan string, catalog Catalog, sender, source string) (*Tenant, error) {
	p, ok := plans[plan]
	if !ok {
		return nil, fmt.Errorf("unknown plan %q", plan)
	}
	t := &Tenant{Name: name, Plan: p, Sender: sender}
	o := talk.GroupOptions{Name: name}
	if h.options.Record {
		t.recorder = &recorder{}
		o.Trace = t.recorder
	}
	h.mu.Lock()
	if h.tenants[name] != nil {
		h.mu.Unlock()
		return nil, fmt.Errorf("tenant %q exists", name)
	}
	h.tenants[name] = t
	h.mu.Unlock()
	t.member = h.pool.NewGroup(h.core, o)
	h.mu.Lock()
	h.byGroup[t.member.Group()] = t
	h.mu.Unlock()
	lookUp, err := h.catalog.Grant([]string{"lookUp"}, catalog)
	if err != nil {
		return nil, err
	}
	notify, err := h.mail.Grant([]string{"notify"}, sender)
	if err != nil {
		return nil, err
	}
	err = t.member.Do(func(g *talk.Group) error {
		t.script, err = g.Load(talk.LoadOptions{Name: "shop", Source: source, Limits: p.Limits, Grants: map[string]*talk.Grant{"catalog": lookUp, "mail": notify}})
		return err
	})
	if err != nil {
		h.mu.Lock()
		delete(h.tenants, name)
		h.mu.Unlock()
		t.member.Remove()
		return nil, err
	}
	return t, nil
}

// Tenant finds a tenant by name.
func (h *Host) Tenant(name string) (*Tenant, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t, ok := h.tenants[name]
	return t, ok
}

// Order sends `order` to the tenant's Script and waits for its result, as an
// HTTP handler does. The Pool pumps the Group; this goroutine only waits.
func (h *Host) Order(ctx context.Context, t *Tenant, order talk.Value) (talk.Value, error) {
	_, p, err := t.script.Request(ctx, talk.Message{Name: "order", Args: []talk.Value{order}})
	if err != nil {
		return talk.Nothing, err
	}
	select {
	case <-p.Done():
	case <-ctx.Done():
		return talk.Nothing, ctx.Err()
	}
	v, failure := p.Result()
	if failure != nil {
		return talk.Nothing, failure
	}
	return v, nil
}

// Remind delivers `remind`, whose `wait` the Pool's timer for the Group ends.
func (h *Host) Remind(t *Tenant, to []string, note string) error {
	recipients := make([]talk.Value, len(to))
	for i, r := range to {
		recipients[i] = mustText(r)
	}
	_, err := t.script.Deliver(talk.Message{Name: "remind", Args: []talk.Value{talk.List(recipients...), mustText(note)}})
	return err
}

// Revoke withdraws one of the tenant's Grants, as when a plan lapses. It is
// queued, and lands at the Group's next Pump.
func (h *Host) Revoke(t *Tenant, grant string) { t.script.Revoke(grant) }

// Reload replaces the tenant's code, keeping its Script Variables. A revoked
// Grant is gone afterwards, so the new source must not use it.
func (h *Host) Reload(t *Tenant, source string) error {
	return t.member.Do(func(*talk.Group) error {
		reports, err := t.script.Reload(source, talk.CarryVariables)
		h.report(t, reports)
		return err
	})
}

// Usage reads the tenant's lifetime counters, which a Host bills from.
func (h *Host) Usage(t *Tenant) talk.Counters {
	var c talk.Counters
	_ = t.member.Do(func(*talk.Group) error { c = t.script.Counters(); return nil })
	return c
}

// Vars inspects the tenant's Script Variables.
func (h *Host) Vars(t *Tenant) []talk.Pair {
	var vars []talk.Pair
	_ = t.member.Do(func(g *talk.Group) error {
		for _, s := range g.Inspect().Scripts {
			vars = append(vars, s.Vars...)
		}
		return nil
	})
	return vars
}

// Outbox lists the mail sent from a tenant's sender address.
func (h *Host) Outbox(t *Tenant) []Mail {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]Mail{}, h.outboxes[t.Sender]...)
}

// Wait returns once no Group is queued or being pumped.
func (h *Host) Wait() { h.pool.Wait() }

// Close stops the Pool.
func (h *Host) Close() { h.pool.Close() }

func (h *Host) tenantOf(g *talk.Group) *Tenant {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.byGroup[g]
}

func (h *Host) pumped(m *driver.Member, r talk.PumpResult, err error) {
	t := h.tenantOf(m.Group())
	if t == nil {
		return
	}
	if t.recorder != nil {
		t.recorder.pumped()
	}
	h.report(t, r.Reports)
}

func (h *Host) report(t *Tenant, reports []talk.Report) {
	if h.options.OnRunEnd == nil {
		return
	}
	for _, r := range reports {
		if end, ok := r.(*talk.RunEnd); ok {
			h.options.OnRunEnd(t.Name, end)
		}
	}
}

// stub notes what a Host function did, for a recorded Trace Case.
func (h *Host) stub(c *talk.Call, op string, v talk.Value, failure *talk.ScriptError, charge int64) {
	if !h.options.Record {
		return
	}
	if t := h.tenantOf(c.Group()); t != nil {
		t.recorder.stub(op, v, failure, charge)
	}
}

func gbp(price string) (talk.Value, error) {
	n, err := talk.Dec(price)
	if err != nil {
		return talk.Nothing, err
	}
	d, ok := n.AsDec()
	if !ok {
		return talk.Nothing, errors.New("price is not a number")
	}
	return talk.Quantity(d, "GBP")
}

func textOf(v talk.Value) string { s, _ := v.AsText(); return s }

func mustText(s string) talk.Value {
	v, err := talk.Text(s)
	if err != nil {
		panic(err)
	}
	return v
}

func mustMap(pairs ...talk.Pair) talk.Value {
	v, err := talk.Map(pairs...)
	if err != nil {
		panic(err)
	}
	return v
}
