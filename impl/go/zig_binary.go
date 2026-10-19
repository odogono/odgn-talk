//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"time"
	"unicode/utf8"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// New guests negotiate the accepted fields envelope. An explicit empty
// TALK_ZIG_REQUEST_PUMP keeps JSON for compatibility checks.
var zigRequestPump = func() string {
	if layout, ok := os.LookupEnv("TALK_ZIG_REQUEST_PUMP"); ok {
		return layout
	}
	return "fields"
}()

// zbFields is the fields layout byte, the only binary layout (#1334).
const zbFields byte = 1

var zbPrefix = []byte("NTB\x01")

// zigRequestPumpFeature is the hello feature for zigRequestPump, if any.
func zigRequestPumpFeature() (string, bool, error) {
	switch zigRequestPump {
	case "":
		return "", false, nil
	case "fields":
		return "request-pump-fields-v1", true, nil
	}
	return "", false, fmt.Errorf("TALK_ZIG_REQUEST_PUMP must be fields or empty, not %q", zigRequestPump)
}

// Fields-candidate message tags and positional fields.
const (
	zbRequest     byte = 0x01
	zbCall        byte = 0x02
	zbPump        byte = 0x03
	zbRequestPump byte = 0x04
	zbCallPump    byte = 0x05
	zbSettlePump  byte = 0x0a
	zbAdmission   byte = 0x81
	zbCompletion  byte = 0x82
)

var zbMessages = map[byte]struct {
	name   string
	fields []string
}{
	zbRequest:     {"request", []string{"ref", "group", "to", "message"}},
	zbCall:        {"call", []string{"ref", "group", "fn", "args", "limits"}},
	zbPump:        {"pump", []string{"ref", "group", "now", "fuelSlice", "fuelCap"}},
	zbRequestPump: {"request-pump", []string{"ref", "group", "token", "to", "message", "now", "fuelSlice", "fuelCap"}},
	zbCallPump:    {"call-pump", []string{"ref", "group", "token", "fn", "args", "limits", "now", "fuelSlice", "fuelCap"}},
	zbSettlePump:  {"settle-pump", []string{"ref", "group", "now", "fuelSlice", "fuelCap", "settlements"}},
	zbAdmission:   {"", []string{"ref", "delivery", "err", "abandoned", "settled", "trace"}},
	zbCompletion:  {"", []string{"ref", "delivery", "token", "state", "nextDeadline", "fuelUsed", "reports", "gone", "err", "abandoned", "settled", "trace"}},
}

// zbReports are the specialized Reports, by tag − 1, with their JSON kind.
var zbReports = []struct {
	kind   string
	fields []string
}{
	{"run end", []string{"script", "run", "delivery", "broadcast", "handler", "fallback", "climbed", "outcome", "result", "error", "limit", "effect", "cleanupFailed", "at", "fuel", "alloc"}},
	{"run started", []string{"script", "run", "args", "rootDelivery", "parentRun", "parentCall", "delivery", "selector", "fn"}},
	{"run discarded", []string{"script", "run", "reason", "rootDelivery", "parentRun", "parentCall"}},
	{"run accounting", []string{"script", "run", "fuel", "state", "rootDelivery", "parentRun", "parentCall"}},
	{"causal work", []string{"rootDelivery", "liveRuns", "queuedMessages", "discardedMessages"}},
	{"stop", []string{"script", "reason", "discardedRuns", "droppedMessages", "pendingCalls"}},
	{"unhandled", []string{"delivery", "message", "target"}},
	{"call failed", []string{"script", "call", "operation", "detail"}},
	{"effect failure", []string{"script", "run", "grant", "segment", "phase", "status", "scope"}},
	{"decided", []string{"delivery", "broadcast", "verdict", "vetoes", "undecided"}},
	{"host error", []string{"code", "detail"}},
	{"charge result", []string{"request", "call", "fuel", "status"}},
}

