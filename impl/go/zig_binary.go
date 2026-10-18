//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"reflect"
	"time"
	"unicode/utf8"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// The binary Request/Pump candidates of #1245 (proposed ADR 0110,
// spec/embedding/request-pump-binary.md). Experimental: guests made after
// zigRequestPump is set negotiate "map" or "fields"; "" keeps JSON only.
// TALK_ZIG_REQUEST_PUMP sets it, so the adapter suites can run on either.
var zigRequestPump = os.Getenv("TALK_ZIG_REQUEST_PUMP")

type zbLayout byte

const (
	zbMap    zbLayout = 0
	zbFields zbLayout = 1
)

var zbPrefix = []byte("NTB\x01")

// zigRequestPumpFeature is the hello feature for zigRequestPump, if any.
func zigRequestPumpFeature() (string, zbLayout, bool, error) {
	switch zigRequestPump {
	case "":
		return "", 0, false, nil
	case "map":
		return "request-pump-map-v1", zbMap, true, nil
	case "fields":
		return "request-pump-fields-v1", zbFields, true, nil
	}
	return "", 0, false, fmt.Errorf("TALK_ZIG_REQUEST_PUMP must be map, fields or empty, not %q", zigRequestPump)
}

// Fields-candidate message tags and positional fields.
const (
	zbRequest     byte = 0x01
	zbCall        byte = 0x02
	zbPump        byte = 0x03
	zbRequestPump byte = 0x04
	zbCallPump    byte = 0x05
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
}

func (f *zbFrame) bytes(ref int64) []byte {
	out := make([]byte, 0, len(f.head)+10+len(f.tail))
	out = zbAppendInt(append(out, f.head...), ref)
	return append(out, f.tail...)
}

