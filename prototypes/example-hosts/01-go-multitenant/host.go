// PROTOTYPE: Example Host 1, a multi-tenant Go server (throwaway sketch; does
// not compile). Many tenants' untrusted Scripts in one process, one Script
// Group per tenant, Groups pumped in parallel by a worker pool.
//
// Exercises: per-Script limits, Capability grants with declared costs and
// modes, a Charge budget handle, Groups in parallel, Run outcome and Stop
// Script reports, cumulative quotas from counters, revocation, reload.
// `// ??` marks where the proposed API (../api/talk.go) strains.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"example.com/talk" // ../api/talk.go
)

// ---------------------------------------------------------------------------
// Capabilities: defined once per process, granted per tenant.
// ---------------------------------------------------------------------------

type tenantBinding struct {
	tenant *Tenant
}

func bindingOf(c *talk.Call) *Tenant { return c.Binding().(tenantBinding).tenant }

var ledgerCap = talk.DefineCapability("ledger",
	talk.Operation{
		Name: "record",
		Args: []talk.Shape{talk.MapShape(
			talk.Field{Key: "ref", Shape: talk.NumberShape()},
			talk.Field{Key: "amount", Shape: talk.AnyShape()}, // ?? no QuantityShape("GBP")
			talk.Field{Key: "due", Shape: talk.AnyShape()},    // ?? no CivilDateShape
		)},
		Result: talk.MapShape(talk.Field{Key: "id", Shape: talk.TextShape()}),
		Cost:   talk.Cost{Fuel: 200},
		Mode:   talk.Suspending,
		Start: func(c *talk.Call, args []talk.Value) {
			t := bindingOf(c)
			go func() {
				id, err := t.db.InsertInvoice(c.Context(), t.id, args[0])
				if c.Context().Err() != nil {
					return // Run cancelled or Script stopped: nobody is listening
				}
				if err != nil {
					c.Fail(&talk.Error{Code: "ledger", Message: err.Error()})
					return
				}
				c.Answer(talk.Map(talk.KV("id", talk.MustText(id))))
				// ?? Answer after Context is cancelled: silently ignored? It
				//    should be, but then the check above is only an optimisation.
			}()
		},
	},
	talk.Operation{
		Name: "settle",
		Args: []talk.Shape{talk.AnyShape()},
		Cost: talk.Cost{Fuel: 50},
		Mode: talk.FireAndForget,
		Fire: func(c *talk.Call, args []talk.Value) {
			bindingOf(c).db.EnqueueSettle(args[0]) // failures go to the tenant's activity log
		},
	},
)

var mailCap = talk.DefineCapability("mail",
	talk.Operation{
		Name: "send",
		Args: []talk.Shape{talk.MapShape(
			talk.Field{Key: "to", Shape: talk.TextShape()},
			talk.Field{Key: "subject", Shape: talk.TextShape()},
			talk.Field{Key: "body", Shape: talk.TextShape()},
		)},
		Cost: talk.Cost{Fuel: 500}, // mail is expensive on purpose: it's the abuse vector
		Mode: talk.FireAndForget,
		Fire: func(c *talk.Call, args []talk.Value) {
			t := bindingOf(c)
			if !t.mailLimiter.Allow() {
				t.activity("mail dropped: rate limit") // ?? no way to tell the Script
				return
			}
			t.outbox.Send(args[0])
		},
	},
)

// calendar: "now" is a Capability (syntax-sketch NOTES #16). Zone comes from
// the tenant's settings, so Scripts never name a zone.
var calendarCap = talk.DefineCapability("calendar",
	talk.Operation{
		Name:   "today",
		Result: talk.AnyShape(),
		Cost:   talk.Cost{Fuel: 5},
		Mode:   talk.Immediate,
		Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
			t := bindingOf(c)
			// ?? Must use the GROUP's Clock reading, not time.Now(), or two
			//    Cores replaying the same inputs disagree. The Call has no
			//    Clock accessor. Proposal: c.Now() = the scheduler's current
			//    reading (ADR 0006: read only at scheduler boundaries).
			return civilDate(c.Now(), t.zone), nil
		},
	},
)

