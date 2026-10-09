package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"regexp"
	"slices"
	"strconv"
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
type RecoveryBoundary struct {
	Frame int
	Outer *RecoveryContext
}
type RecoveryContext struct {
	Boundary     *RecoveryBoundary
	Excluded     map[int]map[string]bool
	CleanupOnly  map[int]bool
	Exited       []RecoveryCleanup
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
	var escapingCleanup *RecoveryContext
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
				escapingCleanup = outer
			}
		}
	}
	r.FrameCounter++
	c := &RecoveryContext{ID: r.FrameCounter, Excluded: map[int]map[string]bool{}, CleanupOnly: map[int]bool{}, Error: err, Retained: slices.Clone(r.Frames), Cursor: len(r.Frames) - 1, Seen: map[int]map[int]bool{}}
	if len(r.Recoveries) > 0 {
		outer := r.Recoveries[len(r.Recoveries)-1]
		if outer.Activation != nil && outer.CleanupEntry == nil {
			for _, control := range r.Frames {
				if control.ID == outer.Activation.ID {
					c.Boundary = &RecoveryBoundary{control.ID, outer}
					break
				}
			}
		}
	}
	r.invalidateDepth()
	r.Recoveries = append(r.Recoveries, c)
	if escapingCleanup != nil {
		r.escapeCleanup(c, escapingCleanup)
	}
	r.searchCatch(c)
}
func (r *Run) searchCatch(c *RecoveryContext) {
	left := 0
search:
	for j := c.Cursor; j >= 0; j-- {
		owner := c.Retained[j]
		if c.Boundary != nil && j < c.boundaryIndex() {
			r.escapePolicy(c)
		}
		for _, entry := range c.dispatchEntries(owner) {
			if entry.Kind != "catch" || c.Seen[owner.ID][entry.Target] {
				continue
			}
			if r.leaveCleanupSearch(c, j, &entry) {
				j++
				continue search
			}
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
			activation.ControlID = owner.ID
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
			r.setFrames(append(slices.Clone(c.Retained), activation))
			return
		}
		if r.leaveCleanupSearch(c, j, nil) {
			j++
			continue search
		}
		if !owner.Recovery && !c.CleanupOnly[owner.ID] {
			left++
		}
	}
	if c.Boundary != nil {
		r.escapePolicy(c)
	}
	r.AbandonJoin()
	if !r.pay(int64(4*left), 0) {
		return
	}
	c.Pending = &RecoveryPending{Kind: "error"}
	c.Queue = r.exitedCleanups(c, -1, nil)
	r.advanceTransfer(c)
}

func entryKey(e lower.UnwindEntry) string {
	return e.Kind + ":" + strconv.Itoa(e.Target)
}
func (c *RecoveryContext) boundaryIndex() int {
	if c.Boundary != nil {
		for j, f := range c.Retained {
			if f.ID == c.Boundary.Frame {
				return j
			}
		}
	}
	return 0
}
func (c *RecoveryContext) dispatchEntries(f Frame) []lower.UnwindEntry {
	inherited := map[string]bool{}
	if c.Boundary != nil && f.ID == c.Boundary.Frame {
		outer := c.Boundary.Outer
		for _, e := range activeEntries(outer.Retained[outer.Owner]) {
			inherited[entryKey(e)] = true
		}
	}
	return slices.DeleteFunc(activeEntries(f), func(e lower.UnwindEntry) bool { return inherited[entryKey(e)] || c.Excluded[f.ID][entryKey(e)] })
}
func (c *RecoveryContext) excludeEntry(f Frame, e lower.UnwindEntry) {
	if c.Excluded[f.ID] == nil {
		c.Excluded[f.ID] = map[string]bool{}
	}
	c.Excluded[f.ID][entryKey(e)] = true
}
func (r *Run) escapePolicy(c *RecoveryContext) {
	outer := c.Boundary.Outer
	if !hasKey(c.Error, "during") {
		c.Error.Entries = append(slices.Clone(c.Error.Entries), value.Pair{Key: "during", Val: outer.Error})
	}
	// The failed original scopes remain for cleanup, but their catches and
	// offers cannot handle a failure escaping their selecting policy.
	for j := len(outer.Retained) - 1; j >= outer.Cursor; j-- {
		f := outer.Retained[j]
		if j > outer.Cursor {
			c.CleanupOnly[f.ID] = true
		}
		for _, e := range activeEntries(f) {
			if e.Kind != "finally" && (j > outer.Cursor || e.First >= outer.Entry.First && e.Last <= outer.Entry.Last) {
				c.excludeEntry(f, e)
			}
		}
	}

	boundary := c.Retained[c.boundaryIndex()]
	for _, e := range activeEntries(outer.Retained[outer.Owner]) {
		c.excludeEntry(boundary, e)
	}
	for id := range outer.CleanupOnly {
		c.CleanupOnly[id] = true
	}
	for id, entries := range outer.Excluded {
		if c.Excluded[id] == nil {
			c.Excluded[id] = map[string]bool{}
		}
		for key := range entries {
			c.Excluded[id][key] = true
		}
	}
	r.discardRecovery(outer)
	c.Boundary = outer.Boundary
}

