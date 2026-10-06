package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"regexp"
	"slices"
)

type RecoveryCleanup struct {
	Frame Frame
	Index int
	Entry lower.UnwindEntry
}
type RecoveryPending struct {
	Kind      string
	Owner, PC int
	Stack     []value.Value
	Binds     []int
	Args      []value.Value
	Attempt   int
}
type RecoveryContext struct {
	ID           int
	Error        value.Value
	Retained     []Frame
	Cursor       int
	Seen         map[int]map[int]bool
	Owner        int
	Entry        lower.UnwindEntry
	Pending      *RecoveryPending
	Queue        []RecoveryCleanup
	CleanupEntry *lower.UnwindEntry
	Activation   *Frame
}
type OfferRecord struct {
	RaiseCount                   int
	Kind, Name, Unit, TargetUnit string
	Attempt, PC, TargetPC        int
	Args                         []value.Value
}

func activeEntries(f Frame) []lower.UnwindEntry {
	pc := f.PC
	if f.Waiting {
		pc--
	}
	entries := []lower.UnwindEntry{}
	for _, entry := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
		if pc >= entry.First && pc <= entry.Last {
			entries = append(entries, entry)
		}
	}
	return entries
}
func (r *Run) realDepth() int {
	frames := map[int]bool{}
	for _, c := range r.Recoveries {
		for _, f := range c.Retained {
			if !f.Recovery {
				frames[f.ID] = true
			}
		}
	}
	for _, f := range r.Frames {
		if !f.Recovery {
			frames[f.ID] = true
		}
	}
	return len(frames)
}
func (r *Run) unwind(err value.Value) {
	if r.Cancelling {
		r.unwindLegacy(err)
		return
	}
	f := &r.Frames[len(r.Frames)-1]
	for _, entry := range activeEntries(*f) {
		if entry.Kind == "offer" {
			continue
		}
		if entry.Kind == "guard" {
			f.PC = entry.Target
			f.Stack = slices.Clone(f.Stack[:entry.Depth])
			return
		}
		break
	}
	if len(r.Recoveries) > 0 {
		outer := r.Recoveries[len(r.Recoveries)-1]
		cleanup := -1
		for j := len(r.Frames) - 1; j >= 0; j-- {
			if r.Frames[j].Transfer == outer {
				cleanup = j
				break
			}
		}
		if cleanup >= 0 {
			local := false
			for j := len(r.Frames) - 1; j >= cleanup; j-- {
				control := r.Frames[j]
				for _, e := range activeEntries(control) {
					if e.Kind == "catch" && (j > cleanup || e.First >= outer.CleanupEntry.Target && e.Last < cleanupEnd(control, outer.CleanupEntry.Target)) {
						local = true
					}
				}
			}
			if !local {
				if !hasKey(err, "during") {
					err.Entries = append(slices.Clone(err.Entries), value.Pair{Key: "during", Val: outer.Error})
				}
				r.Recoveries = r.Recoveries[:len(r.Recoveries)-1]
			}
		}
	}
	r.FrameCounter++
	c := &RecoveryContext{ID: r.FrameCounter, Error: err, Retained: slices.Clone(r.Frames), Cursor: len(r.Frames) - 1, Seen: map[int]map[int]bool{}}
	r.Recoveries = append(r.Recoveries, c)
	r.searchCatch(c)
}
func (r *Run) searchCatch(c *RecoveryContext) {
	left := 0
	for j := c.Cursor; j >= 0; j-- {
		owner := c.Retained[j]
		for _, entry := range activeEntries(owner) {
			if entry.Kind != "catch" || c.Seen[owner.ID][entry.Target] {
				continue
			}
			r.leaveCleanupSearch(c, j, &entry)
			if !r.pay(int64(4*left), 0) {
				return
			}
			c.Cursor = j
			c.Owner = j
			c.Entry = entry
			if c.Seen[owner.ID] == nil {
				c.Seen[owner.ID] = map[int]bool{}
			}
			c.Seen[owner.ID][entry.Target] = true
			activation := owner
			r.FrameCounter++
			activation.ID = r.FrameCounter
			activation.OwnerID = owner.ID
			if owner.OwnerID != 0 {
				activation.OwnerID = owner.OwnerID
			}
			activation.Recovery = true
			activation.Waiting = false
			activation.Clause = false
			activation.PC = entry.Target
			activation.Stack = append(slices.Clone(owner.Stack[:entry.Depth]), c.Error)
			c.Activation = &activation
			r.Frames = append(slices.Clone(c.Retained), activation)
			return
		}
		r.leaveCleanupSearch(c, j, nil)
		left++
	}
	r.AbandonJoin()
	if !r.pay(int64(4*left), 0) {
		return
	}
	c.Pending = &RecoveryPending{Kind: "error"}
	c.Queue = r.exitedCleanups(c, -1, nil)
	r.advanceTransfer(c)
}

