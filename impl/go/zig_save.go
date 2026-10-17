//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

func init() { experimentalRestore = zigRestore }

func (b *zigGroup) save() ([]byte, error) {
	reply, err := b.worker("save", map[string]any{})
	if err != nil {
		return nil, err
	}
	return zigBytes(reply.Get("save"))
}

func (b *zigGroup) fingerprint() [32]byte {
	reply, err := b.worker("fingerprint", map[string]any{})
	if err != nil {
		panic(err)
	}
	raw, err := zigBytes(reply.Get("fingerprint"))
	if err != nil || len(raw) != 32 {
		panic(fmt.Errorf("Zig fingerprint returned an invalid digest: %v", err))
	}
	return [32]byte(raw)
}

// The guest alone reads its opaque save. Go rebuilds only Host bindings,
// handles and Call contexts, before publishing the restore's Trace.
func zigRestore(c *Core, save []byte, o RestoreOptions) (_ *Group, result RestoreResult, err error) {
	g := &Group{core: c, options: GroupOptions{Name: o.Name, Trace: o.Trace, OnReady: o.OnReady}, libraries: map[string]*Library{}, objects: map[objectKey]*Object{}}
	b := newZigBackend(g)
	g.backend = b
	b.restoreOptions = &o
	b.restoredCalls = map[CallID]*Call{}
	defer func() {
		b.restoreOptions = nil
		if err != nil {
			b.reactor.Close(context.Background())
		}
	}()
	if err = g.beginWorker(); err != nil {
		return nil, result, err
	}
	defer g.endWorker()
	if err = b.syncKinds(); err != nil {
		return nil, result, err
	}
	libraries := make([]any, len(o.Libraries))
	for i, l := range o.Libraries {
		if l == nil {
			return nil, result, g.refuse(InvalidValue, "nil Library")
		}
		if err = b.ensureLibrary(l); err != nil {
			return nil, result, err
		}
		libraries[i] = zigIdentity(l.id)
		g.libraries[l.Name()] = l
	}
	policy, ok := map[MismatchPolicy]string{RejectMismatch: "reject", VariablesOnly: "variables only"}[o.Mismatch]
	if !ok {
		return nil, result, g.refuse(InvalidValue, "invalid mismatch policy")
	}
	_, err = b.exchange("restore", map[string]any{"save": zigByteValue(save), "name": o.Name, "trace": o.Trace != nil, "libraries": libraries, "mismatch": policy}, func(reply Value) error {
		return b.restoreReceipt(reply, &result)
	})
	if err != nil {
		return nil, RestoreResult{}, err
	}
	return g, result, nil
}

func (b *zigGroup) restoreBindings(need Value) (map[string]any, error) {
	o := b.restoreOptions
	if o == nil {
		return nil, fmt.Errorf("unexpected Zig restore callback")
	}
	asked := need.Get("grants")
	grants := make([]any, asked.Len())
	for i := range grants {
		pair := asked.Index(i + 1)
		script, name := zigText(pair.Index(1)), zigText(pair.Index(2))
		var offered *Grant
		if o.Grants != nil {
			offered = o.Grants(script, name)
		}
		if offered == nil || offered.definition == nil {
			continue
		}
		wire, kept, err := b.grants(map[string]*Grant{name: offered})
		if err != nil {
			return nil, err
		}
		grants[i] = wire[name]
		s := b.group.Script(script)
		if s == nil {
			s = b.newRestoredScript(script)
			b.group.scripts = append(b.group.scripts, s)
		}
		s.grants[name] = kept[name]
	}
	asked = need.Get("objects")
	objects := make([]bool, asked.Len())
	for i := range objects {
		pair := asked.Index(i + 1)
		kind, id := zigText(pair.Index(1)), zigText(pair.Index(2))
		var native any
		if o.Resolve != nil {
			native, objects[i] = o.Resolve(kind, id)
		}
		b.restoreObject(kind, id, native)
	}
	return map[string]any{"grants": grants, "objects": objects}, nil
}

func (b *zigGroup) newRestoredScript(name string) *Script {
	return &Script{group: b.group, name: name, grants: map[string]*Grant{}}
}