// A potential cleanup-local catch may reject; escape is decided by search.
func (r *Run) leaveCleanupSearch(c *RecoveryContext, index int, entry *lower.UnwindEntry) bool {
	if len(r.Recoveries) < 2 {
		return false
	}
	outer := r.Recoveries[len(r.Recoveries)-2]
	cleanup := -1
	for j, f := range c.Retained {
		if f.Transfer == outer {
			cleanup = j
		}
	}
	if cleanup < 0 || index > cleanup {
		return false
	}
	if index == cleanup && entry != nil && entry.First >= outer.CleanupEntry.Target && entry.Last < cleanupEnd(c.Retained[index], outer.CleanupEntry.Target) {
		return false
	}
	r.escapeCleanup(c, outer)
	return true
}

func (r *Run) escapeCleanup(c, outer *RecoveryContext) {
	policyCleanup := false
	for _, f := range c.Retained {
		if f.Transfer == outer && f.Recovery {
			policyCleanup = true
			break
		}
	}
	if outer.Pending.Kind == "offer" && policyCleanup {
		for _, f := range c.Retained {
			if f.Transfer == outer {
				c.Boundary = &RecoveryBoundary{f.ID, outer}
				break
			}
		}
		r.escapePolicy(c)
		return
	}
	if !hasKey(c.Error, "during") {
		c.Error.Entries = append(slices.Clone(c.Error.Entries), value.Pair{Key: "during", Val: outer.Error})
	}
	for id, entries := range outer.Excluded {
		if c.Excluded[id] == nil {
			c.Excluded[id] = map[string]bool{}
		}
		for key := range entries {
			c.Excluded[id][key] = true
		}
	}
	for id := range outer.CleanupOnly {
		c.CleanupOnly[id] = true
	}
	c.Boundary = outer.Boundary
	r.discardRecovery(outer)
}

// An aborted transfer must not remain reachable through a retained cleanup
// cursor. The cursor still owns its locals/scopes, but no longer its transfer.
func (r *Run) discardRecovery(outer *RecoveryContext) {
	r.invalidateDepth()
	clear := func(f *Frame) {
		if f.Transfer == outer {
			f.Transfer = nil
		}
	}
	for j, context := range r.Recoveries {
		if context == outer {
			r.Recoveries = slices.Delete(r.Recoveries, j, j+1)
			break
		}
	}
	for j := range r.Frames {
		clear(&r.Frames[j])
	}
	for _, c := range r.Recoveries {
		for j := range c.Retained {
			clear(&c.Retained[j])
		}
		if c.Activation != nil {
			clear(c.Activation)
		}
		for j := range c.Queue {
			clear(&c.Queue[j].Frame)
		}
		for j := range c.Exited {
			clear(&c.Exited[j].Frame)
		}
	}
}

