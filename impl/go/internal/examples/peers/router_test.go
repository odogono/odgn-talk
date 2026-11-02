package peers

import (
	"testing"
	"time"

	talk "northtalk.org/go"
)

// Two Groups on one Host, talking only through the router: the round trip
// the Conformance Corpus leaves out (#1974).
const billingSource = `script variable seen = []
on start
  ask peer to expose "billing" and wait
end start
on charge amount
  ask peer to caller
  put [amount, it] after seen
  if amount > 100 then
    throw {code: "too much", limit: 100}
  end if
  return amount + 1
end charge
on note line, claim
  ask peer to caller
  put [line, it] after seen
end note
on subscribe inbox
  send said with "subscribed" to inbox
end subscribe
on close
  ask peer to unexpose "billing"
end close`

const shopSource = `script variable got = []
script variable billing = nothing
on start
  ask peer to reach "billing" into billing and wait
end start
on pay amount
  try
    send charge with amount to billing and wait
    put it after got
  catch e
    put [the code of e, the reason of e] after got
  end try
end pay
on note line
  send note with line, {user: "mallory"} to billing
end note
on listen
  ask peer to expose into inbox and wait
  send subscribe with inbox to billing
end listen
on said line
  put line after got
end said
on reachAgain
  try
    ask peer to reach "billing" and wait
  catch e
    put the code of e after got
  end try
end reachAgain
on forbidden
  try
    ask peer to reach "admin" and wait
  catch e
    put the code of e after got
  end try
end forbidden`

type world struct {
	t             *testing.T
	clock         time.Time
	billing, shop *talk.Group
	b, s          *talk.Script
}

func setUp(t *testing.T) *world {
	core := talk.New()
	router := New(core)
	costs := talk.Costs{}
	for _, name := range []string{"expose", "unexpose", "reach", "post", "call", "caller"} {
		costs[name] = talk.Cost{Fuel: 3}
	}
	def, err := core.PeerCapability(router, costs)
	if err != nil {
		t.Fatal(err)
	}
	w := &world{t: t, clock: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)}
	w.billing = core.NewGroup(talk.GroupOptions{})
	w.shop = core.NewGroup(talk.GroupOptions{})
	identity := func(name string) talk.Value {
		v, _ := talk.Text(name)
		m, _ := talk.Map(talk.Pair{Key: "group", Val: v})
		return m
	}
	router.Attach(w.billing, identity("billing"))
	router.Attach(w.shop, identity("shop"))
	binding := Binding{Expose: []string{"billing"}, Reach: []string{"billing"}}
	if w.b, err = w.billing.Load(talk.LoadOptions{Name: "billing", Source: billingSource, Grants: map[string]*talk.Grant{"peer": def.GrantAll(binding)}}); err != nil {
		t.Fatal(err)
	}
	if w.s, err = w.shop.Load(talk.LoadOptions{Name: "shop", Source: shopSource, Grants: map[string]*talk.Grant{"peer": def.GrantAll(binding)}}); err != nil {
		t.Fatal(err)
	}
	return w
}

func (w *world) deliver(s *talk.Script, name string, args ...talk.Value) {
	if _, err := s.Deliver(talk.Message{Name: name, Args: args}); err != nil {
		w.t.Fatal(err)
	}
}

// settle pumps the Groups in turn, leaving time for replies to cross.
func (w *world) settle(groups ...*talk.Group) {
	for range 4 {
		for _, g := range groups {
			w.clock = w.clock.Add(time.Second)
			if _, err := g.Pump(w.clock, talk.PumpOptions{}); err != nil {
				w.t.Fatal(err)
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func variable(g *talk.Group, name string) string {
	for _, p := range g.Inspect().Scripts[0].Vars {
		if p.Key == name {
			return p.Val.String()
		}
	}
	return ""
}

func (w *world) expect(g *talk.Group, name, want string) {
	w.t.Helper()
	if got := variable(g, name); got != want {
		w.t.Errorf("%s = %s, want %s", name, got, want)
	}
}

func (w *world) started() {
	w.deliver(w.b, "start")
	w.settle(w.billing)
	w.deliver(w.s, "start")
	w.settle(w.shop)
}

func TestCallRoundTrip(t *testing.T) {
	w := setUp(t)
	w.started()
	// One at a time: each reply comes back on its own goroutine.
	w.deliver(w.s, "pay", talk.Int(12))
	w.settle(w.shop, w.billing)
	w.deliver(w.s, "pay", talk.Int(500))
	w.settle(w.shop, w.billing)
	w.expect(w.shop, "got", `[13, ["send failed", "errored"]]`)
	// The receiving Host vouched for the sender's Group, never its arguments.
	w.expect(w.billing, "seen", `[[12, {group: "shop"}], [500, {group: "shop"}]]`)
}

func TestPostIsVouchedFor(t *testing.T) {
	w := setUp(t)
	w.started()
	hello, _ := talk.Text("hello")
	w.deliver(w.s, "note", hello)
	w.settle(w.shop, w.billing)
	w.expect(w.billing, "seen", `[["hello", {group: "shop"}]]`)
}

func TestPeerHandedOverIsAPushChannel(t *testing.T) {
	w := setUp(t)
	w.started()
	w.deliver(w.s, "listen")
	w.settle(w.shop, w.billing)
	w.expect(w.shop, "got", `["subscribed"]`)
}

func TestRefusedAndUnexposedNames(t *testing.T) {
	w := setUp(t)
	w.started()
	w.deliver(w.s, "forbidden")
	w.settle(w.shop)
	w.deliver(w.b, "close")
	w.settle(w.billing)
	w.deliver(w.s, "reachAgain")
	w.deliver(w.s, "pay", talk.Int(1))
	w.settle(w.shop, w.billing)
	w.expect(w.shop, "got", `["bad address", "not exposed", ["send failed", "not exposed"]]`)
}

// A `peer` Grant trimmed to what a Script uses keeps `post` and `call` with
// `reach`, so a send to the Peer it reached still works (chapter 7).
func TestGrantsAsUsedKeepsRemoteSends(t *testing.T) {
	core := talk.New()
	router := New(core)
	costs := talk.Costs{}
	for _, name := range []string{"expose", "unexpose", "reach", "post", "call", "caller"} {
		costs[name] = talk.Cost{Fuel: 3}
	}
	def, err := core.PeerCapability(router, costs)
	if err != nil {
		t.Fatal(err)
	}
	w := &world{t: t, clock: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)}
	w.billing = core.NewGroup(talk.GroupOptions{})
	w.shop = core.NewGroup(talk.GroupOptions{})
	router.Attach(w.billing, talk.Nothing)
	router.Attach(w.shop, talk.Nothing)
	grants := func() map[string]*talk.Grant { return map[string]*talk.Grant{"peer": def.GrantAll(Binding{})} }
	if w.b, err = w.billing.Load(talk.LoadOptions{Name: "billing", Source: billingSource, Grants: grants(), GrantsAsUsed: true}); err != nil {
		t.Fatal(err)
	}
	if w.s, err = w.shop.Load(talk.LoadOptions{Name: "shop", Source: "on start\n  ask peer to reach \"billing\" into b and wait\n  send charge with 1 to b and wait\nend start", Grants: grants(), GrantsAsUsed: true}); err != nil {
		t.Fatal(err)
	}
	w.deliver(w.b, "start")
	w.settle(w.billing)
	w.deliver(w.s, "start")
	w.settle(w.shop, w.billing)
	w.expect(w.billing, "seen", `[[1, nothing]]`)
}
