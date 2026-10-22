// Package httphost is the HTTP router (spec chapter 9, The HTTP router; ADR
// 0124): the Host side of the optional http Standard Capability. It holds
// Serve Registrations, listens with net/http, turns each HTTP request into a
// Script.Deliver and answers the HTTP Exchange from respond or, failing
// that, from the Pump's reports. It is built only on the embedding
// interface.
//
//	h, _ := httphost.New(core, httphost.Options{})
//	capability, _ := core.HTTPCapability(h, costs)
//	pool := driver.NewPool(driver.PoolOptions{OnPump: h.OnPump})
package httphost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
)

// DefaultMaxBodyBytes is the largest request body the router reads unless
// Options says otherwise: 1 MiB. A larger one is answered 413 without a
// Delivery.
const DefaultMaxBodyBytes = 1 << 20

// Options configures a Host. The zero value listens on 127.0.0.1, on a port
// the system chooses, for any Grant.
type Options struct {
	// Allow says whether a Grant, by its binding, may listen on an address.
	// nil allows any; a refusal fails serve with `bad address`.
	Allow func(host string, port int, binding any) bool
	// DefaultHost is the host a serve without `host` listens on; empty means
	// 127.0.0.1.
	DefaultHost string
	// DefaultPort is the port a serve without `port` listens on; 0 lets the
	// system choose.
	DefaultPort int
	// PortOverride, when not nil, is the port every serve listens on,
	// whatever it asked for.
	PortOverride *int
	// MaxBodyBytes caps a request body; 0 means DefaultMaxBodyBytes.
	MaxBodyBytes int64
	// Log is told each 500's cause and each refused Delivery. It is never
	// sent to the client.
	Log func(string)
}

// Address is where a listener listens.
type Address struct {
	Host string
	Port int
}

type owner struct {
	group        *talk.Group
	script, name string
}

type registration struct {
	owner    owner
	name     string
	prefix   string
	message  string
	asked    Address
	listener *listener
}

type listener struct {
	address       Address
	server        *http.Server
	registrations map[*registration]struct{}
	closed        bool
}

type reply struct {
	status  int
	headers [][2]string
	body    []byte
}

type exchange struct {
	group    *talk.Group
	object   *talk.Object
	ready    chan struct{} // closed once delivery is set
	delivery talk.DeliveryID
	run      talk.RunID
	answered bool
	closed   bool
	replies  chan reply
}

// Host is the router. It implements talk.HTTPImpl.
type Host struct {
	options Options
	kind    *talk.ObjectKind

	mu            sync.Mutex
	cond          *sync.Cond
	registrations map[string]*registration
	listeners     map[Address]*listener
	order         []*listener
	exchanges     map[*talk.Group]map[talk.DeliveryID]*exchange
	runs          map[*talk.Group]map[talk.RunID]talk.DeliveryID
	inflight      map[*talk.Group]int
	open          int
	stopping      bool
	nextExchange  int
}

var _ talk.HTTPImpl = (*Host)(nil)

// New makes a router, defining the httpExchange Object Kind on core.
func New(core *talk.Core, o Options) (*Host, error) {
	if o.DefaultHost == "" {
		o.DefaultHost = "127.0.0.1"
	}
	if o.MaxBodyBytes <= 0 {
		o.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if o.Log == nil {
		o.Log = func(string) {}
	}
	h := &Host{
		options:       o,
		registrations: map[string]*registration{},
		listeners:     map[Address]*listener{},
		exchanges:     map[*talk.Group]map[talk.DeliveryID]*exchange{},
		runs:          map[*talk.Group]map[talk.RunID]talk.DeliveryID{},
		inflight:      map[*talk.Group]int{},
	}
	h.cond = sync.NewCond(&h.mu)
	kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "httpExchange", Props: []talk.Prop{{
		Name: "closed", Shape: talk.BoolShape, GetCost: talk.Cost{Fuel: 1},
		Get: func(o *talk.Object) (talk.Value, error) {
			x := o.Native().(*exchange)
			h.mu.Lock()
			defer h.mu.Unlock()
			return talk.Bool(x.closed), nil
		},
	}}})
	if err != nil {
		return nil, err
	}
	h.kind = kind
	return h, nil
}

