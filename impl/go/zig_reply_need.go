//go:build talk_zig_experimental

package northtalk

import (
	"fmt"
	"reflect"
	"time"
)

// zigNow reads a need's Host clock reading. A Run's callbacks repeat one
// reading, so the last one parsed is reused.
func (b zigReplyReader) zigNow(raw zigReply) (time.Time, error) {
	if b.clock != nil && len(raw) != 0 && string(raw) == b.clock.raw {
		return b.clock.now, nil
	}
	now, err := time.Parse(time.RFC3339Nano, zigText(raw))
	if err != nil {
		return time.Time{}, err
	}
	if b.clock != nil {
		b.clock.raw, b.clock.now = string(raw), now
	}
	return now, nil
}

// zigReadNeed reads a JSON need's fields.
func (b zigReplyReader) zigReadNeed(kind string, need zigReply) zigNeed {
	n := zigNeed{kind: kind}
	if kind == "resolve" {
		for _, pair := range need.get("grants").items() {
			s, g := zigTextPair(pair)
			n.bindGrants = append(n.bindGrants, [2]string{s, g})
		}
		for _, pair := range need.get("objects").items() {
			k, id := zigTextPair(pair)
			n.bindObjects = append(n.bindObjects, [2]string{k, id})
		}
		return n
	}
	if kind == "prop" {
		var fields [4]zigReply
		need.lookup(zigPropertyNeedKeys, fields[:])
		if ref := fields[0].get("$object").items(); len(ref) == 2 {
			n.object, n.objectKind, n.objectID = true, zigText(ref[0]), zigText(ref[1])
		}
		n.prop, n.op = zigText(fields[1]), zigText(fields[3])
		// Presence, including an explicit null, distinguishes a setter from a getter.
		n.set, n.collection = fields[2] != nil, fields[3] != nil
		if n.set && !n.collection {
			n.value, n.valueErr = b.decodeInto(fields[2])
		}
		if !n.collection {
			return n
		}
		for _, entry := range need.entries() {
			if entry.Key == "selector" {
				n.selected = true
				var err error
				if n.selector, err = b.decodeInto(need.get("selector")); err != nil {
					n.valueErr = err
				}
			}
		}
		return n
	}
	f := zigReadCallNeed(need)
	n.script, n.grant, n.reason, n.operation = zigText(f.script), zigText(f.grant), zigText(f.reason), zigText(f.operation)
	n.capability, n.call, n.scope, n.run, n.segment = zigText(f.capability), zigText(f.call), zigText(f.scope), zigText(f.run), zigText(f.segment)
	n.now, n.nowErr = b.zigNow(f.now)
	if kind == "effect" {
		n.phase = zigText(need.get("phase"))
		n.grants = []string{}
		for _, raw := range need.get("grants").items() {
			n.grants = append(n.grants, zigText(raw))
		}
		return n
	}
	if kind == "op" {
		for _, raw := range f.args.items() {
			v, err := b.decodeValue(raw)
			if err != nil {
				n.argErr = err
				break
			}
			n.args = append(n.args, v)
		}
		n.automatic, _ = f.automatic.boolean()
		if n.limited = f.fuelLeft.present(); n.limited {
			var ok bool
			if n.fuelLeft, ok = f.fuelLeft.int64(); !ok {
				n.fuelErr = fmt.Errorf("Zig callback has an invalid fuelLeft")
			}
		}
	}
	return n
}

// decodeInto reads one JSON Value as decode does.
func (b zigReplyReader) decodeInto(src zigReply) (Value, error) {
	var v Value
	err := zigDecodeResolving(src, reflect.ValueOf(&v).Elem(), b.resolver)
	return v, err
}

// zbReadNeed reads a binary need's fields.
func (b zigReplyReader) zbReadNeed(p *zbNeed) zigNeed {
	v := p.view
	text := func(key string) string { s, _ := zbText(v.get(key)); return s }
	n := zigNeed{kind: zbEnvelopes[p.tag].name, tag: p.tag}
	if p.tag == zbPropNeed {
		if ref, err := zbTexts(v.get("object")); err == nil && len(ref) == 2 {
			n.object, n.objectKind, n.objectID = true, ref[0], ref[1]
		}
		n.prop, n.op = text("prop"), text("op")
		set := v.get("set")
		n.set, n.collection = len(set) == 1 && set[0] == 0x02, v.get("op") != nil
		if n.set && !n.collection {
			n.value, n.valueErr = b.zbDecodeOptional(v.get("value"))
		}
		if span := v.get("selector"); span != nil {
			n.selected = true
			if n.selector, n.valueErr = b.zbDecodeValue(span); n.valueErr != nil {
				n.selector = Nothing
			}
		}
		return n
	}
	n.script, n.grant, n.reason, n.operation = text("script"), text("grant"), text("reason"), text("operation")
	n.capability, n.call, n.scope, n.run, n.segment, n.phase = text("capability"), text("call"), text("scope"), text("run"), text("segment"), text("phase")
	if t, ok := zbInstant(v.get("now")); ok {
		n.now = t
	} else {
		n.nowErr = errZigBinary
	}
	if p.tag == zbEffectNeed {
		var err error
		if n.grants, err = zbTexts(v.get("grants")); err != nil || n.grants == nil {
			n.grants = []string{}
		}
		return n
	}
	if p.tag == zbOpNeed {
		n.args, n.argErr = b.zbDecodeValues(v.get("args"))
		a := v.get("automatic")
		n.automatic = len(a) == 1 && a[0] == 0x02
		if span := v.get("fuelLeft"); span != nil {
			var ok bool
			n.limited = true
			if n.fuelLeft, ok = zbInt(span); !ok {
				n.fuelErr = fmt.Errorf("Zig callback has an invalid fuelLeft")
			}
		}
	}
	return n
}

func (b zigReplyReader) zbDecodeOptional(span []byte) (Value, error) {
	if span == nil {
		return Nothing, nil
	}
	return b.zbDecodeValue(span)
}

// Operation and release needs share this envelope. Read its spans once rather
// than walking the whole JSON object again for each Call field.
type zigCallNeed struct {
	script, grant, now, reason, operation, capability, args zigReply
	call, automatic, scope, run, segment, fuelLeft          zigReply
}

var zigCallNeedKeys = []string{"script", "grant", "now", "reason", "operation", "capability", "args", "call", "automatic", "scope", "run", "segment", "fuelLeft"}

func zigReadCallNeed(need zigReply) zigCallNeed {
	var f [13]zigReply
	need.lookup(zigCallNeedKeys, f[:])
	return zigCallNeed{script: f[0], grant: f[1], now: f[2], reason: f[3], operation: f[4], capability: f[5], args: f[6], call: f[7], automatic: f[8], scope: f[9], run: f[10], segment: f[11], fuelLeft: f[12]}
}

var zigPropertyNeedKeys = []string{"object", "prop", "value", "op"}
