//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"fmt"
	"reflect"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

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
	rows                                 []zbRow // its Reports, already read
	err                                  []byte
	abandoned, settled, trace            []byte
	// need is a binary callback need (#1311), which ends no exchange.
	need zbNeed
}

func zbParse(data []byte, p *zbPacket) error {
	if !bytes.HasPrefix(data, zbPrefix) || len(data) < len(zbPrefix)+1 {
		return errZigBinary
	}
	r := zbReader{d: data, at: len(zbPrefix) + 1}
	if data[len(zbPrefix)] != zbFields {
		return errZigBinary
	}
	if len(data) > len(zbPrefix)+1 && data[len(zbPrefix)+1] >= zbOpNeed {
		return zbParseNeed(&r, p)
	}
	tag, err := r.byte()
	if err != nil || tag != zbAdmission && tag != zbCompletion {
		return errZigBinary
	}
	p.completion = tag == zbCompletion
	top, err := zbPositional(&r, zbMessages[tag].fields)
	if err != nil {
		return err
	}
	p.state, p.deadline, p.fuel = top.get("state"), top.get("nextDeadline"), top.get("fuelUsed")
	p.reports, p.gone, p.trace = top.get("reports"), top.get("gone"), top.get("trace")
	p.rows = r.rows
	if r.at != len(data) {
		return errZigBinary
	}
	ref, ok := zbInt(top.get("ref"))
	if !ok {
		return fmt.Errorf("Zig reply omitted ref")
	}
	p.ref = ref
	if d := top.get("delivery"); d != nil {
		if p.delivery, ok = zbText(d); !ok {
			return errZigBinary
		}
		p.hasDelivery = true
	}
	if t := top.get("token"); t != nil {
		n, ok := zbInt(t)
		if !ok || n <= 0 {
			return errZigBinary
		}
		p.token = uint64(n)
	}
	p.err, p.abandoned, p.settled = top.get("err"), top.get("abandoned"), top.get("settled")
	p.ok = p.err == nil
	if p.completion && p.ok && p.state == nil {
		return errZigBinary
	}
	return err
}

// zbParseNeed reads a callback need and its notices.
func zbParseNeed(r *zbReader, p *zbPacket) error {
	tag, err := r.byte()
	if err != nil {
		return err
	}
	c, ok := zbCallbacks[tag]
	if !ok || c.kind == "" {
		return errZigBinary
	}
	view, err := r.positional(c.fields)
	if err != nil {
		return err
	}
	if r.at != len(r.d) {
		return errZigBinary
	}
	ref, ok := zbInt(view.get("ref"))
	if !ok {
		return fmt.Errorf("Zig reply omitted ref")
	}
	*p = zbPacket{ref: ref, ok: true, need: zbNeed{tag: tag, view: view}, abandoned: view.get("abandoned"), settled: view.get("settled"), trace: view.get("trace")}
	return nil
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

// zbDecode reads one item into dst, as zigDecodeResolving reads JSON.
func (b zigReplyReader) zbDecode(span []byte, dst reflect.Value) error {
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

// zbDecodeValues reads a list of Values, as zbDecode would into a []Value,
// without reflection; a missing list stays nil.
func (b zigReplyReader) zbDecodeValues(span []byte) ([]Value, error) {
	if span == nil {
		return nil, nil
	}
	items, err := zbItems(span)
	if err != nil {
		return nil, fmt.Errorf("expected Zig list for []Value")
	}
	vs := make([]Value, len(items))
	for i, item := range items {
		if vs[i], err = b.zbDecodeValue(item); err != nil {
			return nil, err
		}
	}
	return vs, nil
}

func (b zigReplyReader) zbDecodeStruct(view zbView, dst reflect.Value) error {
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
func (b zigReplyReader) zbDecodeReport(row zbView, report Report) error {
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
		if r.Args, err = b.zbDecodeValues(row.get("args")); err == nil {
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

func (b zigReplyReader) decodeValue(raw []byte) (Value, error) {
	return zigDecodeValue(raw, b.resolver)
}
func (b zigReplyReader) zbDecodeValue(span []byte) (Value, error) {
	v, err := corevalue.DecodeBinary(span, b.resolveObject, corevalue.BinaryOptions{CoreErrors: true, FunctionMetadata: true, Decode: b.resolveFunction})
	if err != nil {
		return Nothing, &HostError{InvalidValue, err.Error()}
	}
	return Value{v}, nil
}

// zbNeed is a binary callback need: its tag and positional fields.
type zbNeed struct {
	tag  byte
	view zbView
}