// zbInput starts an input of message tag m: everything before its ref.
func (b *zigGroup) zbInput(m byte) (*zbWriter, int) {
	layout := b.reg.layout
	w := &zbWriter{buf: make([]byte, 0, 128)}
	w.buf = append(append(w.buf, zbPrefix...), byte(layout))
	positional := layout == zbFields
	if positional {
		w.buf = append(w.buf, m)
	}
	w.begin(zbMessages[m].fields, positional)
	if !positional {
		w.key("m")
		w.ptext(zbMessages[m].name)
	}
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
		case 0x03, 0x0b, 0x10:
			_, err = r.uvarint()
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
	for range n {
		tag, err := r.byte()
		if err != nil || tag == 0 || int(tag) > len(zbReports) {
			return nil, errZigBinary
		}
		if _, err := r.skip(); err != nil {
			return nil, err
		}
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
	if t, err := r.byte(); err != nil || t != 0x06 {
		return zbView{}, errZigBinary
	}
	if n, err := r.uvarint(); err != nil || n != uint64(len(names)) {
		return zbView{}, errZigBinary
	}
	v := zbView{keys: names, vals: make([][]byte, len(names))}
	for i, name := range names {
		skip := r.skip
		if name == "reports" {
			skip = r.skipReports
		}
		val, err := skip()
		if err != nil {
			return zbView{}, err
		}
		if !zbNothing(val) {
			v.vals[i] = val
		}
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

// zbPacket is a binary reply: an admission, or a Pump's completion.
type zbPacket struct {
	completion  bool
	ref         int64
	delivery    string
	hasDelivery bool
	token       uint64
	ok          bool
	// A completion's outcome, as items.
	state, deadline, fuel, reports, gone []byte
	fields                               bool // the fields candidate's Reports
	err                                  []byte
	abandoned, settled, trace            []byte
}

func zbParse(data []byte) (*zbPacket, error) {
	if !bytes.HasPrefix(data, zbPrefix) || len(data) < len(zbPrefix)+1 {
		return nil, errZigBinary
	}
	r := zbReader{d: data, at: len(zbPrefix) + 1}
	p := &zbPacket{}
	var top zbView
	var err error
	switch zbLayout(data[len(zbPrefix)]) {
	case zbFields:
		p.fields = true
		tag, err := r.byte()
		if err != nil || tag != zbAdmission && tag != zbCompletion {
			return nil, errZigBinary
		}
		p.completion = tag == zbCompletion
		if top, err = zbPositional(&r, zbMessages[tag].fields); err != nil {
			return nil, err
		}
		p.state, p.deadline, p.fuel = top.get("state"), top.get("nextDeadline"), top.get("fuelUsed")
		p.reports, p.gone, p.trace = top.get("reports"), top.get("gone"), top.get("trace")
	case zbMap:
		span, err := r.skip()
		if err != nil {
			return nil, err
		}
		if top, err = zbMapView(span); err != nil {
			return nil, err
		}
		p.trace = top.get("trace")
		if ok := top.get("ok"); ok != nil {
			inner, err := zbMapView(ok)
			if err != nil {
				return nil, err
			}
			p.state, p.deadline, p.fuel = inner.get("state"), inner.get("nextDeadline"), inner.get("fuelUsed")
			p.reports, p.gone, p.trace = inner.get("reports"), inner.get("gone"), inner.get("trace")
			if d := inner.get("delivery"); d != nil {
				top.keys, top.vals = append(top.keys, "delivery"), append(top.vals, d)
			}
		}
		p.completion = p.state != nil || top.get("token") != nil
	default:
		return nil, errZigBinary
	}
	if r.at != len(data) {
		return nil, errZigBinary
	}
	ref, ok := zbInt(top.get("ref"))
	if !ok {
		return nil, fmt.Errorf("Zig reply omitted ref")
	}
	p.ref = ref
	if d := top.get("delivery"); d != nil {
		if p.delivery, ok = zbText(d); !ok {
			return nil, errZigBinary
		}
		p.hasDelivery = true
	}
	if t := top.get("token"); t != nil {
		n, ok := zbInt(t)
		if !ok || n <= 0 {
			return nil, errZigBinary
		}
		p.token = uint64(n)
	}
	p.err, p.abandoned, p.settled = top.get("err"), top.get("abandoned"), top.get("settled")
	p.ok = p.err == nil
	if p.completion && p.ok && p.state == nil {
		return nil, errZigBinary
	}
	return p, err
}

// failure is the reply's ordinary error object as an error.
func (p *zbPacket) failure() error {
	v, err := zbMapView(p.err)
	if err != nil {
		return err
	}
	kind, _ := zbText(v.get("kind"))
	code, _ := zbText(v.get("code"))
	detail, _ := zbText(v.get("detail"))
	switch kind {
	case "host error":
		return &HostError{Code: HostErrorCode(code), Detail: detail}
	case "mailbox full":
		return ErrMailboxFull
	}
	return fmt.Errorf("Zig Message Layer: %s", detail)
}

// zbDecodeValue reads a Value item against this Group.
func (b *zigGroup) zbDecodeValue(span []byte) (Value, error) {
	v, err := corevalue.DecodeBinary(span, b.zigResolveObject, b.zbOptions())
	if err != nil {
		return Nothing, &HostError{InvalidValue, err.Error()}
	}
	return Value{v}, nil
}

// zbPumpResult decodes a completion's outcome and Reports, then settles
// futures exactly as the JSON receipt does.
func (b *zigGroup) zbPumpResult(p *zbPacket) (PumpResult, error) {
	var result PumpResult
	state, _ := zbText(p.state)
	if err := zigEnumText(state, reflect.ValueOf(&result.State).Elem(), zigGroupStates); err != nil {
		return result, err
	}
	if p.deadline != nil {
		t, ok := zbInstant(p.deadline)
		if !ok {
			return result, errZigBinary
		}
		result.NextDeadline = t
	}
	fuel, ok := zbInt(p.fuel)
	if !ok {
		return result, errZigBinary
	}
	result.FuelUsed = fuel
	climbed := map[Report]bool{}
	r := zbReader{d: p.reports}
	if t, err := r.byte(); err != nil || t != 0x06 {
		return result, errZigBinary
	}
	n, err := r.uvarint()
	if err != nil || n > uint64(len(p.reports)) {
		return result, errZigBinary
	}
	for range n {
		var row zbView
		var kind string
		if p.fields {
			tag, err := r.byte()
			if err != nil || tag == 0 || int(tag) > len(zbReports) {
				return result, errZigBinary
			}
			kind = zbReports[tag-1].kind
			if row, err = zbPositional(&r, zbReports[tag-1].fields); err != nil {
				return result, err
			}
		} else {
			span, err := r.skip()
			if err != nil {
				return result, err
			}
			if row, err = zbMapView(span); err != nil {
				return result, err
			}
			kind, _ = zbText(row.get("kind"))
		}
		report, err := zigReportOf(kind)
		if err != nil {
			return result, err
		}
		if err := b.zbDecodeReport(row, report); err != nil {
			return result, err
		}
		if c := row.get("climbed"); len(c) == 1 && c[0] == 0x02 {
			climbed[report] = true
		}
		result.Reports = append(result.Reports, report)
	}
	if r.at != len(p.reports) {
		return result, errZigBinary
	}
	gone, err := zbTexts(p.gone)
	if err != nil {
		return result, err
	}
	return b.finishPump(result, climbed, gone)
}

// zbDecode reads one item into dst, as zigDecodeResolving reads JSON.
func (b *zigGroup) zbDecode(span []byte, dst reflect.Value) error {
	if span == nil {
		return nil
	}
	switch dst.Type() {
	case zigObjectType:
		v, err := b.zbDecodeValue(span)
		if err != nil {
			return err
		}
		o, ok := v.AsObject()
		if !ok || o == nil {
			return fmt.Errorf("Zig named an unknown Object")
		}
		dst.Set(reflect.ValueOf(o))
		return nil
	case zigValueType:
		v, err := b.zbDecodeValue(span)
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(v))
		return nil
	case zigTimeType:
		t, ok := zbInstant(span)
		if !ok {
			return errZigBinary
		}
		dst.Set(reflect.ValueOf(t))
		return nil
	case zigScriptErrorType:
		v, err := b.zbDecodeValue(span)
		if err != nil {
			return err
		}
		var data []Pair
		for _, pair := range v.Entries() {
			switch pair.Key {
			case "code":
				dst.FieldByName("Code").SetString(pair.Val.inner.Text())
			case "message":
				dst.FieldByName("Message").SetString(pair.Val.inner.Text())
			default:
				data = append(data, pair)
			}
		}
		m, err := Map(data...)
		if err != nil {
			return err
		}
		dst.FieldByName("Data").Set(reflect.ValueOf(m))
		return nil
	}
	if values, ok := zigEnums[dst.Type()]; ok {
		text, _ := zbText(span)
		return zigEnumText(text, dst, values)
	}
	switch dst.Kind() {
	case reflect.Pointer:
		dst.Set(reflect.New(dst.Type().Elem()))
		return b.zbDecode(span, dst.Elem())
	case reflect.Struct:
		view, err := zbMapView(span)
		if err != nil {
			return fmt.Errorf("invalid Zig %s", dst.Type())
		}
		return b.zbDecodeStruct(view, dst)
	case reflect.Slice:
		items, err := zbItems(span)
		if err != nil {
			return fmt.Errorf("expected Zig list for %s", dst.Type())
		}
		dst.Set(reflect.MakeSlice(dst.Type(), len(items), len(items)))
		for i, item := range items {
			if err := b.zbDecode(item, dst.Index(i)); err != nil {
				return err
			}
		}
	case reflect.String:
		s, ok := zbText(span)
		if !ok {
			return fmt.Errorf("expected Zig text")
		}
		dst.SetString(s)
	case reflect.Bool:
		if len(span) != 1 || span[0] != 0x01 && span[0] != 0x02 {
			return fmt.Errorf("expected Zig boolean")
		}
		dst.SetBool(span[0] == 0x02)
	case reflect.Int, reflect.Int64:
		n, ok := zbInt(span)
		if !ok || dst.OverflowInt(n) {
			return fmt.Errorf("expected Zig integer")
		}
		dst.SetInt(n)
	default:
		return fmt.Errorf("unsupported Zig field type %s", dst.Type())
	}
	return nil
}

func (b *zigGroup) zbDecodeStruct(view zbView, dst reflect.Value) error {
	fields := zigFields(dst.Type())
	for i, f := range fields.fields {
		if f.anonymous {
			if err := b.zbDecodeStruct(view, dst.Field(f.index)); err != nil {
				return err
			}
			continue
		}
		if err := b.zbDecode(view.get(fields.keys[i]), dst.Field(f.index)); err != nil {
			return fmt.Errorf("%s: %w", f.name, err)
		}
	}
	return nil
}

// zbDecodeReport reads the Reports every Request produces directly, and
// others through zbDecodeStruct.
func (b *zigGroup) zbDecodeReport(row zbView, report Report) error {
	text := func(key string) string { s, _ := zbText(row.get(key)); return s }
	num := func(key string) (int64, error) {
		span := row.get(key)
		if span == nil {
			return 0, nil
		}
		n, ok := zbInt(span)
		if !ok {
			return 0, fmt.Errorf("%s: expected Zig integer", key)
		}
		return n, nil
	}
	ancestry := func() RunAncestry {
		return RunAncestry{RootDelivery: DeliveryID(text("rootDelivery")), ParentRun: RunID(text("parentRun")), ParentCall: CallID(text("parentCall"))}
	}
	var err error
	switch r := report.(type) {
	case *RunStarted:
		r.RunAncestry = ancestry()
		r.Script, r.Run, r.Delivery, r.Selector = text("script"), RunID(text("run")), DeliveryID(text("delivery")), text("selector")
		if err = b.zbDecode(row.get("args"), reflect.ValueOf(&r.Args).Elem()); err == nil {
			err = b.zbDecode(row.get("fn"), reflect.ValueOf(&r.Function).Elem())
		}
	case *RunAccounting:
		r.RunAncestry = ancestry()
		r.Script, r.Run, r.State = text("script"), RunID(text("run")), text("state")
		r.Fuel, err = num("fuel")
	case *CausalWork:
		r.RootDelivery = DeliveryID(text("rootDelivery"))
		if r.LiveRuns, err = num("liveRuns"); err == nil {
			if r.QueuedMessages, err = num("queuedMessages"); err == nil {
				r.DiscardedMessages, err = num("discardedMessages")
			}
		}
	case *RunEnd:
		if row.get("effect") != nil || row.get("cleanupFailed") != nil || row.get("error") != nil || row.get("at") != nil {
			return b.zbDecodeStruct(row, reflect.ValueOf(r).Elem())
		}
		r.Script, r.Run, r.Delivery, r.Broadcast, r.Handler, r.Limit = text("script"), RunID(text("run")), DeliveryID(text("delivery")), BroadcastID(text("broadcast")), text("handler"), text("limit")
		if f := row.get("fallback"); len(f) == 1 && f[0] == 0x02 {
			r.Fallback = true
		}
		outcome, _ := zbText(row.get("outcome"))
		if err = zigEnumText(outcome, reflect.ValueOf(&r.Outcome).Elem(), zigEnums[reflect.TypeFor[Outcome]()]); err != nil {
			return err
		}
		if span := row.get("result"); span != nil {
			if r.Result, err = b.zbDecodeValue(span); err != nil {
				return err
			}
		}
		if r.Fuel, err = num("fuel"); err == nil {
			r.Alloc, err = num("alloc")
		}
	default:
		return b.zbDecodeStruct(row, reflect.ValueOf(report).Elem())
	}
	return err
}