func scriptError(code, message string) *talk.ScriptError {
	return &talk.ScriptError{Code: code, Message: message}
}

func registrationKey(o owner, name string) string {
	return fmt.Sprintf("%p\x00%s\x00%s\x00%s", o.group, o.script, o.name, name)
}

func addressValue(a Address) talk.Value {
	host, _ := talk.Text(a.Host)
	v, _ := talk.Map(talk.KV("host", host), talk.KV("port", talk.Int(int64(a.Port))))
	return v
}

func wholeOf(v talk.Value) (int, bool) {
	if v.Kind() != talk.KindNumber {
		return 0, false
	}
	n, err := strconv.Atoi(v.String())
	return n, err == nil
}

// Serve registers, replaces or confirms a Serve Registration, listening on
// its address if no listener holds it yet.
func (h *Host) Serve(c *talk.Call, name, prefix, message string, options talk.Value) error {
	host := h.options.DefaultHost
	if t, ok := options.Get("host").AsText(); ok {
		host = t
	}
	port, ok := h.options.DefaultPort, true
	if p := options.Get("port"); p.Kind() != talk.KindNothing {
		port, ok = wholeOf(p)
	}
	if h.options.PortOverride != nil {
		port, ok = *h.options.PortOverride, true
	}
	if !ok || port < 0 || port > 65535 || host == "" || (h.options.Allow != nil && !h.options.Allow(host, port, c.Binding())) {
		c.Fail(scriptError("bad address", fmt.Sprintf("%s:%d", host, port)))
		return nil
	}
	o := owner{c.Group(), c.ScriptName(), c.GrantName()}
	key := registrationKey(o, name)
	asked := Address{host, port}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopping {
		c.Fail(scriptError("bad address", "the Host is stopping"))
		return nil
	}
	existing := h.registrations[key]
	if existing != nil && existing.prefix == prefix && existing.message == message && existing.asked == asked {
		c.Answer(addressValue(existing.listener.address))
		return nil
	}
	var l *listener
	if port != 0 {
		l = h.listeners[asked]
	}
	if l != nil {
		for r := range l.registrations {
			if r.prefix == prefix && r.owner != o {
				c.Fail(scriptError("address in use", fmt.Sprintf("%s:%d%s is served by another owner", host, port, prefix)))
				return nil
			}
		}
	} else {
		var err error
		if l, err = h.listen(host, port); err != nil {
			code := "bad address"
			if errors.Is(err, syscall.EADDRINUSE) {
				code = "address in use"
			}
			c.Fail(scriptError(code, err.Error()))
			return nil
		}
	}
	r := &registration{owner: o, name: name, prefix: prefix, message: message, asked: asked, listener: l}
	l.registrations[r] = struct{}{}
	h.registrations[key] = r
	if existing != nil {
		delete(existing.listener.registrations, existing)
		if existing.listener != l && len(existing.listener.registrations) == 0 {
			h.closeListener(existing.listener)
		}
	}
	c.Answer(addressValue(l.address))
	return nil
}

// listen binds a new listener. h.mu is held.
func (h *Host) listen(host string, port int) (*listener, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	l := &listener{address: Address{host, ln.Addr().(*net.TCPAddr).Port}, registrations: map[*registration]struct{}{}}
	l.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.handle(l, w, r) }), ReadHeaderTimeout: 30 * time.Second}
	h.listeners[l.address] = l
	h.order = append(h.order, l)
	go func() { _ = l.server.Serve(ln) }()
	return l, nil
}

