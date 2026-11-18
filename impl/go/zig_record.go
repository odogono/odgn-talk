package northtalk

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"time"

	"northtalk.org/go/internal/generated"
)

// zigRecord pairs a catalogued field list with the generated record that
// carries it (ADR 0183). Both layouts walk it; no Host spells a field name.
type zigRecord struct {
	fields []generated.EnvelopeField
	keys   []string
	index  []int // each field's position in the record struct
	views  []*zigRecord
}

// newZigRecord finds each catalogued field by its record's json tag, so a
// catalogue field with no record field fails at start-up, not on the wire.
func newZigRecord(t reflect.Type, fields []generated.EnvelopeField) *zigRecord {
	r := &zigRecord{fields: fields, keys: make([]string, len(fields)), index: make([]int, len(fields)), views: make([]*zigRecord, len(fields))}
	for i, field := range fields {
		r.keys[i], r.index[i] = field.Name, -1
		for j := 0; j < t.NumField(); j++ {
			if name, _, _ := strings.Cut(t.Field(j).Tag.Get("json"), ","); name == field.Name {
				r.index[i] = j
			}
		}
		if r.index[i] < 0 {
			panic(fmt.Sprintf("talk: %s has no field %q", t, field.Name))
		}
		if field.View != "" {
			r.views[i] = newZigRecord(t.Field(r.index[i]).Type.Elem(), zigView(field.View))
		}
	}
	return r
}

func zigView(name string) []generated.EnvelopeField {
	for _, view := range generated.EnvelopeViews {
		if view.Name == name {
			return view.Fields
		}
	}
	panic("talk: unknown envelope view " + name)
}

// get reads field i of rec as a protocol value: nil when absent, as the
// record's omitempty tags would omit it.
func (r *zigRecord) get(rec reflect.Value, i int) any {
	v := rec.Field(r.index[i])
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			return nil
		}
		return v.Elem().Interface()
	case reflect.Int64:
		return v.Int()
	case reflect.String:
		return v.String()
	}
	return v.Interface()
}

// zigLoadRecord is the Load message in either layout.
var zigLoadRecord = newZigRecord(reflect.TypeFor[generated.EnvelopeLoad](), zbEnvelopes[zbLoadTag].items)

// zigLoadJSON writes the JSON layout: present fields and the dispatch tag
// in code-point order, as every other JSON input is written.
func zigLoadJSON(rec *generated.EnvelopeLoad) ([]byte, error) {
	v := reflect.ValueOf(rec).Elem()
	fields := make(map[string]any, len(zigLoadRecord.fields)+1)
	fields["m"] = "load"
	for i, field := range zigLoadRecord.fields {
		if value := zigLoadRecord.get(v, i); value != nil {
			fields[field.Name] = value
		}
	}
	return zigJSON(nil, fields)
}

// zigInspectionRecord reads the Inspect reply view.
var zigInspectionRecord = newZigRecord(reflect.TypeFor[generated.EnvelopeInspection](), zigView("inspection"))

// decode reads a JSON reply into rec, walking the catalogued fields. Opaque
// kinds keep their own bytes as a zigReply, so Values and Messages are
// decoded once, against their Group, with no float or depth limit.
func (r *zigRecord) decode(src zigReply, rec reflect.Value) error {
	if !src.isMap() {
		return fmt.Errorf("invalid Zig %s", rec.Type())
	}
	var local [16]zigReply
	values := local[:]
	if len(r.fields) > len(values) {
		values = make([]zigReply, len(r.fields))
	}
	values = values[:len(r.fields)]
	src.lookup(r.keys, values)
	for i, field := range r.fields {
		if !values[i].present() {
			continue
		}
		if err := r.decodeField(values[i], rec.Field(r.index[i]), r.views[i]); err != nil {
			return fmt.Errorf("%s: %w", field.Name, err)
		}
	}
	return nil
}