// http: granted per plan. Binding holds the allowed origins.
var httpCap = talk.DefineCapability("http",
	talk.Operation{
		Name: "get",
		Args: []talk.Shape{talk.TextShape(), talk.Optional(talk.OpenMap())},
		Cost: talk.Cost{Fuel: 1000},
		Mode: talk.Suspending,
		Start: func(c *talk.Call, args []talk.Value) {
			t := bindingOf(c)
			url, _ := args[0].AsText()
			if !t.allowedOrigin(url) {
				c.Fail(&talk.Error{Code: "forbidden", Message: "origin not allowed: " + url})
				return
			}
			go func() {
				resp, body, err := t.httpClient.Get(c.Context(), url, 1<<20)
				if err != nil {
					c.Fail(&talk.Error{Code: "http", Message: err.Error()})
					return
				}
				// Budget handle: charge per KiB received before converting.
				// ?? Charge from a goroutine, after the Run suspended: whose
				//    Fuel? The Run is parked; charging it now is fine for
				//    accounting but the fault can only surface on resume. So
				//    maybe Charge is only legal inside Start/Do, and post-hoc
				//    cost belongs in Answer (c.AnswerCharged(v, fuel)).
				if err := c.Charge(int64(len(body)/1024) * 10); err != nil {
					c.Fail(nil) // ?? how do you "return ErrLimit" from a goroutine?
					return
				}
				c.Answer(talk.Map(
					talk.KV("status", talk.Int(int64(resp.StatusCode))),
					talk.KV("headers", lowerHeaders(resp.Header)), // map keys are case-sensitive (ADR 0011)
					talk.KV("body", talk.Bytes(body)),
				))
			}()
		},
	},
)

var logCap = talk.DefineCapability("log",
	talk.Operation{
		Name: "write", Args: []talk.Shape{talk.TextShape()},
		Cost: talk.Cost{Fuel: 20}, Mode: talk.FireAndForget,
		Fire: func(c *talk.Call, args []talk.Value) {
			s, _ := args[0].AsText()
			bindingOf(c).activity(c.Script().Name() + ": " + s)
		},
	},
)

var inboxCap = talk.DefineCapability("inbox",
	talk.Operation{
		Name: "ask", // see approvals.talk: reads badly
		Args: []talk.Shape{talk.AnyShape()},
		Cost: talk.Cost{Fuel: 100},
		Mode: talk.Suspending,
		Start: func(c *talk.Call, args []talk.Value) {
			t := bindingOf(c)
			q := t.inbox.Open(c.ID(), args[0]) // shown in the tenant's web UI
			go func() {
				select {
				case ans := <-q.Answered:
					c.Answer(ans)
				case <-time.After(48 * time.Hour):
					c.Fail(&talk.Error{Code: "timeout", Message: "no answer in 48h"})
				case <-c.Context().Done():
					q.Withdraw()
				}
			}()
			// ?? A 48h suspended Run pins Persistent State in RAM and dies with
			//    the process (ADR 0005). This really wants Host-owned state
			//    plus a later `decision` event. Sketched this way to see how
			//    bad it is: the API allows it and nothing warns.
		},
	},
)

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

type Plan struct {
	HTTP        bool
	DailyFuel   int64
	Limits      talk.Limits
}

type Tenant struct {
	id      string
	plan    Plan
	zone    string
	group   *talk.Group
	scripts map[string]*talk.Script
	grants  map[string]*talk.Grant

	// driving
	queued atomic.Bool
	timer  *time.Timer

	// quota
	mu        sync.Mutex
	fuelToday int64
	lastFuel  map[string]int64 // per Script, last Counters().FuelTotal seen

	db          DB
	outbox      Outbox
	inbox       Inbox
	httpClient  HTTPClient
	mailLimiter Limiter
}

var core = talk.New()

