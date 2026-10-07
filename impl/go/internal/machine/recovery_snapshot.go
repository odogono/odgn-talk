package machine

import (
	"fmt"
	"reflect"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// ValidateSnapshot checks every retained control before rebuilding local aliases.
// Code must come from the restore's identity-checked external reference table.
func (r *Run) ValidateSnapshot(code map[*State]bool) error {
	invalid := func() error { return fmt.Errorf("invalid dispatch snapshot") }
	if r.FrameCounter < 0 || r.OfferAttempt < 0 || r.Cancelling && len(r.Recoveries) > 0 || !r.Cancelling && (len(r.Cancellation) > 0 || len(r.CancellationOwners) > 0) {
		return invalid()
	}
	contexts := map[int]*RecoveryContext{}
	order := map[int]int{}
	frames := map[int]Frame{}
	all := []Frame{}
	add := func(f Frame) { all = append(all, f); frames[f.ID] = f }
	for i, c := range r.Recoveries {
		if c == nil || c.ID <= 0 || c.ID > r.FrameCounter || contexts[c.ID] != nil || len(c.Retained) == 0 || c.Cursor < 0 || c.Cursor >= len(c.Retained) || c.Owner < 0 || c.Owner >= len(c.Retained) || c.Error.Kind != value.Map {
			return invalid()
		}
		contexts[c.ID] = c
		order[c.ID] = i
		for _, f := range c.Retained {
			add(f)
		}
		if c.Activation != nil {
			add(*c.Activation)
		}
		for _, s := range c.Queue {
			add(s.Frame)
		}
		for _, s := range c.Exited {
			add(s.Frame)
		}
	}
	for _, f := range r.CancellationOwners {
		add(f)
	}
	for _, s := range r.Cancellation {
		add(s.Frame)
	}
	for _, f := range r.Frames {
		add(f)
	}
	for _, f := range all {
		if f.ID <= 0 || f.ID > r.FrameCounter || contexts[f.ID] != nil || !code[f.Code] || f.Code.Unit == nil || f.Body < 0 || f.Body >= len(f.Code.Unit.Bodies) {
			return invalid()
		}
		b := f.Code.Unit.Bodies[f.Body]
		if f.PC < 0 || f.PC >= len(b.Code) || len(f.Locals) != len(b.Checked.Locals) {
			return invalid()
		}
		for slot := range f.ReceiverNames {
			if slot < 0 || slot >= len(f.Stack) {
				return invalid()
			}
		}
		localOwner := f.ID
		if f.OwnerID != 0 {
			localOwner = f.OwnerID
		}
		if owner, ok := frames[localOwner]; !ok || !reflect.DeepEqual(f.Locals, owner.Locals) {
			return invalid()
		}
		canonical := frames[f.ID]
		if canonical.Code != f.Code || canonical.Body != f.Body || canonical.OwnerID != f.OwnerID || canonical.ControlID != f.ControlID || canonical.Recovery != f.Recovery {
			return invalid()
		}
		if f.Recovery && (f.OwnerID == 0 || f.ControlID == 0) {
			return invalid()
		}
		for _, id := range []int{f.OwnerID, f.ControlID} {
			if id == 0 {
				continue
			}
			owner, ok := frames[id]
			if !ok || id == f.ID || owner.Code != f.Code || owner.Body != f.Body {
				return invalid()
			}
			seen := map[int]bool{f.ID: true}
			for id != 0 {
				if seen[id] {
					return invalid()
				}
				seen[id] = true
				next, ok := frames[id]
				if !ok {
					return invalid()
				}
				if id == f.OwnerID && next.OwnerID != 0 {
					return invalid()
				}
				id = next.ControlID
			}
		}
	}
	entry := func(f Frame, e lower.UnwindEntry, kind string) bool {
		return e.Kind == kind && slices.Contains(f.Code.Unit.Bodies[f.Body].UnwindEntries(), e)
	}
	scope := func(s RecoveryCleanup) bool {
		return entry(s.Frame, s.Entry, "finally") && slices.Contains(activeEntries(s.Frame), s.Entry) && len(s.Frame.Stack) >= s.Entry.Depth
	}
	for _, s := range r.Cancellation {
		if !scope(s) {
			return invalid()
		}
	}
	for i, c := range r.Recoveries {
		if c.Boundary != nil {
			outer := c.Boundary.Outer
			if outer == nil || contexts[outer.ID] == nil || order[outer.ID] >= i || contexts[outer.ID].Activation == nil || contexts[outer.ID].Activation.ID != c.Boundary.Frame {
				return invalid()
			}
			found := false
			for _, f := range c.Retained {
				if f.ID == c.Boundary.Frame && f.Recovery {
					found = true
				}
			}
			if !found {
				return invalid()
			}
		}
		if c.Activation != nil || c.Entry.Kind != "" {
			if c.Owner < 0 || c.Owner >= len(c.Retained) || c.Owner != c.Cursor || !entry(c.Retained[c.Owner], c.Entry, "catch") || !slices.Contains(activeEntries(c.Retained[c.Owner]), c.Entry) || !c.Seen[c.Retained[c.Owner].ID][c.Entry.Target] {
				return invalid()
			}
		}
		if c.Activation != nil && (!c.Activation.Recovery || c.Activation.ControlID != c.Retained[c.Owner].ID || c.Activation.PC < c.Entry.Target) {
			return invalid()
		}
		if c.Pending == nil {
			if c.Activation == nil || c.CleanupEntry != nil || len(c.Queue) != 0 || !c.Activation.Recovery || c.Activation.ControlID != c.Retained[c.Owner].ID {
				return invalid()
			}
		} else {
			p := c.Pending
			if p.Kind != "catch" && p.Kind != "offer" && p.Kind != "error" || c.CleanupEntry == nil || len(c.Exited) == 0 {
				return invalid()
			}
			last := c.Exited[len(c.Exited)-1]
			if *c.CleanupEntry != last.Entry {
				return invalid()
			}
			cleanup := false
			// Nested recovery may retain the outer transfer's active cleanup cursor.
			for _, f := range all {
				if f.Transfer != nil && f.Transfer.ID == c.ID && entry(f, *c.CleanupEntry, "finally") && f.PC >= c.CleanupEntry.Target && f.PC < cleanupEnd(f, c.CleanupEntry.Target) {
					cleanup = true
				}
			}
			if !cleanup {
				return invalid()
			}
			if p.Kind != "error" {
				if p.Owner < 0 || p.Owner >= len(c.Retained) || c.Entry.Kind != "catch" {
					return invalid()
				}
				f := c.Retained[p.Owner]
				b := f.Code.Unit.Bodies[f.Body]
				if p.PC < 0 || p.PC >= len(b.Code) {
					return invalid()
				}
				if p.Kind == "catch" {
					if p.Owner != c.Owner || c.Activation == nil || p.PC != c.Activation.PC || !reflect.DeepEqual(p.Stack, c.Activation.Stack) || p.PC == 0 || b.Code[p.PC-1].Name != "catch-accept" {
						return invalid()
					}
				} else {
					if p.Attempt <= 0 || p.Attempt > r.OfferAttempt || len(p.Binds) != len(p.Args) {
						return invalid()
					}
					found := false
					for _, e := range activeEntries(f) {
						if e.Kind != "offer" {
							continue
						}
						if e.Target < 0 || e.Target >= len(f.Code.Unit.Offers) {
							return invalid()
						}
						target := f.Code.Unit.Offers[e.Target]
						if target.Body != f.Body {
							return invalid()
						}
						for _, o := range target.Offers {
							if o.Target == p.PC && slices.Equal(o.Binds, p.Binds) && len(p.Stack) == e.Depth {
								found = true
							}
						}
					}
					if !found {
						return invalid()
					}
				}
			}
		}
		seenScopes := map[[2]int]bool{}
		for _, s := range append(slices.Clone(c.Exited), c.Queue...) {
			if !scope(s) || s.Index < 0 || s.Index > len(c.Retained) {
				return invalid()
			}
			if s.Index == len(c.Retained) {
				if !s.Frame.Recovery || s.Frame.ControlID != c.Retained[c.Owner].ID {
					return invalid()
				}
			} else if c.Retained[s.Index].ID != s.Frame.ID {
				return invalid()
			}
			key := [2]int{s.Frame.ID, s.Entry.Target}
			if seenScopes[key] {
				return invalid()
			}
			seenScopes[key] = true
		}
		for id, targets := range c.Seen {
			f, ok := frames[id]
			if !ok {
				return invalid()
			}
			for pc, yes := range targets {
				found := false
				for _, e := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
					if e.Kind == "catch" && e.Target == pc {
						found = true
					}
				}
				if !yes || !found {
					return invalid()
				}
			}
		}
		for id, keys := range c.Excluded {
			f, ok := frames[id]
			if !ok {
				return invalid()
			}
			for key, yes := range keys {
				found := false
				for _, e := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
					if entryKey(e) == key {
						found = true
					}
				}
				if !yes || !found {
					return invalid()
				}
			}
		}
		for id, yes := range c.CleanupOnly {
			if _, ok := frames[id]; !ok || !yes {
				return invalid()
			}
		}
	}
	for _, f := range all {
		if f.Transfer != nil && (contexts[f.Transfer.ID] == nil || contexts[f.Transfer.ID].Pending == nil) {
			return invalid()
		}
	}
	maxAttempt := 0
	chosen := map[int]bool{}
	for _, rec := range r.OfferRecords {
		if rec.Attempt <= 0 || rec.Attempt > r.OfferAttempt {
			return invalid()
		}
		if rec.Kind == "offer-chosen" {
			if chosen[rec.Attempt] {
				return invalid()
			}
			chosen[rec.Attempt] = true
			maxAttempt = max(maxAttempt, rec.Attempt)
		} else if rec.Kind != "offer-entered" || !chosen[rec.Attempt] {
			return invalid()
		}
	}
	if maxAttempt != r.OfferAttempt {
		return invalid()
	}
	return nil
}
