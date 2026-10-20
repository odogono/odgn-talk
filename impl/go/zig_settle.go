//go:build !talk_native_go

package northtalk

// Queued settlements (#1320). With settlements-fields-v1, Call.Answer and
// Call.Fail queue their input, as native does, and the next binary Pump
// carries the queue in its settle-pump frame instead of one export each.
// Any other input first sends the queue as ordinary answer and fail inputs,
// so the guest's input order stays the Host's.

const zigSettlementsFeature = "settlements-fields-v1"

// zigQueueFeature moves queued Deliveries, Broadcasts and Decisions to the
// fields envelope (#1374).
const zigQueueFeature = "queue-fields-v1"

// zigSettlement is one queued answer or fail: its settle-pump list item, and
// its ordinary input for a flush.
type zigSettlement struct {
	item   []byte
	kind   string
	fields map[string]any
}

// queueSettlement encodes a settlement now, so a foreign Value still panics
// in Answer or Fail, and queues it for the next Pump.
func (b *zigGroup) queueSettlement(c *Call, kind string, v Value, e *ScriptError, fuel int64, fields map[string]any) error {
	w := &zbWriter{}
	w.begin(zbSettlement, true)
	w.key("call")
	w.ptext(string(c.id))
	w.key("outcome")
	w.ptext(kind)
	if kind == "answer" {
		w.key("value")
		if err := b.zbValue(w, v); err != nil {
			return err
		}
		if fuel != 0 {
			w.key("fuel")
			w.int(fuel)
		}
	} else if _, ok := fields["error"]; ok {
		// As the JSON input, a failure without its envelope fails as broken.
		w.key("value")
		if err := b.zbValue(w, e.Data); err != nil {
			return err
		}
		w.key("code")
		w.ptext(e.Code)
		if e.Message != "" {
			w.key("message")
			w.ptext(e.Message)
		}
	}
	w.end()
	b.settlementsMu.Lock()
	b.settlements = append(b.settlements, zigSettlement{item: w.buf, kind: kind, fields: fields})
	b.settlementsMu.Unlock()
	return nil
}

// takeSettlements is called as a Pump frame is committed. While another
// input is flushing the queue ahead of itself, the Pump leaves it alone.
func (b *zigGroup) takeSettlements() []zigSettlement {
	b.settlementsMu.Lock()
	defer b.settlementsMu.Unlock()
	if b.flushing != 0 {
		return nil
	}
	taken := b.settlements
	b.settlements = nil
	return taken
}

// requeueSettlements puts a refused settle-pump's settlements back ahead
// of any queued since.
func (b *zigGroup) requeueSettlements(taken []zigSettlement) {
	if len(taken) == 0 {
		return
	}
	b.settlementsMu.Lock()
	b.settlements = append(taken, b.settlements...)
	b.settlementsMu.Unlock()
}

// flushSettlements sends queued settlements as ordinary inputs, ahead of
// an input that isn't a Pump carrying them.
func (b *zigGroup) flushSettlements() error {
	b.settlementsMu.Lock()
	if len(b.settlements) == 0 {
		b.settlementsMu.Unlock()
		return nil
	}
	b.flushing++
	defer func() {
		b.settlementsMu.Lock()
		b.flushing--
		b.settlementsMu.Unlock()
	}()
	for len(b.settlements) != 0 {
		next := b.settlements[0]
		b.settlements = b.settlements[1:]
		b.settlementsMu.Unlock()
		if _, err := b.send(next.kind, next.fields); err != nil {
			return err
		}
		b.settlementsMu.Lock()
	}
	b.settlementsMu.Unlock()
	return nil
}

// settlementsItem is a settle-pump's last field: Nothing, or its list.
func settlementsItem(taken []zigSettlement) []byte {
	if len(taken) == 0 {
		return []byte{0x00}
	}
	w := &zbWriter{}
	w.list(len(taken))
	for _, s := range taken {
		w.buf = append(w.buf, s.item...)
	}
	return w.buf
}