// closeListener stops accepting and lets open exchanges finish. h.mu is held.
func (h *Host) closeListener(l *listener) {
	if l.closed {
		return
	}
	l.closed = true
	delete(h.listeners, l.address)
	h.order = slices.DeleteFunc(h.order, func(x *listener) bool { return x == l })
	go func() { _ = l.server.Shutdown(context.Background()) }()
}

// remove drops a registration, closing its listener if it was the last. h.mu is held.
func (h *Host) remove(r *registration) {
	key := registrationKey(r.owner, r.name)
	if h.registrations[key] != r {
		return
	}
	delete(h.registrations, key)
	delete(r.listener.registrations, r)
	if len(r.listener.registrations) == 0 {
		h.closeListener(r.listener)
	}
}

// Unserve removes the owner's registration called name, if there is one.
func (h *Host) Unserve(c *talk.Call, name string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.registrations[registrationKey(owner{c.Group(), c.ScriptName(), c.GrantName()}, name)]; r != nil {
		h.remove(r)
	}
	return nil
}

// Respond answers the exchange, once, from the Run its Delivery started.
func (h *Host) Respond(c *talk.Call, o *talk.Object, response talk.Value) error {
	x, ok := o.Native().(*exchange)
	if !ok || o.Kind() != h.kind {
		return scriptError("not owner", "not this Host's exchange")
	}
	<-x.ready
	h.mu.Lock()
	defer h.mu.Unlock()
	if x.group != c.Group() || c.Delivery() == "" || talk.DeliveryID(c.Delivery()) != x.delivery {
		return scriptError("not owner", "this Run did not receive the exchange")
	}
	if x.answered {
		return scriptError("already responded", "the exchange is answered")
	}
	if x.closed {
		return scriptError("exchange closed", "the client has gone")
	}
	out := reply{status: 200}
	if n, ok := wholeOf(response.Get("status")); ok {
		out.status = n
	}
	for _, p := range response.Get("headers").Entries() {
		if t, ok := p.Val.AsText(); ok {
			out.headers = append(out.headers, [2]string{p.Key, t})
			continue
		}
		for i := 1; i <= p.Val.Len(); i++ {
			t, _ := p.Val.Index(i).AsText()
			out.headers = append(out.headers, [2]string{p.Key, t})
		}
	}
	has := func(name string) bool {
		return slices.ContainsFunc(out.headers, func(h [2]string) bool { return strings.EqualFold(h[0], name) })
	}
	body, js := response.Get("body"), response.Get("json")
	switch {
	case js.Kind() == talk.KindText:
		t, _ := js.AsText()
		out.body = []byte(t)
		if !has("content-type") {
			out.headers = append(out.headers, [2]string{"content-type", "application/json"})
		}
	case body.Kind() == talk.KindText:
		t, _ := body.AsText()
		out.body = []byte(t)
		if !has("content-type") {
			out.headers = append(out.headers, [2]string{"content-type", "text/plain; charset=utf-8"})
		}
	case body.Kind() == talk.KindBytes:
		out.body, _ = body.AsBytes()
	}
	x.answered = true
	h.open--
	x.replies <- out
	return nil
}

var statusText = map[int]string{404: "Not Found", 413: "Payload Too Large", 500: "Internal Server Error", 503: "Service Unavailable"}

func plain(status int) reply {
	return reply{status: status, headers: [][2]string{{"content-type", "text/plain; charset=utf-8"}}, body: []byte(statusText[status] + "\n")}
}

func write(w http.ResponseWriter, r reply) {
	for _, h := range r.headers {
		w.Header().Add(h[0], h[1])
	}
	if r.status != http.StatusNoContent && r.status != http.StatusNotModified && r.status >= 200 {
		w.Header().Set("Content-Length", strconv.Itoa(len(r.body)))
	}
	if w.Header().Get("Content-Type") == "" {
		// net/http would sniff one; an answer without one has none.
		w.Header()["Content-Type"] = nil
	}
	w.WriteHeader(r.status)
	_, _ = w.Write(r.body)
}

