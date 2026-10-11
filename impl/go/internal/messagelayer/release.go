package messagelayer

import (
	"encoding/json"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func (s *Session) release(c talk.GrantContext) {
	now, err := instantText(c.Now)
	if err != nil {
		panic(err)
	}
	s.ask(map[string]any{"m": "release", "script": c.ScriptName, "grant": c.GrantName, "reason": c.Reason, "now": now})
}

// worker lets Reload and ReplaceLibrary park on release just as Pump parks
// on Operations. The final reply cannot overtake a release acknowledgement.
func (s *Session) worker(ref int64, name string, f fields) []byte {
	g, err := s.group(f)
	if err != nil {
		return replyFrame(ref, nil, err)
	}
	x := &exchange{ref: ref, group: g, out: make(chan outFrame), results: make(chan fields)}
	s.waiting = x
	go func() {
		ok, err := s.call(name, f)
		x.out <- outFrame{frame: replyFrame(ref, ok, err), final: true}
	}()
	return s.await(x)
}

func carryPolicy(f fields) (talk.CarryOver, error) {
	carry, err := f.bool("carry")
	if err != nil {
		return talk.ResetVariables, err
	}
	if carry {
		return talk.CarryVariables, nil
	}
	return talk.ResetVariables, nil
}

func (s *Session) reload(f fields) (map[string]any, error) {
	g, script, err := s.script(f)
	if err != nil {
		return nil, err
	}
	source, err := f.str("source")
	if err != nil {
		return nil, err
	}
	carry, err := carryPolicy(f)
	if err != nil {
		return nil, err
	}
	keep, err := f.bool("keepMailbox")
	if err != nil {
		return nil, err
	}
	reports, err := script.Reload(source, carry, talk.ReloadOptions{KeepMailbox: keep})
	return g.replacementReply(reports, err)
}

func (g *group) replacementReply(reports []talk.Report, err error) (map[string]any, error) {
	g.settled()
	if err != nil {
		return nil, err
	}
	forms, err := reportForms(reports)
	return map[string]any{"reports": forms, "abandoned": g.abandoned()}, err
}

func (s *Session) library(f fields, key string) (*talk.Library, error) {
	v, err := f.value(key, nil)
	if err != nil {
		return nil, err
	}
	b, ok := v.AsBytes()
	if !ok || len(b) != 32 {
		return nil, protocolErrorf("%s is not a Library identity", key)
	}
	l := s.libraries[[32]byte(b)]
	if l == nil {
		return nil, protocolErrorf("unknown Library identity")
	}
	return l, nil
}

func (s *Session) compileLibrary(f fields) (map[string]any, error) {
	name, err := f.str("name")
	if err != nil {
		return nil, err
	}
	version, err := f.optionalStr("version")
	if err != nil {
		return nil, err
	}
	source, err := f.str("source")
	if err != nil {
		return nil, err
	}
	var imports []*talk.Library
	if f.has("imports") {
		var ids []json.RawMessage
		if err := f.decode("imports", &ids); err != nil {
			return nil, err
		}
		for _, id := range ids {
			l, err := s.library(fields{"identity": id}, "identity")
			if err != nil {
				return nil, err
			}
			imports = append(imports, l)
		}
	}
	declarations := talk.GrantDecls{}
	if f.has("declarations") {
		var ds map[string]map[string]struct {
			Mode string            `json:"mode"`
			Args []json.RawMessage `json:"args"`
		}
		if err := f.decode("declarations", &ds); err != nil {
			return nil, err
		}
		for grant, ops := range ds {
			declarations[grant] = map[string]talk.OperationCheck{}
			for name, op := range ops {
				mode, ok := modes[op.Mode]
				if !ok {
					return nil, protocolErrorf("invalid Operation mode %q", op.Mode)
				}
				check := talk.OperationCheck{Mode: mode}
				for _, arg := range op.Args {
					sh, err := shape(arg)
					if err != nil {
						return nil, err
					}
					check.Args = append(check.Args, sh)
				}
				declarations[grant][name] = check
			}
		}
	}
	l, err := s.core.CompileLibrary(talk.LibrarySource{Name: name, Version: version, Source: source}, imports, declarations)
	if err != nil {
		return nil, err
	}
	id := l.Identity()
	s.libraries[id] = l
	needs := []map[string]string{}
	for _, n := range l.Needs() {
		needs = append(needs, map[string]string{"capability": n.Capability, "operation": n.Operation})
	}
	return map[string]any{"identity": bytesForm(id[:]), "needs": needs}, nil
}

func (s *Session) addLibrary(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	l, err := s.library(f, "identity")
	if err != nil {
		return nil, err
	}
	return nil, g.g.AddLibrary(l)
}

func (s *Session) replaceLibrary(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	l, err := s.library(f, "identity")
	if err != nil {
		return nil, err
	}
	carry, err := carryPolicy(f)
	if err != nil {
		return nil, err
	}
	reports, err := g.g.ReplaceLibrary(l, carry)
	return g.replacementReply(reports, err)
}