// zbWriter writes a frame. A record is a map of its present fields, or a
// fields-candidate list whose positions are its field names, absent ones
// Nothing. Every record has at most 16 fields: a map's count is one byte.
type zbWriter struct {
	buf  []byte
	recs []zbRecord
}

type zbRecord struct {
	at          int
	names       []string
	next, count int
	positional  bool
}

func (w *zbWriter) uvarint(n uint64) { w.buf = binary.AppendUvarint(w.buf, n) }

func (w *zbWriter) begin(names []string, positional bool) {
	if positional {
		w.buf = append(w.buf, 0x06, byte(len(names)))
	} else {
		w.buf = append(w.buf, 0x07, 0)
	}
	w.recs = append(w.recs, zbRecord{at: len(w.buf) - 1, names: names, positional: positional})
}

func (w *zbWriter) key(name string) {
	r := &w.recs[len(w.recs)-1]
	if !r.positional {
		r.count++
		w.buf = append(w.buf, 0x05)
		w.uvarint(uint64(len(name)))
		w.buf = append(w.buf, name...)
		return
	}
	for r.next < len(r.names) && r.names[r.next] != name {
		w.buf = append(w.buf, 0x00)
		r.next++
	}
	if r.next == len(r.names) {
		panic("talk: binary field " + name + " out of order")
	}
	r.next++
}

func (w *zbWriter) end() {
	r := w.recs[len(w.recs)-1]
	w.recs = w.recs[:len(w.recs)-1]
	if r.positional {
		for ; r.next < len(r.names); r.next++ {
			w.buf = append(w.buf, 0x00)
		}
		return
	}
	w.buf[r.at] = byte(r.count)
}

func (w *zbWriter) ptext(s string) {
	w.buf = append(w.buf, 0x12)
	w.uvarint(uint64(len(s)))
	w.buf = append(w.buf, s...)
}

func (w *zbWriter) int(n int64) { w.buf = zbAppendInt(w.buf, n) }

func zbAppendInt(out []byte, n int64) []byte {
	if n < 0 {
		return binary.AppendUvarint(append(out, 0x10), uint64(-(n+1))+1)
	}
	return binary.AppendUvarint(append(out, 0x03), uint64(n))
}

func (w *zbWriter) list(n int) {
	w.buf = append(w.buf, 0x06)
	w.uvarint(uint64(n))
}

// instant is a Clock, already checked to lie in years 1–9999.
func (w *zbWriter) instant(t time.Time) {
	n := t.UnixMicro()
	w.buf = append(w.buf, 0x0b)
	w.uvarint(uint64(n<<1) ^ uint64(n>>63))
}

// zbFrame is a binary input around the ref its exchange assigns. A queued
// ordinary input crosses as its JSON form instead, since inline admission
// carries JSON; a worker input waits for the export boundary.
type zbFrame struct {
	head, tail []byte
	worker     bool
	json       func() (map[string]any, error)
	// sent is called under frameMu once the frame is committed to the queue
	// or the guest, after which its token may be cancelled.
	sent func()
	// trailer, when set, writes the frame's last field once it is committed.
	trailer func() []byte
}

func (f *zbFrame) bytes(ref int64) []byte {
	out := make([]byte, 0, len(f.head)+10+len(f.tail))
	out = zbAppendInt(append(out, f.head...), ref)
	out = append(out, f.tail...)
	if f.trailer != nil {
		out = append(out, f.trailer()...)
	}
	return out
}

// zbInput starts an input of message tag m: everything before its ref.
func (b *zigGroup) zbInput(m byte) (*zbWriter, int) {
	w := &zbWriter{buf: make([]byte, 0, 128)}
	w.buf = append(append(w.buf, zbPrefix...), zbFields, m)
	w.begin(zbMessages[m].fields, true)
	w.key("ref")
	return w, len(w.buf)
}

func (w *zbWriter) frame(split int, worker bool, json func() (map[string]any, error)) *zbFrame {
	w.end()
	return &zbFrame{head: w.buf[:split:split], tail: w.buf[split:], worker: worker, json: json}
}

