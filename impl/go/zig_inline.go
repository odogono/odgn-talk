//go:build talk_zig_experimental

package northtalk

import (
	"fmt"
	"slices"
)

// zigNull acknowledges an inline event; inlineIO copies it.
var zigNull = []byte("null")

// A queued admission owns its fields and receipt until the export goroutine
// serves it. No caller touches guest memory or starts a nested export.
type zigAdmission struct {
	fields   map[string]any
	bin      *zbFrame // a binary worker input, served only at the boundary
	receipt  zigReceipt
	done     chan struct{}
	finished chan struct{}
	packet   zigResponse
	err      error
}

func (b *zigGroup) wakeInline() {
	select {
	case b.inlineWake <- struct{}{}:
	default:
	}
}

// zigOut is one outgoing frame: fields, or for a binary input (#1245) the
// frame whose ref fields carries.
type zigOut struct {
	fields map[string]any
	bin    *zbFrame
}

// zigReceipt records a completed reply under the receipt lock.
type zigReceipt func(zigResponse) error

// okReceipt adapts a receipt of a JSON reply's ok value; needs and errors
// carry none.
func okReceipt(receipt func(zigReply) error) zigReceipt {
	if receipt == nil {
		return nil
	}
	return func(packet zigResponse) error {
		if packet.failure != nil {
			return nil
		}
		return receipt(packet.body)
	}
}

// export serializes guest calls, but leaves admission open while one runs.
// Inline checkpoints serve requests on that export's guest stack. Requests
// arriving after its final checkpoint are served at the export boundary.
// Inline admission carries JSON, so a queued ordinary binary input crosses
// as JSON; a binary worker input waits for the boundary.
func (b *zigGroup) export(out zigOut, receipt zigReceipt) (zigResponse, error) {
	fields := out.fields
	b.frameMu.Lock()
	if out.bin != nil && out.bin.sent != nil {
		out.bin.sent()
	}
	if b.exporting {
		if out.bin != nil && !out.bin.worker {
			json, err := out.bin.json()
			if err != nil {
				b.frameMu.Unlock()
				return zigResponse{}, err
			}
			json["m"], json["ref"], json["group"] = fields["m"], fields["ref"], fields["group"]
			fields, out = json, zigOut{fields: json}
		}
		req := &zigAdmission{fields: fields, bin: out.bin, receipt: receipt, done: make(chan struct{}), finished: make(chan struct{})}
		b.admissions = append(b.admissions, req)
		b.frameMu.Unlock()
		b.wakeInline()
		<-req.done
		func() {
			defer func() { close(req.finished); b.wakeInline() }()
			b.observe(req.packet)
		}()
		return req.packet, req.err
	}
	b.exporting = true
	b.exportMethod = fields["m"].(string)
	b.correlate(fields)
	b.frameMu.Unlock()
	packet, err := b.frame(out)
	if req := b.inlineRequest; req != nil {
		b.inlineRequest = nil
		if err == nil {
			err = fmt.Errorf("guest returned without acknowledging inline admission")
		}
		b.finishAdmission(req, zigResponse{}, err)
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
		b.correlate(next.fields)
		b.frameMu.Unlock()
		if err != nil {
			b.finishAdmission(next, zigResponse{}, err)
		} else {
			reply, e := b.frame(zigOut{fields: next.fields, bin: next.bin})
			b.finishAdmission(next, reply, e)
		}
	}
	b.observe(packet)
	return packet, err
}

func (b *zigGroup) finishAdmission(req *zigAdmission, packet zigResponse, err error) {
	b.frameMu.Lock()
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
	var ref int64
	var sent string
	if req := b.inlineRequest; req != nil {
		ref, sent = req.fields["ref"].(int64), req.fields["m"].(string)
	}
	event, ack, err := b.replyReader().readInline(data, ref, sent)
	if err != nil {
		return nil, err
	}
	if ack {
		req := b.inlineRequest
		if req == nil {
			return nil, fmt.Errorf("inline reply without admission")
		}
		b.inlineRequest = nil
		b.inlineWait = append(b.inlineWait, req.finished)
		b.finishAdmission(req, event, nil)
	} else if len(event.trace) > 0 || event.need != nil {
		done := make(chan struct{})
		b.inlineWait = append(b.inlineWait, done)
		go func() {
			defer func() { close(done); b.wakeInline() }()
			b.observe(event)
			if need := event.need; need != nil {
				_, _, err := b.callback(need)
				if err != nil {
					b.frameMu.Lock()
					b.inlineError = err
					b.frameMu.Unlock()
				}
			}
		}()
	} else {
		// Polls can carry cancellation/settlement notices even without Trace.
		b.observe(event)
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
		// A binary worker input waits for the boundary; JSON inputs behind it
		// are still served, so an inline callback's admission can't deadlock.
		if i := slices.IndexFunc(b.admissions, func(a *zigAdmission) bool { return a.bin == nil }); i >= 0 {
			req := b.admissions[i]
			b.admissions = slices.Delete(b.admissions, i, i+1)
			b.inlineRequest = req
			b.correlate(req.fields)
			b.frameMu.Unlock()
			return zigJSON(nil, req.fields)
		}
		b.frameMu.Unlock()
		if len(b.inlineWait) == 0 {
			return zigNull, nil
		}
		<-b.inlineWake
	}
}

// applyReceipt records a completed reply; needs carry none.
func applyReceipt(packet zigResponse, receipt zigReceipt) error {
	if receipt == nil || packet.need != nil {
		return nil
	}
	return receipt(packet)
}