// answer answers an exchange the Script didn't, once. h.mu is held.
func (h *Host) answer(x *exchange, status int) {
	if x.answered {
		return
	}
	x.answered = true
	h.open--
	x.replies <- plain(status)
}

// finish forgets a settled exchange. h.mu is held.
func (h *Host) finish(x *exchange) {
	if m := h.exchanges[x.group]; m != nil {
		delete(m, x.delivery)
	}
	if x.run != "" {
		if m := h.runs[x.group]; m != nil {
			delete(m, x.run)
		}
	}
	if x.object != nil {
		_ = x.group.Dispose(x.object)
	}
}

func (h *Host) settle(x *exchange, status int, why string) {
	if !x.answered && status == 500 && why != "" {
		h.options.Log(fmt.Sprintf("http: 500 for delivery %s: %s", x.delivery, why))
	}
	h.answer(x, status)
	h.finish(x)
}

func (h *Host) match(l *listener, path string) *registration {
	var best *registration
	for r := range l.registrations {
		if strings.HasPrefix(path, r.prefix) && (best == nil || len(r.prefix) > len(best.prefix)) {
			best = r
		}
	}
	return best
}

// RequestFields is the one argument chapter 7 gives an HTTP Exchange's
// Delivery, without `exchange`: method, path, segments, query, headers and
// body, with query keys and header names in code-point order.
func RequestFields(method, target string, header http.Header, body []byte) ([]talk.Pair, error) {
	path, rawQuery, _ := strings.Cut(target, "?")
	text := func(s string) talk.Value { v, _ := talk.Text(s); return v }
	segments := []talk.Value{}
	for part := range strings.SplitSeq(path, "/") {
		if part == "" {
			continue
		}
		if decoded, err := url.PathUnescape(part); err == nil {
			part = decoded
		}
		segments = append(segments, text(part))
	}
	values, _ := url.ParseQuery(rawQuery)
	query := []talk.Pair{}
	for _, k := range slices.Sorted(func(yield func(string) bool) {
		for k := range values {
			if !yield(k) {
				return
			}
		}
	}) {
		vs := values[k]
		if len(vs) == 1 {
			query = append(query, talk.KV(k, text(vs[0])))
			continue
		}
		items := make([]talk.Value, len(vs))
		for i, v := range vs {
			items[i] = text(v)
		}
		query = append(query, talk.KV(k, talk.List(items...)))
	}
	headers := []talk.Pair{}
	names := map[string][]string{}
	for k, vs := range header {
		lower := strings.ToLower(k)
		names[lower] = append(names[lower], vs...)
	}
	for _, k := range slices.Sorted(func(yield func(string) bool) {
		for k := range names {
			if !yield(k) {
				return
			}
		}
	}) {
		if k == "set-cookie" {
			items := make([]talk.Value, len(names[k]))
			for i, v := range names[k] {
				items[i] = text(v)
			}
			headers = append(headers, talk.KV(k, talk.List(items...)))
			continue
		}
		headers = append(headers, talk.KV(k, text(strings.Join(names[k], ", "))))
	}
	q, err := talk.Map(query...)
	if err != nil {
		return nil, err
	}
	hs, err := talk.Map(headers...)
	if err != nil {
		return nil, err
	}
	return []talk.Pair{
		talk.KV("method", text(strings.ToUpper(method))),
		talk.KV("path", text(path)),
		talk.KV("segments", talk.List(segments...)),
		talk.KV("query", q),
		talk.KV("headers", hs),
		talk.KV("body", talk.Bytes(body)),
	}, nil
}

