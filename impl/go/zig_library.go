//go:build talk_zig_experimental

package northtalk

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
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
	c.mu.Lock()
	if c.libraryChecker == nil {
		c.libraryChecker = c.NewGroup(GroupOptions{Name: "library-checker"})
	}
	checker := c.libraryChecker.backend.(*zigGroup)
	c.mu.Unlock()
	checker.librariesMu.Lock()
	defer checker.librariesMu.Unlock()
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
	raw, err := base64.StdEncoding.DecodeString(zigText(reply.Get("identity").Get("$bytes")))
	if err != nil || len(raw) != 32 {
		return nil, fmt.Errorf("Zig compile-library returned an invalid identity")
	}
	copy(l.id[:], raw)
	needs := reply.Get("needs")
	for i := 1; i <= needs.Len(); i++ {
		l.needs = append(l.needs, OperationRef{Capability: zigText(needs.Index(i).Get("capability")), Operation: zigText(needs.Index(i).Get("operation"))})
	}
	checker.libraries[l.id] = true
	return l, nil
}

// compileLibrary sends one compile-library; the caller holds librariesMu
// and has compiled its imports.
func (b *zigGroup) compileLibrary(l *Library) (Value, error) {
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
						return Nothing, err
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
	if b.libraries[l.id] {
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
	raw, _ := base64.StdEncoding.DecodeString(zigText(reply.Get("identity").Get("$bytes")))
	if hex.EncodeToString(raw) != hex.EncodeToString(l.id[:]) {
		return fmt.Errorf("Zig guest compiled %s to a different identity", l.Name())
	}
	b.libraries[l.id] = true
	return nil
}

func zigIdentity(id [32]byte) map[string]any {
	return map[string]any{"$bytes": base64.StdEncoding.EncodeToString(id[:])}
}

func (b *zigGroup) addLibrary(l *Library) error {
	fields := map[string]any{"identity": zigIdentity(l.id)}
	if err := b.beginWorker("add-library", fields); err != nil {
		return err
	}
	defer b.group.endWorker()
	b.librariesMu.Lock()
	err := b.ensureLibrary(l)
	b.librariesMu.Unlock()
	if err != nil {
		return err
	}
	_, err = b.send("add-library", map[string]any{"identity": zigIdentity(l.id)})
	return err
}

func (b *zigGroup) replaceLibrary(l *Library, carry CarryOver) ([]Report, error) {
	how := map[CarryOver]string{ResetVariables: "reset variables", CarryVariables: "carry variables"}[carry]
	fields := map[string]any{"identity": zigIdentity(l.id), "carry": how}
	if err := b.beginWorker("replace-library", fields); err != nil {
		return nil, err
	}
	defer b.group.endWorker()
	b.librariesMu.Lock()
	err := b.ensureLibrary(l)
	b.librariesMu.Unlock()
	if err != nil {
		return nil, err
	}
	var reports []Report
	_, err = b.exchange("replace-library", map[string]any{"identity": zigIdentity(l.id), "carry": how}, func(reply Value) error {
		result, err := b.pumpReceipt(reply)
		reports = result.Reports
		return err
	})
	if reports == nil {
		reports = []Report{}
	}
	return reports, err
}