// A potential cleanup-local catch may reject; escape is decided by search.
func (r *Run) leaveCleanupSearch(c *RecoveryContext, index int, entry *lower.UnwindEntry) {
	if len(r.Recoveries) < 2 {
		return
	}
	outer := r.Recoveries[len(r.Recoveries)-2]
	cleanup := -1
	for j, f := range c.Retained {
		if f.Transfer == outer {
			cleanup = j
		}
	}
	if cleanup < 0 || index > cleanup {
		return
	}
	if index == cleanup && entry != nil && entry.First >= outer.CleanupEntry.Target && entry.Last < cleanupEnd(c.Retained[index], outer.CleanupEntry.Target) {
		return
	}
	if !hasKey(c.Error, "during") {
		c.Error.Entries = append(slices.Clone(c.Error.Entries), value.Pair{Key: "during", Val: outer.Error})
	}
	r.Recoveries = append(r.Recoveries[:len(r.Recoveries)-2], c)
}

func (r *Run) exitedCleanups(c *RecoveryContext, owner int, stop *lower.UnwindEntry) []RecoveryCleanup {
	queue := []RecoveryCleanup{}
	for j := len(c.Retained) - 1; j >= max(0, owner); j-- {
		f := c.Retained[j]
		for _, entry := range activeEntries(f) {
			if j == owner && stop != nil && entry == *stop {
				break
			}
			if entry.Kind == "finally" {
				queue = append(queue, RecoveryCleanup{f, j, entry})
			}
		}
	}
	return queue
}
func (r *Run) acceptCatch() {
	c := r.Recoveries[len(r.Recoveries)-1]
	f := r.Frames[len(r.Frames)-1]
	c.Activation = &f
	c.Pending = &RecoveryPending{Kind: "catch", Owner: c.Owner, PC: f.PC, Stack: slices.Clone(f.Stack)}
	c.Queue = r.exitedCleanups(c, c.Owner, &c.Entry)
	r.advanceTransfer(c)
}
func (r *Run) nextCatch() {
	c := r.Recoveries[len(r.Recoveries)-1]
	c.Activation = nil
	r.Frames = slices.Clone(c.Retained)
	r.searchCatch(c)
}

type offerLookup struct {
	Frames, Owner int
	Entry         lower.UnwindEntry
	Offer         *lower.OfferDescriptor
}

func (r *Run) lookupOffer(name string) offerLookup {
	found := offerLookup{}
	if len(r.Recoveries) == 0 {
		return found
	}
	c := r.Recoveries[len(r.Recoveries)-1]
	for j := len(c.Retained) - 1; j >= 0; j-- {
		found.Frames++
		f := c.Retained[j]
		for _, entry := range activeEntries(f) {
			if entry.Kind != "offer" {
				continue
			}
			record := f.Code.Unit.Offers[entry.Target]
			for _, offer := range record.Offers {
				if offer.Name == name {
					found.Owner = j
					found.Entry = entry
					found.Offer = &offer
					return found
				}
			}
		}
	}
	return found
}

var offerName = regexp.MustCompile(`^[A-Za-z_]\w*$`)