func (b *zigGroup) restoreObject(kind, id string, native any) {
	key := objectKey{kind, id}
	if b.group.objects[key] != nil {
		return
	}
	b.group.core.mu.Lock()
	definition := b.group.core.objectKinds[kind]
	b.group.core.mu.Unlock()
	// The guest can retain an unavailable Kind as disposed identity only.
	if definition == nil {
		definition = &ObjectKind{name: kind, props: map[string]Prop{}}
	}
	b.group.objects[key] = &Object{group: b.group, kind: definition, id: id, native: native}
}

func (b *zigGroup) restoreReceipt(reply Value, result *RestoreResult) error {
	// Resolution order need not be load order; ScriptNames must retain it.
	names := reply.Get("scripts")
	scripts := make([]*Script, 0, names.Len())
	for i := 1; i <= names.Len(); i++ {
		name := zigText(names.Index(i))
		s := b.group.Script(name)
		if s == nil {
			s = b.newRestoredScript(name)
		}
		scripts = append(scripts, s)
	}
	b.group.scripts = scripts
	objects := reply.Get("objects")
	for i := 1; i <= objects.Len(); i++ {
		pair := objects.Index(i)
		b.restoreObject(zigText(pair.Index(1)), zigText(pair.Index(2)), nil)
	}
	// PendingCall's wire keys and Operation identity differ from its public
	// Go representation. Run/Segment/Clock belong to the adopted Host Call.
	pending := reply.Get("pending")
	for i := 1; i <= pending.Len(); i++ {
		row := pending.Index(i)
		p := PendingCall{ID: CallID(zigText(row.Get("call"))), Script: zigText(row.Get("script")), Grant: zigText(row.Get("grant"))}
		p.Operation = OperationRef{Capability: zigText(row.Get("capability")), Operation: zigText(row.Get("operation"))}
		var binding any
		if grant := b.group.Script(p.Script).grants[p.Grant]; grant != nil {
			p.Operation.Capability, binding = grant.definition.name, grant.binding
		}
		if err := b.decode(row.Get("args"), reflect.ValueOf(&p.Args).Elem()); err != nil {
			return err
		}
		now, err := time.Parse(time.RFC3339Nano, zigText(row.Get("now")))
		if err != nil {
			return err
		}
		ctx, cancel := operationContext(Suspending)
		call := &Call{group: b.group, id: p.ID, scriptName: p.Script, grantName: p.Grant, binding: binding, runID: RunID(zigText(row.Get("run"))), segmentID: zigText(row.Get("segment")), now: now, context: ctx}
		b.restoredCalls[p.ID] = call
		b.calls[p.ID] = cancel
		result.Pending = append(result.Pending, p)
	}
	for _, field := range []struct {
		name string
		dst  any
	}{{"variablesOnly", &result.VariablesOnly}, {"discardedRuns", &result.DiscardedRuns}, {"droppedMessages", &result.DroppedMessages}, {"abandonedCalls", &result.AbandonedCalls}} {
		if err := b.decode(reply.Get(field.name), reflect.ValueOf(field.dst).Elem()); err != nil {
			return err
		}
	}
	disposed := reply.Get("disposed")
	for i := 1; i <= disposed.Len(); i++ {
		pair := disposed.Index(i)
		result.Disposed = append(result.Disposed, ObjectRef{Kind: zigText(pair.Index(1)), ID: zigText(pair.Index(2))})
	}
	reports, err := b.pumpReceipt(reply)
	result.Reports = reports.Reports
	return err
}

func (b *zigGroup) settle(id CallID, s Settlement) (*Call, error) {
	settlement := map[string]any{}
	if s.Answer != nil {
		v, err := b.zigEncoded(*s.Answer)
		if err != nil {
			return nil, err
		}
		settlement["answer"] = v
	}
	if s.Fail != nil {
		e, err := b.zigScriptFailure(s.Fail)
		if err != nil {
			return nil, err
		}
		settlement["fail"] = e
	}
	if s.Reissue {
		settlement["reissue"] = true
	}
	if s.Adopt {
		settlement["adopt"] = true
	}
	var call *Call
	_, err := b.exchange("settle", map[string]any{"call": string(id), "settlement": settlement}, func(Value) error {
		call = b.restoredCalls[id]
		delete(b.restoredCalls, id)
		return nil
	})
	if err != nil {
		return nil, err
	}
	b.ready()
	if s.Adopt {
		return call, nil
	}
	return nil, nil
}
