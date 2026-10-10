package machine

import (
	"math/big"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// EventWait is retained Run data. Tests use the captures taken at registration;
// their Variables are read from the Script at observation, before dispatch.
type EventWait struct {
	Kind     string
	Branches []EventBranch
	Values   []value.Value
	Deadline *big.Int
	Branch   int // earliest after branch, or zero for a one-line timeout
}
type EventBranch struct {
	Entry    lower.EventBranch
	From     value.Value
	Captures []value.Value
}

type EventResume struct {
	Kind     string
	Message  value.Value
	Bindings []value.Value
	Slots    []int
	Branch   int
	Timeout  bool
}

func eventValueCount(e lower.Event) int {
	n := 0
	if e.Timeout {
		n++
	}
	for _, b := range e.Branches {
		n += b.Captures
		if b.From || b.After {
			n++
		}
	}
	return n
}

func (r *Run) eventWait(kind string, entry lower.Event, vs []value.Value) (*EventWait, *value.Value) {
	w := &EventWait{Kind: kind}
	clock := r.ClockNS
	if clock == nil {
		clock = new(big.Int)
	}
	deadline := func(v value.Value, branch int) *value.Value {
		ns, err := waitNanos(v)
		if err != nil {
			return err
		}
		d := new(big.Int).Add(clock, ns)
		if w.Deadline == nil || d.Cmp(w.Deadline) < 0 {
			w.Deadline, w.Branch = d, branch
		}
		return nil
	}
	j := 0
	for index, b := range entry.Branches {
		p := EventBranch{Entry: b}
		if b.After {
			if err := deadline(vs[j], index+1); err != nil {
				return nil, err
			}
			j++
		} else {
			if b.From {
				p.From = vs[j]
				j++
				if b.FromScript == "" {
					if p.From.Kind != value.Object {
						err := wrong("object", p.From)
						return nil, &err
					}
					w.Values = append(w.Values, p.From)
				}
			}
			p.Captures = slices.Clone(vs[j : j+b.Captures])
			j += b.Captures
			w.Values = append(w.Values, p.Captures...)
		}
		w.Branches = append(w.Branches, p)
	}
	if entry.Timeout {
		if err := deadline(vs[j], 0); err != nil {
			return nil, err
		}
	}
	return w, nil
}

// Observe tests every eligible branch in source order, uncapped for Fuel and
// allocation. Its costs belong to the waiting Run and to this Pump. A failed
// test leaves bindings untouched; a match retains the message until resumption.
func (r *Run) Observe(name string, args []value.Value, target value.Value, sender string) (fuel, alloc int64, matched bool) {
	w := r.EventWait
	if w == nil {
		return
	}
	for j, branch := range w.Branches {
		b := branch.Entry
		if b.After || b.Message != name {
			continue
		}
		if b.From && (b.FromScript != "" && b.FromScript != sender || b.FromScript == "" && !branch.From.Equal(target)) {
			continue
		}
		var bindings []value.Value
		if b.Body < 0 {
			if len(args) != 0 {
				continue
			}
		} else {
			body := r.State.Unit.Bodies[b.Body].Checked
			if len(args) != len(body.Node.Params) {
				continue
			}
			test := Start(r.State, b.Body, args, Limits{Depth: r.Limits.Depth, Pattern: r.Limits.Pattern})
			for index, capture := range body.Captures {
				test.Frames[0].Locals[body.Slot(capture.Name)] = branch.Captures[index]
			}
			test.Execute(0)
			fuel += test.Fuel
			alloc += test.Alloc
			r.Raises = append(r.Raises, test.Raises...)
			if test.Status != Completed {
				continue
			}
			bindings = test.Result.Items()
		}
		message, _ := value.NewMap([]value.Pair{{Key: "name", Val: text(name)}, {Key: "args", Val: value.NewList(args)}})
		r.EventResume = &EventResume{Kind: w.Kind, Message: message, Bindings: bindings, Slots: b.Binds, Branch: j + 1}
		r.EventWait = nil
		matched = true
		break
	}
	r.Fuel += fuel
	r.Alloc += alloc
	return
}

func (r *Run) resumeEvent() {
	p := r.EventResume
	f := &r.Frames[len(r.Frames)-1]
	for index, slot := range p.Slots {
		f.Locals[slot] = p.Bindings[index]
	}
	f.Stack = append(f.Stack, p.Message)
	if p.Kind == "wait-for-any" {
		f.Stack = append(f.Stack, integer(int64(p.Branch)))
	}
	r.EventResume = nil
}
func (r *Run) TimeoutEvent() {
	r.EventResume = &EventResume{Kind: r.EventWait.Kind, Branch: r.EventWait.Branch, Timeout: true}
	r.EventWait = nil
}
