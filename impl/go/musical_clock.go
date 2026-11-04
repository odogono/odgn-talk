package northtalk

// musicalClockGrant is the reserved Grant name of the Group's musical clock
// (09-embedding.md, The musical clock). No source can name it.
const musicalClockGrant = "musical clock"

// GroupOption is a Group setting beyond GroupOptions, which NewGroup and
// Restore both take.
type GroupOption interface{ groupOption() }

type musicalClockOption struct{ clock *CapabilityDef }

func (musicalClockOption) groupOption() {}

// WithMusicalClock supplies the Group's musical clock (ADR 0166): a
// Capability with one suspending Operation, wait, of one argument and no
// MaxPending. Every Script is granted it under the reserved name "musical
// clock", which LoadOptions.Grants can't use, and a wait in a Musical Unit
// calls it. Without one, such a wait raises `no musical time`. Load refuses
// any other Capability as invalid value.
func WithMusicalClock(clock *CapabilityDef) GroupOption { return musicalClockOption{clock} }

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
		return nil, &HostError{InvalidValue, "\"musical clock\" is a reserved Grant name"}
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
	op, ok := g.musicalClock.ops["wait"]
	if len(g.musicalClock.ops) != 1 || !ok || op.Mode != Suspending || len(op.Args) != 1 || op.MaxPending != 0 {
		return nil, &HostError{InvalidValue, "a musical clock has one suspending wait Operation of one argument, with no MaxPending"}
	}
	return g.musicalClock.Grant([]string{"wait"}, nil)
}
