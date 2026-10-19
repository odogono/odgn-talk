//go:build talk_zig_experimental

package northtalk

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"maps"
)

func init() { experimentalCompileLibrary = zigCompileLibrary }

// zigCompileLibrary checks a Library in a Core-owned guest, so neither the
// identity nor the diagnostics come from the Go compiler. The Library keeps
// what each Group's guest needs to compile it again.
func zigCompileLibrary(c *Core, src LibrarySource, imports []*Library, decls GrantDecls) (*Library, error) {
	seen := map[string]*Library{}
	for _, l := range imports {
		if old := seen[l.Name()]; old != nil && old.id != l.id {
			return nil, &HostError{LibraryMismatch, l.Name()}
		}
		seen[l.Name()] = l
	}
	// A new Group reads the Core's Kinds, so it is made outside c.mu.
	c.mu.Lock()
	existing := c.libraryChecker
	c.mu.Unlock()
	if existing == nil {
		made := c.NewGroup(GroupOptions{Name: "library-checker"})
		c.mu.Lock()
		if c.libraryChecker == nil {
			c.libraryChecker = made
		}
		existing = c.libraryChecker
		c.mu.Unlock()
	}
	checker := existing.backend.(*zigGroup)
	checker.reg.librariesMu.Lock()
	defer checker.reg.librariesMu.Unlock()
	for _, l := range imports {
		if err := checker.ensureLibrary(l); err != nil {
			return nil, err
		}
	}
	l := &Library{source: src, imports: append([]*Library(nil), imports...), decls: decls}
	reply, err := checker.compileLibrary(l)
	if err != nil {
		return nil, err
	}
	raw, err := zigBytes(reply.get("identity"))
	if err != nil || len(raw) != 32 {
		return nil, fmt.Errorf("Zig compile-library returned an invalid identity")
	}
	copy(l.id[:], raw)
	// Offered Libraries are compilation inputs; only source imports are
	// dependencies that must be rebuilt after a replacement.
	l.imports = nil
	if len(seen) > 0 {
		for _, name := range usedNamesIn(src.Source) {
			if imported := seen[name]; imported != nil {
				l.imports = append(l.imports, imported)
				delete(seen, name)
			}
		}
	}
	for _, need := range reply.get("needs").items() {
		l.needs = append(l.needs, OperationRef{Capability: zigText(need.get("capability")), Operation: zigText(need.get("operation"))})
	}
	checker.reg.libraries[l.id] = true
	return l, nil
}

// compileLibrary sends one compile-library; the caller holds librariesMu
// and has compiled its imports.
func (b *zigGroup) compileLibrary(l *Library) (zigReply, error) {
	imports := make([]any, len(l.imports))
	for i, imported := range l.imports {
		imports[i] = zigIdentity(imported.id)
	}
	fields := map[string]any{"name": l.source.Name, "version": l.source.Version, "source": l.source.Source, "imports": imports}
	if l.decls != nil {
		decls := map[string]any{}
		for grant, ops := range l.decls {
			declared := map[string]any{}
			for op, check := range ops {
				args := make([]any, len(check.Args))
				for i, arg := range check.Args {
					shape, err := zigShape(arg.inner, 0)
					if err != nil {
						return nil, err
					}
					args[i] = shape
				}
				decl := map[string]any{"mode": modeName(check.Mode), "args": args}
				if check.Command {
					decl["command"] = true
				}
				declared[op] = decl
			}
			decls[grant] = declared
		}
		fields["declarations"] = decls
	}
	return b.send("compile-library", fields)
}

// ensureLibrary compiles l, and first its imports, in this guest once.
func (b *zigGroup) ensureLibrary(l *Library) error {
	if b.reg.libraries[l.id] {
		return nil
	}
	for _, imported := range l.imports {
		if err := b.ensureLibrary(imported); err != nil {
			return err
		}
	}
	reply, err := b.compileLibrary(l)
	if err != nil {
		return err
	}
	raw, _ := zigBytes(reply.get("identity"))
	if hex.EncodeToString(raw) != hex.EncodeToString(l.id[:]) {
		return fmt.Errorf("Zig guest compiled %s to a different identity", l.Name())
	}
	b.reg.libraries[l.id] = true
	return nil
}

func zigIdentity(id [32]byte) map[string]any { return zigByteValue(id[:]) }

func zigByteValue(raw []byte) map[string]any {
	return map[string]any{"$bytes": base64.StdEncoding.EncodeToString(raw)}
}

func zigBytes(v zigReply) ([]byte, error) {
	return base64.StdEncoding.DecodeString(zigText(v.get("$bytes")))
}

func (b *zigGroup) addLibrary(l *Library) error {
	fields := map[string]any{"identity": zigIdentity(l.id)}
	if err := b.beginWorker("add-library", fields); err != nil {
		return err
	}
	defer b.group.endWorker()
	b.reg.librariesMu.Lock()
	err := b.ensureLibrary(l)
	b.reg.librariesMu.Unlock()
	if err != nil {
		return err
	}
	_, err = b.send("add-library", map[string]any{"identity": zigIdentity(l.id)})
	if err == nil {
		b.group.libraries[l.Name()] = l
	}
	return err
}

func (b *zigGroup) replaceLibrary(l *Library, carry CarryOver) ([]Report, error) {
	how := map[CarryOver]string{ResetVariables: "reset variables", CarryVariables: "carry variables"}[carry]
	fields := map[string]any{"identity": zigIdentity(l.id), "carry": how}
	if err := b.beginWorker("replace-library", fields); err != nil {
		return nil, err
	}
	defer b.group.endWorker()
	b.reg.librariesMu.Lock()
	err := b.ensureLibrary(l)
	b.reg.librariesMu.Unlock()
	if err != nil {
		return nil, err
	}
	var reports []Report
	_, err = b.exchange("replace-library", map[string]any{"identity": zigIdentity(l.id), "carry": how}, func(reply zigReply) error {
		result, err := b.pumpReceipt(reply)
		reports = result.Reports
		return err
	})
	if err == nil {
		err = b.commitReplacement(l)
	}
	if reports == nil {
		reports = []Report{}
	}
	return reports, err
}

// Mirror the guest's committed Library set for replay.Libraries. Restore must
// receive the current identities, including rebuilt transitive dependants.
// Refused replacements leave the Host's Library handles untouched.
func (b *zigGroup) commitReplacement(l *Library) error {
	current := b.group.libraries
	next := maps.Clone(current)
	next[l.Name()] = l
	rebuilt := map[string]bool{l.Name(): true}
	var rebuild func(string) error
	rebuild = func(name string) error {
		if rebuilt[name] {
			return nil
		}
		original := current[name]
		imports := make([]*Library, len(original.imports))
		changed := false
		for i, imported := range original.imports {
			if err := rebuild(imported.Name()); err != nil {
				return err
			}
			imports[i] = next[imported.Name()]
			changed = changed || imports[i].id != imported.id
		}
		if changed {
			compiled, err := b.group.core.CompileLibrary(original.source, imports, original.decls)
			if err != nil {
				return err
			}
			next[name] = compiled
		}
		rebuilt[name] = true
		return nil
	}
	for _, name := range sortedKeys(current) {
		if err := rebuild(name); err != nil {
			return err
		}
	}
	b.group.libraries = next
	return nil
}
