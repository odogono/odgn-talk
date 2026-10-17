//go:build talk_zig_experimental

package northtalk

import (
	"fmt"
)

// A queued admission owns its fields and receipt until the export goroutine
// serves it. No caller touches guest memory or starts a nested export.
type zigAdmission struct {
	fields   map[string]any
	receipt  func(Value) error
	done     chan struct{}
	finished chan struct{}
	packet   Value
	err      error
}

func (b *zigGroup) wakeInline() {
	select {
	case b.inlineWake <- struct{}{}:
	default:
	}
}

// export serializes guest calls, but leaves admission open while one runs.
// Inline checkpoints serve requests on that export's guest stack. Requests
// arriving after its final checkpoint are served at the export boundary.
func (b *zigGroup) export(fields map[string]any, receipt func(Value) error) (Value, error) {
	b.frameMu.Lock()
	if b.exporting {
		req := &zigAdmission{fields: fields, receipt: receipt, done: make(chan struct{}), finished: make(chan struct{})}
		b.admissions = append(b.admissions, req)
		b.frameMu.Unlock()
		b.wakeInline()
		<-req.done
		func() {
			defer func() { close(req.finished); b.wakeInline() }()
			b.observe(req.packet, req.fields["m"].(string))
		}()
		return req.packet, req.err
	}
	b.exporting = true
	b.exportMethod = fields["m"].(string)
	b.frameMu.Unlock()
	b.acquire()
	packet, err := b.frame(fields)
	if req := b.inlineRequest; req != nil {
		b.inlineRequest = nil
		if err == nil {
			err = fmt.Errorf("guest returned without acknowledging inline admission")
		}
		b.finishAdmission(req, Nothing, err)
	}
	b.frameMu.Lock()
	if err == nil {
		err = applyReceipt(packet, receipt)
	}
	b.frameMu.Unlock()
	// Finish late admissions before releasing ownership to another export.
	for {
		b.frameMu.Lock()
		if len(b.admissions) == 0 {
			b.exporting = false
			b.frameMu.Unlock()
			break
		}
		next := b.admissions[0]
		b.admissions = b.admissions[1:]
		b.frameMu.Unlock()
		if err != nil {
			b.finishAdmission(next, Nothing, err)
		} else {
			reply, e := b.frame(next.fields)
			b.finishAdmission(next, reply, e)
		}
	}
	b.releaseIdle(err != nil)
	b.observe(packet, fields["m"].(string))
	return packet, err
}

func (b *zigGroup) finishAdmission(req *zigAdmission, packet Value, err error) {
	b.frameMu.Lock()
	if err == nil {
		n, ok := packet.Get("ref").AsDec()
		if !ok {
			err = fmt.Errorf("inline reply omitted ref")
		} else if ref, e := n.Int64(); e != nil || ref != req.fields["ref"] {
			err = fmt.Errorf("inline reply ref mismatch")
		}
	}
	if err == nil {
		err = applyReceipt(packet, req.receipt)
	}
	b.frameMu.Unlock()
	req.packet, req.err = packet, err
	close(req.done)
}

// inlineEvent is called only by the export goroutine. Sink work runs on a Host
// goroutine; the guest services its inputs until that work has acknowledged.
func (b *zigGroup) inlineEvent(data []byte) ([]byte, error) {
	event, err := DecodeJSON(data)
	if err != nil {
		return nil, err
	}
	if reply := event.Get("reply"); reply.Kind() != KindNothing {
		req := b.inlineRequest
		if req == nil {
			return nil, fmt.Errorf("inline reply without admission")
		}
		b.inlineRequest = nil
		b.inlineWait = append(b.inlineWait, req.finished)
		b.finishAdmission(req, reply, nil)
	} else if event.Get("trace").Kind() != KindNothing || event.Get("need").Kind() != KindNothing {
		done := make(chan struct{})
		b.inlineWait = append(b.inlineWait, done)
		go func() {
			defer func() { close(done); b.wakeInline() }()
			b.observe(event, "")
			if need := event.Get("need"); need.Kind() != KindNothing {
				_, err := b.callback(need)
				if err != nil {
					b.frameMu.Lock()
					b.inlineError = err
					b.frameMu.Unlock()
				}
			}
		}()
	} else {
		// Polls can carry cancellation/settlement notices even without Trace.
		b.observe(event, "")
	}
	for {
		kept := b.inlineWait[:0]
		for _, done := range b.inlineWait {
			select {
			case <-done:
			default:
				kept = append(kept, done)
			}
		}
		b.inlineWait = kept
		b.frameMu.Lock()
		if b.inlineError != nil {
			err := b.inlineError
			b.frameMu.Unlock()
			return nil, err
		}
		if len(b.admissions) > 0 {
			req := b.admissions[0]
			b.admissions = b.admissions[1:]
			b.inlineRequest = req
			b.frameMu.Unlock()
			return zigJSON(nil, req.fields)
		}
		b.frameMu.Unlock()
		if len(b.inlineWait) == 0 {
			return []byte("null"), nil
		}
		<-b.inlineWake
	}
}

// applyReceipt records a completed reply's ok value; needs and errors carry none.
func applyReceipt(packet Value, receipt func(Value) error) error {
	if receipt == nil || packet.Get("need").Kind() != KindNothing || packet.Get("err").Kind() != KindNothing {
		return nil
	}
	return receipt(packet.Get("ok"))
}
