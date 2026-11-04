package northtalk

// musicalClockGrant is the reserved Grant name of the Group's musical clock
// (09-embedding.md, The musical clock). No source can name it.
const musicalClockGrant = "musical-clock"

// GroupOption is a Group setting beyond GroupOptions, which NewGroup and
// Restore both take.
type GroupOption interface{ groupOption() }

type musicalClockOption struct{ clock *CapabilityDef }

func (musicalClockOption) groupOption() {}

// WithMusicalClock supplies the Group's musical clock (ADR 0166), which
// MusicalClockCapability makes. Every Script is granted it under the reserved name "musical
// clock", which LoadOptions.Grants can't use, and a wait in a Musical Unit
// calls it. Without one, such a wait raises `no musical time`. Load refuses
// a Capability MusicalClockCapability didn't make as invalid value.
func WithMusicalClock(clock *CapabilityDef) GroupOption { return musicalClockOption{clock} }

// MusicalClockImpl ends a musical wait. Wait starts a suspending call with
// the count a Script waits for, a whole number of bars or beats, 1 or more;
// the Host answers Nothing when that many lines have passed on its
// Transport, or fails the call, whose code then raises in the Run.
type MusicalClockImpl interface {
	Wait(c *Call, count Value) error
}

// MusicalClockCapability defines the musical clock WithMusicalClock takes
// (09-embedding.md, The musical clock): the Capability "musical-clock", whose
// one Operation, wait, is suspending, takes one bar or beat count, has no
// MaxPending, result Nothing and no error catalogue. costs gives wait's cost.
// DefineCapability refuses wait as an Operation name, since no source can
// call it, so only the Core makes this one.
func (c *Core) MusicalClockCapability(impl MusicalClockImpl, costs Costs, options ...CapabilityOption) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing musical clock implementation"}
	}
	for _, option := range options {
		if _, ok := option.(Operation); ok {
			return nil, &HostError{InvalidValue, "a musical clock has one Operation"}
		}
	}
	_, release, err := capabilityOptions(options)
	if err != nil {
		return nil, err
	}
	cost, err := standardCost(costs, "wait")
	if err != nil {
		return nil, err
	}
	d, err := c.defineCapabilityAs(musicalClockGrant, nil, nil, true, Operation{
		Name: "wait", Mode: Suspending, Args: []Shape{OneOf(QuantityKind("bar"), QuantityKind("beat"))}, Result: NothingShape, Cost: cost,
		Start: func(call *Call, args []Value) error { return impl.Wait(call, args[0]) },
	})
	if d != nil {
		d.release = release
	}
	return d, err
}

// applyGroupOptions keeps the musical clock as the Grant each Script is given.
func (g *Group) applyGroupOptions(options []GroupOption) {
	for _, option := range options {
		if o, ok := option.(musicalClockOption); ok {
			g.musicalClock = o.clock
		}
	}
}

// musicalGrants adds the musical clock to a Script's Grants, refusing the
// reserved name from the Host.
func (g *Group) musicalGrants(given map[string]*Grant) (map[string]*Grant, error) {
	if _, ok := given[musicalClockGrant]; ok {
		return nil, &HostError{InvalidValue, "\"musical-clock\" is a reserved Grant name"}
	}
	if g.musicalClock == nil {
		return given, nil
	}
	clock, err := g.musicalClockGrant()
	if err != nil {
		return nil, err
	}
	out := make(map[string]*Grant, len(given)+1)
	for name, grant := range given {
		out[name] = grant
	}
	out[musicalClockGrant] = clock
	return out, nil
}

func (g *Group) musicalClockGrant() (*Grant, error) {
	if !g.musicalClock.musical {
		return nil, &HostError{InvalidValue, "a musical clock is made by MusicalClockCapability"}
	}
	return g.musicalClock.Grant([]string{"wait"}, nil)
}