func (b *zigGroup) zbOptions() corevalue.BinaryOptions {
	return corevalue.BinaryOptions{
		CoreErrors:       true, // zigFeatures always negotiates core-message-v1
		FunctionMetadata: true,
		Encode: func(f *corevalue.FunctionData) ([]corevalue.Value, error) {
			text := func(s string) corevalue.Value { return corevalue.Fields{Kind: corevalue.Text, Text: s}.Value() }
			return []corevalue.Value{text(f.Home), text(wireDisplay(f)), text(f.Code)}, nil
		},
		Decode: b.zigFunction,
	}
}

// value appends a Host-supplied Value, refusing another Group's handles and
// Function Values first, as zigEncoded does.
func (b *zigGroup) zbValue(w *zbWriter, v Value) error {
	if err := b.zigDataOnly(v); err != nil {
		return err
	}
	out, err := corevalue.AppendBinary(w.buf, v.inner, b.zbOptions())
	if err != nil {
		return &HostError{InvalidValue, err.Error()}
	}
	w.buf = out
	return nil
}

func (b *zigGroup) zbValues(w *zbWriter, vs []Value) error {
	w.list(len(vs))
	for _, v := range vs {
		if err := b.zbValue(w, v); err != nil {
			return err
		}
	}
	return nil
}

// zbLimits writes a message's override, or the sentinel for one the wire
// can't represent, as zigQueuedMessage does.
func zbLimits(w *zbWriter, l *LimitOverride) {
	if l == nil {
		return
	}
	w.key("limits")
	fields, err := zigOverride(*l)
	if err != nil {
		w.list(0)
		return
	}
	w.begin(nil, false)
	for _, name := range []string{"fuelPerRun", "allocPerRun", "maxWaitMs", "maxJoin"} {
		if n, ok := fields[name]; ok {
			w.key(name)
			w.int(n.(int64))
		}
	}
	w.end()
}

// zbAddress writes a Request's `to` and `message`.
func (b *zigGroup) zbAddress(w *zbWriter, s *Script, to *Object, m Message) error {
	w.key("to")
	w.begin(nil, false)
	if to != nil {
		w.key("object")
		if err := b.zbValue(w, to.Value()); err != nil {
			return err
		}
	} else {
		w.key("script")
		w.ptext(s.name)
	}
	w.end()
	w.key("message")
	w.begin(nil, false)
	w.key("name")
	w.ptext(m.Name)
	w.key("args")
	if err := b.zbValues(w, m.Args); err != nil {
		return err
	}
	zbLimits(w, m.Limits)
	w.end()
	return nil
}

func (b *zigGroup) zbCallee(w *zbWriter, fn Value, m Message) error {
	w.key("fn")
	if err := b.zbValue(w, fn); err != nil {
		return err
	}
	w.key("args")
	if err := b.zbValues(w, m.Args); err != nil {
		return err
	}
	zbLimits(w, m.Limits)
	return nil
}

func zbClock(w *zbWriter, now time.Time, o PumpOptions) {
	w.key("now")
	w.instant(now.Round(0).UTC().Truncate(time.Microsecond))
	if o.FuelSlice != 0 {
		w.key("fuelSlice")
		w.int(o.FuelSlice)
	}
	if o.FuelCap != 0 {
		w.key("fuelCap")
		w.int(o.FuelCap)
	}
}

// zbReader reads a binary reply's envelope; Value items are spans.
type zbReader struct {
	d  []byte
	at int
	// The fields candidate's Reports, read as skipReports passes them.
	rows []zbRow
	// The rows' field spans share this backing, sized for want more.
	spans [][]byte
	want  int
}

// zbRow is one positional Report: its zbReports index and fields.
type zbRow struct {
	kind int
	view zbView
}

var errZigBinary = fmt.Errorf("malformed binary Zig reply")

func (r *zbReader) byte() (byte, error) {
	if r.at >= len(r.d) {
		return 0, errZigBinary
	}
	r.at++
	return r.d[r.at-1], nil
}

