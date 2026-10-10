package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"math/big"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// blockDeadline is the innermost Timeout Block deadline on a frame's stack:
// the topmost, which `timeout-start` already made the earliest in force
// (chapter 8, Waiting).
func blockDeadline(stack []value.Value) *value.DeadlineData {
	for i := len(stack) - 1; i >= 0; i-- {
		if stack[i].Kind == value.Deadline {
			return stack[i].Deadline()
		}
	}
	return nil
}

// millis is a duration in nanoseconds as a Quantity in `ms`, with no more
// decimal places than it needs.
func millis(ns *big.Int) value.Value {
	n := new(big.Int).Abs(ns)
	whole, rest := new(big.Int).QuoRem(n, big.NewInt(1_000_000), new(big.Int))
	s := whole.String()
	if rest.Sign() != 0 {
		fraction := strings.TrimRight(leftPad(rest.String(), 6), "0")
		s += "." + fraction
	}
	if ns.Sign() < 0 {
		s = "-" + s
	}
	d, _ := decimal.Parse(s)
	q, _ := value.NewQuantity(d, "ms")
	return q
}

func leftPad(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return strings.Repeat("0", n-len(s)) + s
}

func (r *Run) clock() *big.Int {
	if r.ClockNS == nil {
		return new(big.Int)
	}
	return r.ClockNS
}

// BlockDeadline is the Timeout Block deadline the Run's current Suspension
// Point is written in, if any.
func (r *Run) BlockDeadline() *value.DeadlineData {
	if len(r.Frames) == 0 {
		return nil
	}
	return blockDeadline(r.Frames[len(r.Frames)-1].Stack)
}

// DeadlineError is the `timeout` a Suspension Point reached after its
// block's deadline raises at once, starting nothing (chapter 5, Timeout
// Blocks), or nil while the deadline is still ahead.
func (r *Run) DeadlineError(named ...value.Pair) *value.Value {
	d := r.BlockDeadline()
	if d == nil || d.At.Cmp(r.clock()) > 0 {
		return nil
	}
	err := DeadlineTimeout(d.After, named...)
	return &err
}

// DeadlineTimeout is the error a Timeout Block's deadline raises: `after`,
// a Capability call's `capability` and `operation`, then `deadline: true`.
func DeadlineTimeout(after value.Value, named ...value.Pair) value.Value {
	fields := append([]value.Pair{{Key: "after", Val: after}}, named...)
	fields = append(fields, value.Pair{Key: "deadline", Val: value.Value{Kind: value.Boolean, Bool: true}})
	return failure("timeout", fields...)
}

// pastDeadline reports whether a Suspension Point other than a Capability
// call is reached after its block's deadline. A Join's members aren't
// Suspension Points, and a Join with none doesn't suspend.
func (r *Run) pastDeadline(f *Frame, op generated.Opcode) bool {
	switch op {
	case generated.OpWait, generated.OpWaitFor, generated.OpWaitForAny, generated.OpSendWait, generated.OpSendNamedWait, generated.OpSendSpreadWait, generated.OpSendUpWait:
	case generated.OpJoinEnd:
		if r.Join == nil || len(r.Join.Members) == 0 {
			return false
		}
	default:
		return false
	}
	d := blockDeadline(f.Stack)
	return d != nil && d.At.Cmp(r.clock()) <= 0
}

// Expire ends a suspended wait, `wait for` or Join at its Timeout Block's
// deadline. A Join abandons its members still pending, in start order.
func (r *Run) Expire(after value.Value) {
	if j := r.Join; j != nil {
		for _, m := range j.Members {
			if m.Reply == nil {
				r.Abandons = append(r.Abandons, m.ID)
			}
		}
		j.Failure, j.Index, j.Ready = &SendResume{Timeout: true, Deadline: &after}, 0, true
		return
	}
	r.EventWait = nil
	r.Expired = &after
}

// ResumeExpired raises a deadline's `timeout` at the wait it ended.
func (r *Run) ResumeExpired() {
	after := r.Expired
	if after == nil {
		return
	}
	r.Expired = nil
	r.Frames[len(r.Frames)-1].PC--
	r.raise(DeadlineTimeout(*after))
}
