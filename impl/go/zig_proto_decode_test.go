//go:build talk_zig_experimental

package northtalk

// PROTOTYPE, #1103 spike only; not for main. It compares the adapter's
// current decoding of a Request's Pump reply with a toy binary frame carrying
// the same four Reports, and with building those Reports from nothing:
//
//	CGO_ENABLED=0 go -C impl/go test -tags talk_zig_experimental -run '^$' -bench BenchmarkProtoDecode -benchmem

import (
	"encoding/binary"
	"testing"
)

var protoPumpReply = []byte(`{"ref":5,"ok":{"state":"idle","nextDeadline":null,"fuelUsed":12,"gone":[],"reports":[{"kind":"run started","script":"s","run":"s/r1","args":[41],"rootDelivery":"d1","delivery":"d1","selector":"ping"},{"kind":"run end","script":"s","run":"s/r1","delivery":"d1","handler":"ping","outcome":"completed","result":42,"fuel":12,"alloc":16},{"kind":"run accounting","script":"s","run":"s/r1","fuel":12,"state":"terminal","rootDelivery":"d1"},{"kind":"causal work","rootDelivery":"d1","liveRuns":0,"queuedMessages":0,"discardedMessages":0}],"abandoned":[],"settled":[]}}`)

// The toy frame: a Report count, then per Report a kind byte and its fields
// as uvarint-prefixed text and varint numbers, in a fixed order. Values are
// integers only.
func protoBinaryReply() []byte {
	var out []byte
	text := func(s string) { out = binary.AppendUvarint(out, uint64(len(s))); out = append(out, s...) }
	num := func(n int64) { out = binary.AppendVarint(out, n) }
	num(12) // fuelUsed
	num(4)
	out = append(out, 1)
	text("s")
	text("s/r1")
	text("d1")
	text("d1")
	text("ping")
	num(1)
	num(41)
	out = append(out, 2)
	text("s")
	text("s/r1")
	text("d1")
	text("ping")
	num(0)
	num(42)
	num(12)
	num(16)
	out = append(out, 3)
	text("s")
	text("s/r1")
	text("d1")
	text("terminal")
	num(12)
	out = append(out, 4)
	text("d1")
	num(0)
	num(0)
	num(0)
	return out
}

type protoReader struct {
	b []byte
	i int
}

func (r *protoReader) text() string {
	n, k := binary.Uvarint(r.b[r.i:])
	r.i += k
	s := string(r.b[r.i : r.i+int(n)])
	r.i += int(n)
	return s
}
func (r *protoReader) num() int64 {
	n, k := binary.Varint(r.b[r.i:])
	r.i += k
	return n
}

func protoDecodeBinary(data []byte) PumpResult {
	r := &protoReader{b: data}
	result := PumpResult{State: Idle, FuelUsed: r.num()}
	n := r.num()
	result.Reports = make([]Report, 0, n)
	for range n {
		kind := r.b[r.i]
		r.i++
		switch kind {
		case 1:
			s := &RunStarted{Script: r.text(), Run: RunID(r.text())}
			s.RootDelivery, s.Delivery, s.Selector = DeliveryID(r.text()), DeliveryID(r.text()), r.text()
			s.Args = make([]Value, r.num())
			for i := range s.Args {
				s.Args[i] = Int(r.num())
			}
			result.Reports = append(result.Reports, s)
		case 2:
			e := &RunEnd{Script: r.text(), Run: RunID(r.text()), Delivery: DeliveryID(r.text()), Handler: r.text()}
			e.Outcome, e.Result, e.Fuel, e.Alloc = Outcome(r.num()), Int(r.num()), r.num(), r.num()
			result.Reports = append(result.Reports, e)
		case 3:
			a := &RunAccounting{Script: r.text(), Run: RunID(r.text())}
			a.RootDelivery, a.State, a.Fuel = DeliveryID(r.text()), r.text(), r.num()
			result.Reports = append(result.Reports, a)
		case 4:
			result.Reports = append(result.Reports, &CausalWork{RootDelivery: DeliveryID(r.text()), LiveRuns: r.num(), QueuedMessages: r.num(), DiscardedMessages: r.num()})
		}
	}
	return result
}

func protoConstruct() PumpResult {
	return PumpResult{State: Idle, FuelUsed: 12, Reports: []Report{
		&RunStarted{RunAncestry: RunAncestry{RootDelivery: "d1"}, Script: "s", Run: "s/r1", Delivery: "d1", Selector: "ping", Args: []Value{Int(41)}},
		&RunEnd{Script: "s", Run: "s/r1", Delivery: "d1", Handler: "ping", Outcome: Completed, Result: Int(42), Fuel: 12, Alloc: 16},
		&RunAccounting{RunAncestry: RunAncestry{RootDelivery: "d1"}, Script: "s", Run: "s/r1", Fuel: 12, State: "terminal"},
		&CausalWork{RootDelivery: "d1"},
	}}
}

// protoSettle is pumpReceipt's bookkeeping for these Reports.
func (b *zigGroup) protoSettle(result PumpResult) {
	b.pendingMu.Lock()
	defer b.pendingMu.Unlock()
	for _, report := range result.Reports {
		switch r := report.(type) {
		case *RunStarted:
			b.runs[r.Run] = r.Delivery
		case *RunEnd:
			delete(b.runs, r.Run)
			if p := b.pending[r.Delivery]; p != nil {
				delete(b.pending, r.Delivery)
				p.settle(r.Result, nil)
			}
		}
	}
}

func BenchmarkProtoDecode(b *testing.B) {
	g := New().NewGroup(GroupOptions{Name: "request"})
	zb := g.backend.(*zigGroup)
	want := Int(42)
	check := func(b *testing.B, p *Pending) {
		if v, failure := p.Result(); failure != nil || !v.Equal(want) {
			b.Fatalf("result %v, failure %v", v, failure)
		}
	}
	register := func() *Pending {
		p := &Pending{done: make(chan struct{})}
		zb.pendingMu.Lock()
		zb.pending["d1"] = p
		zb.pendingMu.Unlock()
		return p
	}
	b.Run("json-current", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			p := register()
			root, err := zigParseReply(protoPumpReply)
			if err != nil {
				b.Fatal(err)
			}
			packet := zigReadPacket(root)
			zb.observe(packet, "pump")
			if _, err := zb.pumpReceipt(packet.ok); err != nil {
				b.Fatal(err)
			}
			check(b, p)
		}
	})
	data := protoBinaryReply()
	b.Run("binary", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			p := register()
			zb.protoSettle(protoDecodeBinary(data))
			check(b, p)
		}
	})
	b.Run("construct-only", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			p := register()
			zb.protoSettle(protoConstruct())
			check(b, p)
		}
	})
}
