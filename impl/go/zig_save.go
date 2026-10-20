package northtalk

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

func (b *zigGroup) save() ([]byte, error) {
	reply, err := b.worker("save", map[string]any{})
	if err != nil {
		return nil, err
	}
	return zigBytes(reply.get("save"))
}

func (b *zigGroup) fingerprint() [32]byte {
	reply, err := b.worker("fingerprint", map[string]any{})
	if err != nil {
		panic(err)
	}
	raw, err := zigBytes(reply.get("fingerprint"))
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
	_, err = b.exchangeDecoded("restore", map[string]any{"save": zigByteValue(save), "name": o.Name, "trace": o.Trace != nil, "libraries": libraries, "mismatch": policy}, func(reply zigResponse) error {
		if reply.failure != nil {
			return nil
		}
		return b.restoreReceipt(reply, &result)
	})
	if err != nil {
		return nil, RestoreResult{}, err
	}
	return g, result, nil
}

func (b *zigGroup) restoreBindings(need *zigNeed) (map[string]any, error) {
	o := b.restoreOptions
	if o == nil {
		return nil, fmt.Errorf("unexpected Zig restore callback")
	}
	asked := need.bindGrants
	grants := make([]any, len(asked))
	for i, pair := range asked {
		script, name := pair[0], pair[1]
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
	asked = need.bindObjects
	objects := make([]bool, len(asked))
	for i, pair := range asked {
		kind, id := pair[0], pair[1]
		var native any
		if o.Resolve != nil {
			native, objects[i] = o.Resolve(kind, id)
		}
		b.restoreObject(kind, id, native, !objects[i])
	}
	return map[string]any{"grants": grants, "objects": objects}, nil
}

func (b *zigGroup) newRestoredScript(name string) *Script {
	return &Script{group: b.group, name: name, grants: map[string]*Grant{}}
}

func (b *zigGroup) restoreObject(kind, id string, native any, disposed bool) {
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
	object := &Object{group: b.group, kind: definition, id: id, native: native}
	object.disposed.Store(disposed)
	b.group.objects[key] = object
}

func (b *zigGroup) restoreReceipt(response zigResponse, result *RestoreResult) error {
	reply := response.body
	// Resolution order need not be load order; ScriptNames must retain it.
	names := reply.get("scripts").items()
	scripts := make([]*Script, 0, len(names))
	for _, raw := range names {
		name := zigText(raw)
		s := b.group.Script(name)
		if s == nil {
			s = b.newRestoredScript(name)
		}
		scripts = append(scripts, s)
	}
	b.group.scripts = scripts
	for _, pair := range reply.get("objects").items() {
		kind, id := zigTextPair(pair)
		// A handle not requested during resolution was already disposed in
		// the save. Existing resolved handles retain their resolution result.
		b.restoreObject(kind, id, nil, true)
	}
	// PendingCall's wire keys and Operation identity differ from its public
	// Go representation. Run/Segment/Clock belong to the adopted Host Call.
	for _, row := range reply.get("pending").items() {
		p := PendingCall{ID: CallID(zigText(row.get("call"))), Script: zigText(row.get("script")), Grant: zigText(row.get("grant"))}
		p.Operation = OperationRef{Capability: zigText(row.get("capability")), Operation: zigText(row.get("operation"))}
		var binding any
		if grant := b.group.Script(p.Script).grants[p.Grant]; grant != nil {
			p.Operation.Capability, binding = grant.definition.name, grant.binding
		}
		if err := b.decode(row.get("args"), reflect.ValueOf(&p.Args).Elem()); err != nil {
			return err
		}
		now, err := time.Parse(time.RFC3339Nano, zigText(row.get("now")))
		if err != nil {
			return err
		}
		ctx, cancel := operationContext(Suspending)
		call := &Call{group: b.group, id: p.ID, scriptName: p.Script, grantName: p.Grant, binding: binding, runID: RunID(zigText(row.get("run"))), segmentID: zigText(row.get("segment")), now: now, context: ctx}
		b.restoredCalls[p.ID] = call
		b.calls[p.ID] = cancel
		result.Pending = append(result.Pending, p)
	}
	for _, field := range []struct {
		name string
		dst  any
	}{{"variablesOnly", &result.VariablesOnly}, {"discardedRuns", &result.DiscardedRuns}, {"droppedMessages", &result.DroppedMessages}, {"abandonedCalls", &result.AbandonedCalls}} {
		if err := b.decode(reply.get(field.name), reflect.ValueOf(field.dst).Elem()); err != nil {
			return err
		}
	}
	for _, pair := range reply.get("disposed").items() {
		kind, id := zigTextPair(pair)
		result.Disposed = append(result.Disposed, ObjectRef{Kind: kind, ID: id})
	}
	reports, err := b.completePump(response.completion)
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
	_, err := b.exchange("settle", map[string]any{"call": string(id), "settlement": settlement}, func(zigReply) error {
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
