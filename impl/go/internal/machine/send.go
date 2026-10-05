package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// SendResume keeps a Script reply or Capability settlement until the next turn.
// Receiver failures retain their Error map; Capability failures retain Data.
// Timeout retains no Value. Host handles remain in the Group.
type SendResume struct {
	Capability     bool
	FailureCode    string
	FailureMessage string
	FailureData    value.Value
	Failed         bool
	Call           string
	Fuel           int64
	Answer         value.Value
	Reason         string
	Error          value.Value
	Timeout        bool
	AfterMS        int64
}

// SettleSend replaces the pending call's logical size with its resumption.
func (r *Run) SettleSend(p SendResume) {
	r.SendWait = false
	r.SendResume = &p
}

// ResumeOperationFunc is a turn-only adapter for validation and conversion.
type ResumeOperationFunc func(SendResume) (value.Value, *value.Value)

// ResumeSendOperation applies a reply in the new Segment, before Script code.
func (r *Run) ResumeSendOperation(resume ResumeOperationFunc) {
	p := r.SendResume
	if p == nil {
		return
	}
	r.SendResume = nil
	r.OperationWait = false
	f := &r.Frames[len(r.Frames)-1]
	if p.Capability {
		f.PC--
		answer, err := resume(*p)
		if r.Status != Running {
			return
		}
		if err != nil {
			r.raise(*err)
		} else {
			f.PC++
			f.Stack = append(f.Stack, answer)
		}
		return
	}
	if p.Reason == "" && !p.Timeout {
		f.Stack = append(f.Stack, p.Answer)
		return
	}
	f.PC--
	r.raise(sendResumeError(*p))
}

func sendResumeError(p SendResume) value.Value {
	if p.Timeout {
		after, _ := value.NewQuantity(decimal.FromInt(p.AfterMS), "ms")
		return failure("timeout", value.Pair{Key: "after", Val: after})
	}
	fields := []value.Pair{{Key: "reason", Val: text(p.Reason)}}
	if p.Error.Kind != value.Nothing {
		fields = append(fields, value.Pair{Key: "error", Val: p.Error})
	}
	return failure("send failed", fields...)
}

func (r *Run) ResumeSend() { r.ResumeSendOperation(nil) }

// MailboxFull constructs the ordinary send error using the resolved receiver.
// Script-name tokens become Text; Host Object receivers retain their identity.
func MailboxFull(to value.Value) *value.Value {
	err := failure("mailbox full", value.Pair{Key: "to", Val: to})
	return &err
}
