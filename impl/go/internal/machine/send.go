package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// SendResume keeps an answer or receiver failure until the sender's next turn.
// Failed replies retain only the receiver's error map; timeout retains no Value.
type SendResume struct {
	Answer  value.Value
	Reason  string
	Error   value.Value
	Timeout bool
	AfterMS int64
}

// SettleSend replaces the pending call's logical size with its resumption.
func (r *Run) SettleSend(p SendResume) {
	r.SendWait = false
	r.SendResume = &p
}

// ResumeSend runs after the scheduler starts the new Segment and accounts its
// charges. Failures unwind at the send instruction, before any following code.
func (r *Run) ResumeSend() {
	p := r.SendResume
	if p == nil {
		return
	}
	r.SendResume = nil
	f := &r.Frames[len(r.Frames)-1]
	if p.Reason == "" && !p.Timeout {
		f.Stack = append(f.Stack, p.Answer)
		return
	}
	f.PC--
	if p.Timeout {
		after, _ := value.NewQuantity(decimal.FromInt(p.AfterMS), "ms")
		r.raise(failure("timeout", value.Pair{Key: "after", Val: after}))
		return
	}
	fields := []value.Pair{{Key: "reason", Val: text(p.Reason)}}
	if p.Error.Kind != value.Nothing {
		fields = append(fields, value.Pair{Key: "error", Val: p.Error})
	}
	r.raise(failure("send failed", fields...))
}