func loadTenant(id string, plan Plan, sources map[string]string) (*Tenant, error) {
	t := &Tenant{id: id, plan: plan, scripts: map[string]*talk.Script{}, lastFuel: map[string]int64{}}

	b := tenantBinding{t}
	t.grants = map[string]*talk.Grant{
		"ledger":   ledgerCap.GrantAll(b),
		"mail":     mailCap.GrantAll(b),
		"calendar": calendarCap.GrantAll(b),
		"log":      logCap.GrantAll(b),
		"inbox":    inboxCap.GrantAll(b),
	}
	if plan.HTTP {
		t.grants["http"] = httpCap.Grant([]string{"get"}, b)
	}

	t.group = core.NewGroup(talk.GroupOptions{
		Name:    "tenant:" + id,
		Clock:   wallClock{},
		Reports: t, // Tenant implements talk.Reports below
		OnReady: func() { schedule(t) },
	})

	// ?? Grants are per Script, but both Scripts get the same set here. Each
	//    Script should get only what it uses; the loader knows that, the Host
	//    doesn't. A "grant what's used, from this allowlist" mode would help.
	for name, src := range sources {
		s, diags, err := t.group.Load(talk.LoadOptions{
			Name:   name,
			Source: src,
			Grants: t.grants,
			Limits: plan.Limits,
			Messages: []talk.MessageDecl{
				{Name: "handle", Args: []talk.Shape{talk.AnyShape()}, DefaultQueueing: talk.Queued},
				{Name: "nightly", DefaultQueueing: talk.Dropping},
			},
		})
		if err != nil {
			return nil, loadError(name, diags)
		}
		t.scripts[name] = s
	}
	// ?? invoices.talk says `send review … to approvals`. How does the name
	//    `approvals` resolve? Proposal: Scripts in the same Group are
	//    addressable by name. Across Groups there is no name; the Host routes.
	return t, nil
}

// ---------------------------------------------------------------------------
// Driving: a bounded pool pumps ready Groups. The Core owns no goroutines.
// ---------------------------------------------------------------------------

var runQueue = make(chan *Tenant, 65536)

func schedule(t *Tenant) {
	if t.queued.CompareAndSwap(false, true) {
		runQueue <- t
	}
}

func worker() {
	for t := range runQueue {
		t.queued.Store(false)
		// One slice of fairness: no tenant holds a worker for long.
		r := t.group.Pump(talk.PumpOptions{FuelCap: 200_000})
		switch r.State {
		case talk.Sliced:
			schedule(t) // more to do; back of the queue
		case talk.Idle:
			if !r.NextDeadline.IsZero() {
				t.armTimer(r.NextDeadline)
			}
		}
		t.checkQuota()
	}
	// ?? Every Go Host will write exactly this (dedupe flag, run queue, timer
	//    per Group, re-queue on Sliced). It belongs in a talk.Driver helper
	//    next to the Core, like TS's autoDrive, with the Host choosing pool
	//    size and FuelCap.
}

func (t *Tenant) armTimer(at time.Time) {
	if t.timer != nil {
		t.timer.Stop()
	}
	t.timer = time.AfterFunc(time.Until(at), func() { schedule(t) })
}

func main() {
	for i := 0; i < 32; i++ {
		go worker()
	}
	http.HandleFunc("POST /t/{tenant}/documents", postDocument)
	http.HandleFunc("PUT /t/{tenant}/scripts/{name}", putScript)
	http.ListenAndServe(":8080", nil)
}

// ---------------------------------------------------------------------------
// Inbound: HTTP → Host-delivered message.
// ---------------------------------------------------------------------------

func postDocument(w http.ResponseWriter, r *http.Request) {
	t := tenants.Get(r.PathValue("tenant"))
	doc, err := jsonToValue(r.Body)
	// ?? encoding/json into map[string]any loses key order and turns numbers
	//    into float64. The Host needs a streaming decoder with json.Number to
	//    build talk.Map pairs in order and talk.Dec numbers. Every Host needs
	//    this: talk should ship JSON ↔ Value for the Host side (not the
	//    Script side; that's the stdlib's `json of`).
	if err != nil {
		http.Error(w, "bad json", 400)
		return
	}
	err = t.scripts["invoices"].Deliver(talk.Message{Name: "handle", Args: []talk.Value{doc}})
	switch err {
	case nil:
		w.WriteHeader(http.StatusAccepted)
	case talk.ErrMailboxFull:
		http.Error(w, "busy", http.StatusTooManyRequests)
	default:
		http.Error(w, err.Error(), 500) // stopped Script, etc.
	}
	// Deliver may be called from the HTTP goroutine while a worker pumps the
	// Group. ?? So Deliver must be goroutine-safe even though the Group is
	// "single-threaded". Proposal: Deliver, Stop, CancelRun, Answer, Fail are
	// safe from any goroutine; Load, Pump, Save are not.
}

