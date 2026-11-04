package northtalk

// musicalClockGrant is the reserved Grant name of the Group's musical clock
// (09-embedding.md, The musical clock). No source can name it.
const musicalClockGrant = "musical-clock"

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
// a Capability DefineMusicalClock didn't make as invalid value.
func WithMusicalClock(clock *CapabilityDef) GroupOption { return musicalClockOption{clock} }

// DefineMusicalClock defines a musical clock: a Capability whose one
// Operation, wait, is suspending, of one argument, with no MaxPending. The
// Operation's Name may be left empty. DefineCapability refuses wait as an
// Operation name, since a source can't call it; only a wait in a Musical
// Unit calls this one.
func (c *Core) DefineMusicalClock(name string, wait Operation, options ...CapabilityOption) (*CapabilityDef, error) {
	if wait.Name == "" {
		wait.Name = "wait"
	}
	if wait.Name != "wait" || wait.Mode != Suspending || len(wait.Args) != 1 || wait.MaxPending != 0 || wait.Scope != nil || wait.SegmentBound || wait.Metering != "" || wait.Command {
		return nil, &HostError{InvalidValue, "a musical clock has one suspending wait Operation of one argument, with no MaxPending"}
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
	d, err := c.defineCapabilityAs(name, nil, nil, true, wait)
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
		return nil, &HostError{InvalidValue, "a musical clock is made by DefineMusicalClock"}
	}
	return g.musicalClock.Grant([]string{"wait"}, nil)
}
