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
	packet   zigPacket
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
type zigReceipt func(zigPacket) error

// okReceipt adapts a receipt of a JSON reply's ok value; needs and errors
// carry none.
func okReceipt(receipt func(zigReply) error) zigReceipt {
	if receipt == nil {
		return nil
	}
	return func(packet zigPacket) error {
		if packet.bin != nil || packet.err.present() {
			return nil
		}
		return receipt(packet.ok)
	}
}

// export serializes guest calls, but leaves admission open while one runs.
// Inline checkpoints serve requests on that export's guest stack. Requests
// arriving after its final checkpoint are served at the export boundary.
// Inline admission carries JSON, so a queued ordinary binary input crosses
// as JSON; a binary worker input waits for the boundary.
func (b *zigGroup) export(out zigOut, receipt zigReceipt) (zigPacket, error) {
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
				return zigPacket{}, err
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
			b.observe(req.packet, req.fields["m"].(string))
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
		b.finishAdmission(req, zigPacket{}, err)
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
			b.finishAdmission(next, zigPacket{}, err)
		} else {
			reply, e := b.frame(zigOut{fields: next.fields, bin: next.bin})
			b.finishAdmission(next, reply, e)
		}
	}
	b.observe(packet, fields["m"].(string))
	return packet, err
}

func (b *zigGroup) finishAdmission(req *zigAdmission, packet zigPacket, err error) {
	b.frameMu.Lock()
	if err == nil && packet.bin == nil {
		if !packet.ref.present() {
			err = fmt.Errorf("inline reply omitted ref")
		} else if ref, ok := packet.ref.int64(); !ok || ref != req.fields["ref"] {
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
	root, err := zigParseReply(data)
	if err != nil {
		return nil, err
	}
	event := zigReadPacket(root)
	if reply := root.get("reply"); reply.present() {
		req := b.inlineRequest
		if req == nil {
			return nil, fmt.Errorf("inline reply without admission")
		}
		b.inlineRequest = nil
		b.inlineWait = append(b.inlineWait, req.finished)
		b.finishAdmission(req, zigReadPacket(reply), nil)
	} else if event.trace.present() || event.need.present() {
		done := make(chan struct{})
		b.inlineWait = append(b.inlineWait, done)
		go func() {
			defer func() { close(done); b.wakeInline() }()
			b.observe(event, "")
			if need := event.need; need.present() {
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
func applyReceipt(packet zigPacket, receipt zigReceipt) error {
	if receipt == nil || packet.need.present() {
		return nil
	}
	return receipt(packet)
}