func (r *Run) exitedCleanups(c *RecoveryContext, owner int, stop *lower.UnwindEntry) []RecoveryCleanup {
	queue := []RecoveryCleanup{}
	for j := len(c.Retained) - 1; j >= max(0, owner); j-- {
		f := c.Retained[j]
		for _, entry := range c.dispatchEntries(f) {
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
	r.setFrames(slices.Clone(c.Retained))
	r.searchCatch(c)
}

type offerLookup struct {
	Frames, Owner int
	Entry         lower.UnwindEntry
	Offer         *lower.OfferDescriptor
}

func (r *Run) lookupOffer(name string) offerLookup {
	found := offerLookup{}
	visited := map[int]bool{}
	if len(r.Recoveries) == 0 {
		return found
	}
	c := r.Recoveries[len(r.Recoveries)-1]
	for j := len(c.Retained) - 1; j >= c.boundaryIndex(); j-- {
		f := c.Retained[j]
		if c.CleanupOnly[f.ID] {
			continue
		}
		id := f.ID
		if f.OwnerID != 0 {
			id = f.OwnerID
		}
		if !visited[id] {
			visited[id] = true
			found.Frames++
		}
		for _, entry := range c.dispatchEntries(f) {
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
		c.Exited = append(c.Exited, next)
		c.Queue = c.Queue[1:]
		c.CleanupEntry = &next.Entry
		f := next.Frame
		if f.Recovery {
			for _, owner := range c.Retained {
				if owner.ID == f.ControlID {
					for _, e := range activeEntries(owner) {
						c.excludeEntry(f, e)
					}
					break
				}
			}
		}
		if c.Pending.Kind == "offer" && !f.Recovery {
			c.Activation = nil
		}
		f.Transfer = c
		f.Waiting = false
		f.PC = next.Entry.Target
		f.Stack = slices.Clone(f.Stack[:next.Entry.Depth])
		f.Clause = false
		r.setFrames(append(slices.Clone(c.Retained[:next.Index]), f))
		return
	}
	p := c.Pending
	r.invalidateDepth()
	r.Recoveries = r.Recoveries[:len(r.Recoveries)-1]
	if p.Kind == "error" {
		r.AbandonJoin()
		r.setFrames(nil)
		r.Error = c.Error
		r.Status = Errored
		return
	}
	r.leaveJoin(p.Owner, p.PC)
	r.setFrames(slices.Clone(c.Retained[:p.Owner+1]))
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
// has decoded and validated all control references.
func (r *Run) RestoreRecoveryLocals() {
	r.invalidateDepth()
	contexts := map[int]*RecoveryContext{}
	for _, c := range r.Recoveries {
		contexts[c.ID] = c
	}
	owners := map[int][]value.Value{}
	for _, f := range r.CancellationOwners {
		owners[f.ID] = f.Locals
	}
	for _, scope := range r.Cancellation {
		if scope.Frame.OwnerID == 0 {
			owners[scope.Frame.ID] = scope.Frame.Locals
		}
	}
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
		if c.Boundary != nil {
			if outer, ok := contexts[c.Boundary.Outer.ID]; ok {
				c.Boundary.Outer = outer
			}
		}
		for i := range c.Retained {
			link(&c.Retained[i])
		}
		if c.Activation != nil {
			link(c.Activation)
		}
		for i := range c.Queue {
			link(&c.Queue[i].Frame)
		}
		for i := range c.Exited {
			link(&c.Exited[i].Frame)
		}
	}
	for i := range r.Frames {
		link(&r.Frames[i])
	}
	for i := range r.Cancellation {
		link(&r.Cancellation[i].Frame)
	}
	for i := range r.CancellationOwners {
		link(&r.CancellationOwners[i])
	}
}

// cancellationScopes enumerates control-local scopes before retained failure
// scopes. Activations inherit their owner's scope identities.
func (r *Run) cancellationScopes() []RecoveryCleanup {
	owners := map[int]Frame{}
	for _, c := range r.Recoveries {
		for _, f := range c.Retained {
			owners[f.ID] = f
		}
	}
	for _, f := range r.Frames {
		if _, ok := owners[f.ID]; !ok {
			owners[f.ID] = f
		}
	}
	scopeOwner := func(f Frame, e lower.UnwindEntry) int {
		for f.ControlID != 0 || f.OwnerID != 0 {
			id := f.ControlID
			if id == 0 {
				id = f.OwnerID
			}
			owner, ok := owners[id]
			if !ok {
				break
			}
			inherited := false
			for _, entry := range activeEntries(owner) {
				if entry.Kind == "finally" && entry.Target == e.Target {
					inherited = true
					break
				}
			}
			if !inherited {
				break
			}
			f = owner
		}
		return f.ID
	}
	seen := map[int]map[int]bool{}
	remember := func(f Frame, e lower.UnwindEntry) bool {
		id := scopeOwner(f, e)
		if seen[id] == nil {
			seen[id] = map[int]bool{}
		}
		if seen[id][e.Target] {
			return false
		}
		seen[id][e.Target] = true
		return true
	}
	for _, c := range r.Recoveries {
		for _, scope := range c.Exited {
			remember(scope.Frame, scope.Entry)
		}
	}
	controls := []Frame{}
	for j := len(r.Frames) - 1; j >= 0; j-- {
		controls = append(controls, r.Frames[j])
	}
	for j := len(r.Recoveries) - 1; j >= 0; j-- {
		for i := len(r.Recoveries[j].Retained) - 1; i >= 0; i-- {
			controls = append(controls, r.Recoveries[j].Retained[i])
		}
	}
	blocks := []RecoveryCleanup{}
	for _, f := range controls {
		for _, e := range activeEntries(f) {
			if e.Kind == "finally" && scopeOwner(f, e) == f.ID && remember(f, e) {
				f.Stack = slices.Clone(f.Stack[:e.Depth])
				blocks = append(blocks, RecoveryCleanup{Frame: f, Entry: e})
			}
		}
	}
	return blocks
}
func (r *Run) nextCancellationCleanup() {
	needed := map[int]bool{}
	for _, scope := range r.Cancellation {
		id := scope.Frame.ID
		if scope.Frame.OwnerID != 0 {
			id = scope.Frame.OwnerID
		}
		needed[id] = true
	}
	r.CancellationOwners = slices.DeleteFunc(r.CancellationOwners, func(f Frame) bool { return !needed[f.ID] })
	if len(r.Cancellation) == 0 {
		r.setFrames(nil)
		r.Status = Cancelled
		return
	}
	next := r.Cancellation[0]
	r.Cancellation = r.Cancellation[1:]
	f := next.Frame
	f.Transfer = nil
	f.Waiting = false
	f.PC = next.Entry.Target
	f.Clause = false
	r.setFrames([]Frame{f})
}