func putScript(w http.ResponseWriter, r *http.Request) {
	t := tenants.Get(r.PathValue("tenant"))
	s := t.scripts[r.PathValue("name")]
	src := readAll(r.Body)
	diags, err := s.Reload(src, talk.CarryVariables)
	// ?? Reload while a worker is mid-Pump on this Group: Reload is not
	//    goroutine-safe. The Host has to queue it as work for the Group's
	//    worker. Same for Load of a new Script and for Save.
	if err != nil {
		writeDiagnostics(w, diags) // same codes/locations as the TS Core would give
		return
	}
	w.WriteHeader(204)
}

// ---------------------------------------------------------------------------
// Reports: Run outcomes, stops, unhandled messages.
// ---------------------------------------------------------------------------

func (t *Tenant) OnRunEnd(r talk.RunReport) {
	switch r.Outcome {
	case talk.Errored:
		t.activity(r.Script.Name() + ": " + r.Handler + " failed: " + r.Error.Code + " at line " + itoa(r.At.Line))
	case talk.LimitFault:
		t.activity(r.Script.Name() + ": " + r.Handler + " ran out of " + r.Limit + " (changes undone)")
	}
	// ?? RunReport doesn't say which message started the Run, only the
	//    Handler name. The tenant wants "document INV-42 failed". The Host
	//    would need to correlate by Run id, which it never saw at Deliver.
	//    Proposal: Deliver returns a DeliveryID and RunReport carries it.
}

func (t *Tenant) OnStop(r talk.StopReport) {
	t.activity(r.Script.Name() + " stopped: " + r.Reason + " (" + itoa(len(r.DiscardedRuns)) + " runs discarded)")
}

func (t *Tenant) OnUnhandled(s *talk.Script, m talk.Message) {
	t.activity("no rule for message " + m.Name)
}

// Cumulative quota: the Core only counts; policy is ours (ADR 0006).
func (t *Tenant) checkQuota() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for name, s := range t.scripts {
		c := s.Counters()
		t.fuelToday += c.FuelTotal - t.lastFuel[name]
		t.lastFuel[name] = c.FuelTotal
	}
	if t.fuelToday > t.plan.DailyFuel {
		for _, s := range t.scripts {
			s.Stop("daily fuel quota")
		}
	}
	// ?? Counters since load, diffed by the Host, reset by Reload? If Reload
	//    resets FuelTotal the diff goes negative. ADR 0008 says counters carry
	//    over a variables-only restore; Reload should say the same.
}

// Plan downgrade: take http away from a live tenant.
func (t *Tenant) downgrade() {
	if g, ok := t.grants["http"]; ok {
		g.Revoke()
		// Later `ask http …` is an ordinary "capability revoked" error. But
		// the Scripts were loaded with http granted, so they still compile.
		// On the next Reload the loader rejects `ask http` outright.
		// ?? So a revoked Capability is a run-time error until the next edit,
		//    then a load-time error. Acceptable, but tenants will notice.
	}
}

// Placeholders so the sketch reads; none of these exist.
type (
	DB          interface{ InsertInvoice(context.Context, string, talk.Value) (string, error); EnqueueSettle(talk.Value) }
	Outbox      interface{ Send(talk.Value) }
	Inbox       interface{ Open(talk.CallID, talk.Value) *Question }
	Question    struct{ Answered chan talk.Value; Withdraw func() }
	HTTPClient  interface{ Get(context.Context, string, int) (*http.Response, []byte, error) }
	Limiter     interface{ Allow() bool }
	wallClock   struct{}
)

func (wallClock) Now() time.Time { return time.Now() }

var _ = json.Valid