func (r *zbReader) uvarint() (uint64, error) {
	n, size := binary.Uvarint(r.d[r.at:])
	if size <= 0 || size > 1 && r.d[r.at+size-1] == 0 {
		return 0, errZigBinary
	}
	r.at += size
	return n, nil
}

// Negative items allow one magnitude beyond uint64: exactly 2^64.
func (r *zbReader) negativeMagnitude() error {
	boundary := [...]byte{0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02}
	if bytes.HasPrefix(r.d[r.at:], boundary[:]) {
		r.at += len(boundary)
		return nil
	}
	n, err := r.uvarint()
	if err != nil || n == 0 {
		return errZigBinary
	}
	return nil
}

func (r *zbReader) bytes() ([]byte, error) {
	n, err := r.uvarint()
	if err != nil || n > uint64(len(r.d)-r.at) {
		return nil, errZigBinary
	}
	r.at += int(n)
	return r.d[r.at-int(n) : r.at], nil
}

// skip reads one whole item of any tag the experiment uses.
func (r *zbReader) skip() ([]byte, error) {
	start := r.at
	for pending := 1; pending > 0; pending-- {
		t, err := r.byte()
		if err != nil {
			return nil, err
		}
		switch t {
		case 0x00, 0x01, 0x02:
		case 0x03, 0x0b:
			_, err = r.uvarint()
		case 0x10:
			err = r.negativeMagnitude()
		case 0x04, 0x05, 0x08, 0x0c, 0x0d, 0x12:
			_, err = r.bytes()
		case 0x06, 0x07, 0x11, 0x13:
			var n uint64
			n, err = r.uvarint()
			if t == 0x07 || t == 0x11 {
				if n > uint64(len(r.d)) {
					return nil, errZigBinary
				}
				n *= 2
			}
			if err == nil && n > uint64(len(r.d)-r.at) {
				err = errZigBinary
			}
			pending += int(n)
		case 0x09, 0x0a, 0x0e:
			pending += 2
		case 0x0f:
			pending += 3
		default:
			err = errZigBinary
		}
		if err != nil {
			return nil, err
		}
	}
	return r.d[start:r.at], nil
}

// skipReports reads the fields candidate's Report list, whose elements are
// a Report tag and its positional record rather than items.
func (r *zbReader) skipReports() ([]byte, error) {
	start := r.at
	if t, err := r.byte(); err != nil || t == 0x00 {
		if err == nil {
			return r.d[start:r.at], nil
		}
		return nil, err
	} else if t != 0x06 {
		return nil, errZigBinary
	}
	n, err := r.uvarint()
	if err != nil || n > uint64(len(r.d)-r.at) {
		return nil, errZigBinary
	}
	r.rows = make([]zbRow, 0, n)
	for i := range n {
		// Reports average under ten fields; one backing usually holds them all.
		r.want = int(n-i) * 10
		tag, err := r.byte()
		if err != nil || tag == 0 || int(tag) > len(zbReports) {
			return nil, errZigBinary
		}
		view, err := r.positional(zbReports[tag-1].fields)
		if err != nil {
			return nil, err
		}
		r.rows = append(r.rows, zbRow{kind: int(tag - 1), view: view})
	}
	return r.d[start:r.at], nil
}

// zbView is a record's fields by name: a map's keys, or a positional
// record's table names. Nothing is an absent field.
type zbView struct {
	keys []string
	vals [][]byte
}

func (v zbView) get(key string) []byte {
	for i, k := range v.keys {
		if k == key {
			return v.vals[i]
		}
	}
	return nil
}

func zbNothing(span []byte) bool { return len(span) == 1 && span[0] == 0x00 }