func (r *zigRecord) decodeField(src zigReply, dst reflect.Value, view *zigRecord) error {
	switch dst.Kind() {
	case reflect.Interface:
		dst.Set(reflect.ValueOf(slices.Clip(src)))
	case reflect.Pointer:
		dst.Set(reflect.New(dst.Type().Elem()))
		return r.decodeField(src, dst.Elem(), view)
	case reflect.String:
		v, ok := src.text()
		if !ok {
			return fmt.Errorf("expected Zig text")
		}
		dst.SetString(v)
	case reflect.Bool:
		v, ok := src.boolean()
		if !ok {
			return fmt.Errorf("expected Zig boolean")
		}
		dst.SetBool(v)
	case reflect.Int64:
		v, ok := src.int64()
		if !ok {
			return fmt.Errorf("expected Zig integer")
		}
		dst.SetInt(v)
	case reflect.Slice, reflect.Array:
		if !src.isList() {
			return fmt.Errorf("expected Zig array for %s", dst.Type())
		}
		items := src.items()
		if dst.Kind() == reflect.Array {
			if len(items) != dst.Len() {
				return fmt.Errorf("expected %d Zig items", dst.Len())
			}
		} else {
			dst.Set(reflect.MakeSlice(dst.Type(), len(items), len(items)))
		}
		for i, item := range items {
			var err error
			if view != nil {
				err = view.decode(item, dst.Index(i))
			} else {
				err = r.decodeField(item, dst.Index(i), nil)
			}
			if err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unsupported Zig record field %s", dst.Type())
	}
	return nil
}

// zigHeaded copies a Load record with the ref and group its frame carries.
func zigHeaded(rec *generated.EnvelopeLoad, fields map[string]any) *generated.EnvelopeLoad {
	load := *rec
	load.Ref, load.Group = fields["ref"].(int64), fields["group"].(string)
	return &load
}

// zigInspection maps the Inspect reply view onto the public Inspection, one
// line per field. Values and Messages are decoded against r: a Group, or a
// session's guest.
func zigInspection(view generated.EnvelopeInspection, r zigValueResolver) (Inspection, error) {
	d := zigViewDecoder{b: r}
	var scripts []ScriptView
	if view.Scripts != nil {
		scripts = make([]ScriptView, len(view.Scripts))
	}
	for i, s := range view.Scripts {
		scripts[i] = ScriptView{
			Name:             s.Name,
			DisabledGrants:   s.DisabledGrants,
			ForbidSuspension: d.flag(s.ForbidSuspension),
			Vars:             d.pairs(s.Vars),
			Runs:             d.runs(s.Runs),
			Mailbox:          d.mailbox(s.Mailbox),
		}
	}
	return Inspection{Scripts: scripts}, d.err
}

func (d *zigViewDecoder) runs(runs []generated.EnvelopeInspectedRun) []RunView {
	if runs == nil {
		return nil
	}
	out := make([]RunView, len(runs))
	for i, r := range runs {
		out[i] = RunView{
			ID:      RunID(r.Id),
			Status:  RunStatus(d.enum(r.Status, zigEnums[reflect.TypeFor[RunStatus]()])),
			Handler: r.Handler,
			Wait:    d.text(r.Wait),
			Until:   d.instant(r.Until),
			Calls:   zigIDs[CallID](r.Calls),
		}
	}
	return out
}

func (d *zigViewDecoder) mailbox(messages []generated.EnvelopeInspectedMessage) []MessageView {
	if messages == nil {
		return nil
	}
	out := make([]MessageView, len(messages))
	for i, m := range messages {
		out[i] = MessageView{
			Delivery: DeliveryID(d.text(m.Delivery)),
			From:     d.text(m.From),
			Message:  d.message(m.Message),
		}
	}
	return out
}

// zigViewDecoder keeps the first error while a reply view is mapped.
type zigViewDecoder struct {
	b   zigValueResolver
	err error
}

func (d *zigViewDecoder) fail(err error) {
	if d.err == nil {
		d.err = err
	}
}

func (*zigViewDecoder) flag(v *bool) bool { return v != nil && *v }

func (*zigViewDecoder) text(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func (d *zigViewDecoder) instant(v *string) time.Time {
	if v == nil {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, *v)
	d.fail(err)
	return t
}

func (d *zigViewDecoder) enum(text string, values map[string]int) int {
	v, ok := values[text]
	if !ok {
		d.fail(fmt.Errorf("unknown Zig enum %q", text))
	}
	return v
}

func (d *zigViewDecoder) value(raw any) Value {
	v, err := zigDecodeValue(raw.(zigReply), d.b)
	d.fail(err)
	return v
}

func (d *zigViewDecoder) pairs(pairs [][2]any) []Pair {
	if pairs == nil {
		return nil
	}
	out := make([]Pair, len(pairs))
	for i, p := range pairs {
		key, ok := p[0].(zigReply).text()
		if !ok {
			d.fail(fmt.Errorf("invalid Zig variable pair"))
		}
		out[i] = Pair{Key: key, Val: d.value(p[1])}
	}
	return out
}

func (d *zigViewDecoder) message(raw any) Message {
	var m Message
	if raw != nil {
		d.fail(zigDecodeResolving(raw.(zigReply), reflect.ValueOf(&m).Elem(), d.b))
	}
	return m
}

func zigIDs[ID ~string](ids []string) []ID {
	if ids == nil {
		return nil
	}
	out := make([]ID, len(ids))
	for i, id := range ids {
		out[i] = ID(id)
	}
	return out
}