func (h *Host) handle(l *listener, w http.ResponseWriter, req *http.Request) {
	h.mu.Lock()
	stopping := h.stopping
	h.mu.Unlock()
	if stopping {
		w.Header().Set("Connection", "close")
		write(w, plain(503))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, h.options.MaxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			w.Header().Set("Connection", "close")
			write(w, plain(413))
		}
		return
	}
	target := req.RequestURI
	if target == "" || !strings.HasPrefix(target, "/") {
		target = req.URL.RequestURI()
	}
	path, _, _ := strings.Cut(target, "?")
	header := req.Header.Clone()
	if req.Host != "" {
		header.Set("Host", req.Host)
	}
	if len(req.TransferEncoding) > 0 {
		header.Set("Transfer-Encoding", strings.Join(req.TransferEncoding, ", "))
	}
	fields, err := RequestFields(req.Method, target, header, body)
	if err != nil {
		write(w, plain(500))
		return
	}
	h.mu.Lock()
	r := h.match(l, path)
	if r == nil || h.stopping {
		h.mu.Unlock()
		if r == nil {
			write(w, plain(404))
		} else {
			write(w, plain(503))
		}
		return
	}
	g := r.owner.group
	h.nextExchange++
	id := "x" + strconv.Itoa(h.nextExchange)
	x := &exchange{group: g, ready: make(chan struct{}), replies: make(chan reply, 1)}
	h.open++
	h.inflight[g]++
	h.mu.Unlock()

	refused := 0
	x.object, err = g.Object(h.kind, id, x)
	if err == nil {
		script := g.Script(r.owner.script)
		if script == nil {
			err = fmt.Errorf("no Script %s", r.owner.script)
		} else {
			fields = append(fields, talk.KV("exchange", x.object.Value()))
			arg, mapErr := talk.Map(fields...)
			if mapErr != nil {
				err = mapErr
			} else {
				x.delivery, err = script.Deliver(talk.Message{Name: r.message, Args: []talk.Value{arg}})
			}
		}
	}
	h.mu.Lock()
	if err != nil {
		refused = 500
		if errors.Is(err, talk.ErrMailboxFull) {
			refused = 503
		} else {
			h.options.Log(fmt.Sprintf("http: delivery to %s refused: %v", r.owner.script, err))
			h.remove(r)
		}
		h.answer(x, refused)
		if x.object != nil {
			_ = g.Dispose(x.object)
		}
	} else {
		if h.exchanges[g] == nil {
			h.exchanges[g] = map[talk.DeliveryID]*exchange{}
		}
		h.exchanges[g][x.delivery] = x
	}
	h.inflight[g]--
	if h.inflight[g] == 0 {
		delete(h.inflight, g)
	}
	h.cond.Broadcast()
	h.mu.Unlock()
	close(x.ready)

	select {
	case out := <-x.replies:
		write(w, out)
	case <-req.Context().Done():
		h.mu.Lock()
		if !x.answered {
			x.closed = true
		}
		h.mu.Unlock()
	}
}

func failedStatus(o talk.Outcome) int {
	switch o {
	case talk.UnhandledOutcome:
		return 404
	case talk.Cancelled, talk.Dropped:
		return 503
	}
	return 500
}

var outcomeNames = map[talk.Outcome]string{talk.Completed: "completed", talk.Errored: "errored", talk.LimitFault: "limit fault", talk.Cancelled: "cancelled", talk.UnhandledOutcome: "unhandled", talk.Dropped: "dropped", talk.EffectFailureOutcome: "effect failed"}