// zbMapView reads a map item's pairs.
func zbMapView(span []byte) (zbView, error) {
	r := zbReader{d: span}
	if t, err := r.byte(); err != nil || t != 0x07 {
		return zbView{}, errZigBinary
	}
	n, err := r.uvarint()
	if err != nil || n > uint64(len(span)) {
		return zbView{}, errZigBinary
	}
	v := zbView{keys: make([]string, 0, n), vals: make([][]byte, 0, n)}
	for range n {
		if t, err := r.byte(); err != nil || t != 0x05 {
			return zbView{}, errZigBinary
		}
		k, err := r.bytes()
		if err != nil {
			return zbView{}, err
		}
		val, err := r.skip()
		if err != nil {
			return zbView{}, err
		}
		if zbNothing(val) {
			val = nil
		}
		v.keys, v.vals = append(v.keys, string(k)), append(v.vals, val)
	}
	if r.at != len(span) {
		return zbView{}, errZigBinary
	}
	return v, nil
}

// zbPositional reads a fields-candidate record of the given names.
func zbPositional(r *zbReader, names []string) (zbView, error) {
	return r.positional(names)
}

func (r *zbReader) positional(names []string) (zbView, error) {
	if t, err := r.byte(); err != nil || t != 0x06 {
		return zbView{}, errZigBinary
	}
	if n, err := r.uvarint(); err != nil || n != uint64(len(names)) {
		return zbView{}, errZigBinary
	}
	if cap(r.spans)-len(r.spans) < len(names) {
		r.spans = make([][]byte, 0, max(r.want, len(names)))
	}
	at := len(r.spans)
	r.spans = r.spans[:at+len(names)]
	v := zbView{keys: names, vals: r.spans[at : at+len(names) : at+len(names)]}
	for i, name := range names {
		skip := r.skip
		if name == "reports" {
			skip = r.skipReports
		}
		val, err := skip()
		if err != nil {
			return zbView{}, err
		}
		if zbNothing(val) {
			val = nil
		}
		v.vals[i] = val
	}
	return v, nil
}

func zbItems(span []byte) ([][]byte, error) {
	r := zbReader{d: span}
	if t, err := r.byte(); err != nil || t != 0x06 {
		return nil, errZigBinary
	}
	n, err := r.uvarint()
	if err != nil || n > uint64(len(span)) {
		return nil, errZigBinary
	}
	items := make([][]byte, n)
	for i := range items {
		if items[i], err = r.skip(); err != nil {
			return nil, err
		}
	}
	if r.at != len(span) {
		return nil, errZigBinary
	}
	return items, nil
}

// zbText reads protocol text, or a text item.
func zbText(span []byte) (string, bool) {
	r := zbReader{d: span}
	t, err := r.byte()
	if err != nil || t != 0x12 && t != 0x05 {
		return "", false
	}
	s, err := r.bytes()
	if err != nil || r.at != len(span) || !utf8.Valid(s) {
		return "", false
	}
	return string(s), true
}

func zbTexts(span []byte) ([]string, error) {
	if span == nil {
		return nil, nil
	}
	items, err := zbItems(span)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(items))
	for i, item := range items {
		var ok bool
		if out[i], ok = zbText(item); !ok {
			return nil, errZigBinary
		}
	}
	return out, nil
}

func zbInt(span []byte) (int64, bool) {
	r := zbReader{d: span}
	t, err := r.byte()
	if err != nil || t != 0x03 && t != 0x10 {
		return 0, false
	}
	n, err := r.uvarint()
	if err != nil || r.at != len(span) {
		return 0, false
	}
	if t == 0x10 {
		if n == 0 || n > 1<<63 {
			return 0, false
		}
		return -int64(n-1) - 1, true
	}
	if n > 1<<63-1 {
		return 0, false
	}
	return int64(n), true
}

func zbInstant(span []byte) (time.Time, bool) {
	r := zbReader{d: span}
	if t, err := r.byte(); err != nil || t != 0x0b {
		return time.Time{}, false
	}
	u, err := r.uvarint()
	if err != nil || r.at != len(span) {
		return time.Time{}, false
	}
	return time.UnixMicro(int64(u>>1) ^ -int64(u&1)).UTC(), true
}

// zbDecodeValue reads a Value item against this Group.
func (b *zigGroup) zbDecodeValue(span []byte) (Value, error) {
	return b.replyReader().zbDecodeValue(span)
}