func validOfferName(name string) bool {
	return name != "_" && offerName.MatchString(name) && !slices.Contains(generated.Grammar.Reserved, name)
}
func (r *Run) chooseOffer(name string, args []value.Value) {
	found := r.lookupOffer(name)
	if !r.pay(int64(4*found.Frames), 0) {
		return
	}
	if found.Offer == nil {
		r.raise(failure("offer unavailable", value.Pair{Key: "name", Val: text(name)}))
		return
	}
	if len(args) != len(found.Offer.Binds) {
		r.raise(failure("wrong arity"))
		return
	}
	c := r.Recoveries[len(r.Recoveries)-1]
	f := &r.Frames[len(r.Frames)-1]
	f.Stack = f.Stack[:len(f.Stack)-len(args)]
	c.Activation = f
	target := c.Retained[found.Owner]
	r.OfferAttempt++
	r.OfferRecords = append(r.OfferRecords, OfferRecord{RaiseCount: len(r.Raises), Kind: "offer-chosen", Attempt: r.OfferAttempt, Name: name, Unit: r.CodeName(), PC: r.PC, TargetUnit: codeName(target.Code, target.Body), TargetPC: target.Code.Unit.Bodies[target.Body].First + found.Offer.Target, Args: slices.Clone(args)})
	c.Pending = &RecoveryPending{Kind: "offer", Owner: found.Owner, PC: found.Offer.Target, Stack: slices.Clone(target.Stack[:found.Entry.Depth]), Binds: found.Offer.Binds, Args: args, Attempt: r.OfferAttempt}
	c.Queue = r.exitedCleanups(c, found.Owner, &found.Entry)
	policyFrame := r.Frames[len(r.Frames)-1]
	inherited := map[int]bool{}
	for _, e := range activeEntries(c.Retained[c.Owner]) {
		if e.Kind == "finally" {
			inherited[e.Target] = true
		}
	}
	policy := []RecoveryCleanup{}
	for _, e := range activeEntries(policyFrame) {
		if e.Kind == "finally" && !inherited[e.Target] {
			policy = append(policy, RecoveryCleanup{policyFrame, len(c.Retained), e})
		}
	}
	c.Queue = append(policy, c.Queue...)
	r.advanceTransfer(c)
}
func (r *Run) advanceTransfer(c *RecoveryContext) {
	if len(c.Queue) > 0 {
		next := c.Queue[0]
		c.Queue = c.Queue[1:]
		c.CleanupEntry = &next.Entry
		f := next.Frame
		if c.Pending.Kind == "offer" && !f.Recovery {
			c.Activation = nil
		}
		f.Transfer = c
		f.Waiting = false
		f.PC = next.Entry.Target
		f.Stack = slices.Clone(f.Stack[:next.Entry.Depth])
		f.Clause = false
		r.Frames = append(slices.Clone(c.Retained[:next.Index]), f)
		return
	}
	p := c.Pending
	r.Recoveries = r.Recoveries[:len(r.Recoveries)-1]
	if p.Kind == "error" {
		r.AbandonJoin()
		r.Frames = nil
		r.Error = c.Error
		r.Status = Errored
		return
	}
	r.leaveJoin(p.Owner, p.PC)
	r.Frames = slices.Clone(c.Retained[:p.Owner+1])
	f := &r.Frames[p.Owner]
	f.PC = p.PC
	f.Stack = p.Stack
	f.Waiting = false
	if p.Kind == "offer" {
		for j, slot := range p.Binds {
			f.Locals[slot] = p.Args[j]
		}
		r.OfferRecords = append(r.OfferRecords, OfferRecord{RaiseCount: len(r.Raises), Kind: "offer-entered", Attempt: p.Attempt, TargetUnit: codeName(f.Code, f.Body), TargetPC: f.Code.Unit.Bodies[f.Body].First + p.PC})
	}
}

func cleanupEnd(f Frame, start int) int {
	body := f.Code.Unit.Bodies[f.Body]
	starts := map[int]bool{}
	for _, e := range body.UnwindEntries() {
		if e.Kind == "finally" {
			starts[e.Target] = true
		}
	}
	depth := 0
	for pc := start; pc < len(body.Code); pc++ {
		if pc != start && starts[pc] {
			depth++
		}
		if body.Code[pc].Name == "end-cleanup" {
			if depth == 0 {
				return pc + 1
			}
			depth--
		}
	}
	return len(body.Code)
}

// RestoreRecoveryLocals rebuilds shared owner storage after the private codec
// has decoded frame values. Complete dispatch snapshot validation is slice 4.
func (r *Run) RestoreRecoveryLocals() {
	contexts := map[int]*RecoveryContext{}
	for _, c := range r.Recoveries {
		contexts[c.ID] = c
	}
	owners := map[int][]value.Value{}
	for _, c := range r.Recoveries {
		for _, f := range c.Retained {
			if f.OwnerID == 0 {
				owners[f.ID] = f.Locals
			}
		}
	}
	for _, f := range r.Frames {
		if f.OwnerID == 0 {
			owners[f.ID] = f.Locals
		}
	}
	link := func(f *Frame) {
		if f.Transfer != nil {
			if c, ok := contexts[f.Transfer.ID]; ok {
				f.Transfer = c
			}
		}
		id := f.ID
		if f.OwnerID != 0 {
			id = f.OwnerID
		}
		if locals, ok := owners[id]; ok {
			f.Locals = locals
		}
	}
	for _, c := range r.Recoveries {
		for i := range c.Retained {
			link(&c.Retained[i])
		}
		if c.Activation != nil {
			link(c.Activation)
		}
		for i := range c.Queue {
			link(&c.Queue[i].Frame)
		}
	}
	for i := range r.Frames {
		link(&r.Frames[i])
	}
}