// Pumped settles exchanges from a Pump's reports, in order. Call it after
// each Pump of the Group returns.
func (h *Host) Pumped(g *talk.Group, result talk.PumpResult) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// A Delivery whose id isn't recorded yet may be in these reports.
	for h.inflight[g] > 0 {
		h.cond.Wait()
	}
	byDelivery := h.exchanges[g]
	ofRun := func(run talk.RunID) *exchange {
		if d, ok := h.runs[g][run]; ok {
			return byDelivery[d]
		}
		return nil
	}
	for _, report := range result.Reports {
		switch r := report.(type) {
		case *talk.Stop:
			for _, reg := range h.registrations {
				if reg.owner.group == g && reg.owner.script == r.Script {
					h.remove(reg)
				}
			}
		case *talk.RunStarted:
			if x := byDelivery[r.Delivery]; x != nil && r.Delivery != "" {
				x.run = r.Run
				if h.runs[g] == nil {
					h.runs[g] = map[talk.RunID]talk.DeliveryID{}
				}
				h.runs[g][r.Run] = r.Delivery
			}
		case *talk.RunEnd:
			x := byDelivery[r.Delivery]
			if x == nil || r.Delivery == "" {
				x = ofRun(r.Run)
			}
			if x != nil && (x.run == "" || x.run == r.Run) {
				why := outcomeNames[r.Outcome]
				switch {
				case r.Outcome == talk.Completed:
					why = "the Run ended without responding"
				case r.Error != nil:
					why += ": " + r.Error.Code + ": " + r.Error.Message
				case r.Limit != "":
					why += " (" + r.Limit + ")"
				}
				h.settle(x, failedStatus(r.Outcome), why)
			}
		case *talk.Unhandled:
			if x := byDelivery[r.Delivery]; x != nil {
				h.settle(x, 404, "")
			}
		case *talk.RunDiscarded:
			if x := ofRun(r.Run); x != nil {
				h.settle(x, h.stoppingStatus(), "run discarded: "+r.Reason)
			}
		case *talk.CausalWork:
			if x := byDelivery[r.RootDelivery]; x != nil && r.LiveRuns == 0 && r.QueuedMessages == 0 {
				h.settle(x, h.stoppingStatus(), "its work ended without a Run")
			}
		}
	}
}

func (h *Host) stoppingStatus() int {
	if h.stopping {
		return 503
	}
	return 500
}

// OnPump is a driver.PoolOptions OnPump that calls Pumped.
func (h *Host) OnPump(m *driver.Member, r talk.PumpResult, err error) {
	if err == nil {
		h.Pumped(m.Group(), r)
	}
}

// Detach is for a Group the Host discards: it removes the Group's
// registrations and answers its open exchanges 503.
func (h *Host) Detach(g *talk.Group) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.registrations {
		if r.owner.group == g {
			h.remove(r)
		}
	}
	for _, x := range h.exchanges[g] {
		h.answer(x, 503)
	}
	delete(h.exchanges, g)
	delete(h.runs, g)
}

// StopAccepting stops every listener accepting. A request on a connection
// already open is answered 503.
func (h *Host) StopAccepting() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopping = true
	for _, l := range slices.Clone(h.order) {
		h.closeListener(l)
	}
}

func (h *Host) answerAll(status int) {
	for _, m := range h.exchanges {
		for _, x := range m {
			h.answer(x, status)
		}
	}
}

// Drain waits up to timeout for the open exchanges to be answered, then
// answers the rest 503. Call StopAccepting first so no new ones arrive.
func (h *Host) Drain(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) && h.OpenExchanges() > 0 {
		time.Sleep(10 * time.Millisecond)
	}
	h.mu.Lock()
	h.answerAll(503)
	h.mu.Unlock()
}

// Close stops accepting, answers every open exchange 503 and closes every
// listener, waiting for their connections.
func (h *Host) Close() error {
	h.mu.Lock()
	h.stopping = true
	h.answerAll(503)
	servers := []*http.Server{}
	for _, l := range h.order {
		l.closed = true
		servers = append(servers, l.server)
	}
	h.order = nil
	h.listeners = map[Address]*listener{}
	h.registrations = map[string]*registration{}
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var errs []error
	for _, s := range servers {
		if err := s.Shutdown(ctx); err != nil {
			errs = append(errs, s.Close())
		}
	}
	return errors.Join(errs...)
}

// OpenExchanges is the number of exchanges delivered and not yet answered.
func (h *Host) OpenExchanges() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.open
}

// Registrations is the number of Serve Registrations held.
func (h *Host) Registrations() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.registrations)
}

// Addresses lists every address listening now, in the order they bound.
func (h *Host) Addresses() []Address {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Address, len(h.order))
	for i, l := range h.order {
		out[i] = l.address
	}
	return out
}
