package northtalk

import (
	"context"
	"testing"
	"time"
)

func TestLibraryCallsUseCallerRunAndDefaults(t *testing.T) {
	c := New()
	l, err := c.CompileLibrary(LibrarySource{Name: "maths", Version: "1", Source: "constant offset = 2\nfunction bump n, times = 3\n return n * times + offset\nend bump\n"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use bump from maths\non go\n return bump(4)\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatalf("Library call did not finish: %+v", result)
	}
	v, failure := p.Result()
	if failure != nil || !v.Equal(Int(14)) {
		t.Fatalf("result %v, failure %v", v, failure)
	}
	if s.Counters().Runs != 1 || result.FuelUsed == 0 {
		t.Fatal("Library did not charge the calling Run")
	}
}

func TestLibraryRejectsScriptStateAndMessageFacilities(t *testing.T) {
	for _, source := range []string{"script variable n\n", "function f\n return me\nend f\n", "function f\n return the target\nend f\n", "on f\n send go to other\nend f\n", "on f\n pass f\nend f\n"} {
		t.Run(source, func(t *testing.T) {
			_, err := New().CompileLibrary(LibrarySource{Name: "bad", Source: source}, nil, nil)
			if err == nil {
				t.Fatal("invalid Library compiled")
			}
			rejected, ok := err.(*LoadError)
			if !ok {
				t.Fatal(err)
			}
			for _, d := range rejected.Diagnostics {
				if d.Code == "not in a library" {
					return
				}
			}
			t.Fatal(rejected.Diagnostics)
		})
	}
}

func TestStandardLibraryExecutesNormativeBytesSource(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "use toHex from bytes\non go\n return toHex(<<0xCA, 0xFE>>)\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, _ := s.Request(context.Background(), Message{Name: "go"})
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, failure := p.Result()
	if failure != nil || v.String() != `"cafe"` {
		t.Fatalf("%v, %v", v, failure)
	}
}

func TestStandardLibraryCatalogueErrorsNameCaller(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "use pad from text\non go\n try\n  return pad(\"x\", -1)\n catch e\n  return e\n end try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, _ := s.Request(context.Background(), Message{Name: "go"})
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, failure := p.Result()
	if failure != nil || v.Get("code").String() != `"out of domain"` || v.Get("message").Kind() != KindText || v.Get("at").Get("unit").String() != `"s"` {
		t.Fatalf("%v, %v", v, failure)
	}
}

func TestImportedWaitingHandlerRequiresWaitAndRetainsLibraryFrame(t *testing.T) {
	c := New()
	l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: "on pause n\n wait 1 ms\n return n\nend pause\n"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "bad", Source: "use pause from helper\non go\n pause 2\nend go\n"}); err == nil {
		t.Error("plain call to imported waiting Handler loaded")
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use pause from helper\non go\n pause 2 and wait\n return it\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, _ := s.Request(context.Background(), Message{Name: "go"})
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
		t.Fatal("Library wait did not suspend")
	default:
	}
	if _, err := g.Pump(time.Unix(0, 1000000), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, failure := p.Result()
	if failure != nil || !v.Equal(Int(2)) {
		t.Fatalf("%v, %v", v, failure)
	}
}

func TestLibraryImportClashesWithLaterLocalHandler(t *testing.T) {
	c := New()
	l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: "on task\n return 1\nend task\n"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "s", Source: "use task from helper\non task\n return 2\nend task\n"})
	if err == nil {
		t.Fatal("import collided with a local Handler without rejection")
	}
}

func TestLibraryRejectsCallsToImporterHandlers(t *testing.T) {
	_, err := New().CompileLibrary(LibrarySource{Name: "helper", Source: "on go\n callerOnly\nend go\n"}, nil, nil)
	if err == nil {
		t.Fatal("Library may call a Handler on its importer")
	}
}

func TestLibraryConstantsAndDefaultsBindFunctionsToEachCaller(t *testing.T) {
	c := New()
	l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: "constant box = {f: given x: x + 1}\nfunction apply x, callbacks = box\n put the f of callbacks into f\n return f(x)\nend apply\n"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b"} {
		g := c.NewGroup(GroupOptions{})
		if err := g.AddLibrary(l); err != nil {
			t.Fatal(err)
		}
		s, err := g.Load(LoadOptions{Name: name, Source: "use box, apply from helper\non go\n put the f of box into f\n return [f(2), apply(4)]\nend go\n"})
		if err != nil {
			t.Fatal(err)
		}
		_, p, err := s.Request(context.Background(), Message{Name: "go"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		v, failure := p.Result()
		if failure != nil || v.String() != "[3, 5]" {
			t.Fatalf("caller %s: %v, %v", name, v, failure)
		}
	}
}

func TestLibraryIdentityIncludesImportsAndRegistrationIsAtomic(t *testing.T) {
	c := New()
	compile := func(src LibrarySource, imports ...*Library) *Library {
		t.Helper()
		l, err := c.CompileLibrary(src, imports, nil)
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	a := compile(LibrarySource{Name: "base", Version: "one", Source: "constant n = 1\n"})
	alias := compile(LibrarySource{Name: "base", Version: "two", Source: a.Source()})
	if a.Identity() != alias.Identity() {
		t.Fatal("Host version label affected identity")
	}
	b := compile(LibrarySource{Name: "base", Source: "constant n = 2\n"})
	src := LibrarySource{Name: "top", Source: "use n from base\nfunction read\n return n\nend read\n"}
	top, changed := compile(src, a), compile(src, b)
	if top.Identity() == changed.Identity() {
		t.Fatal("dependency identity omitted")
	}
	imports := top.Imports()
	imports[0] = b
	if top.Imports()[0] != a {
		t.Fatal("Imports exposed mutable storage")
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(top); err == nil {
		t.Fatal("accepted missing dependency")
	}
	if err := g.AddLibrary(a); err != nil {
		t.Fatal(err)
	}
	if err := g.AddLibrary(changed); err == nil {
		t.Fatal("accepted mismatched dependency")
	}
	if err := g.AddLibrary(top); err != nil {
		t.Fatal("failed registration mutated Group:", err)
	}
	if _, err := c.CompileLibrary(LibrarySource{Name: "base", Source: "use read from top\n"}, []*Library{top}, nil); err == nil {
		t.Fatal("accepted transitive name cycle")
	}
	if _, err := c.CompileLibrary(LibrarySource{Name: "loop", Source: "use f from loop\n"}, nil, nil); err == nil {
		t.Fatal("accepted self cycle")
	}
}

func TestLibraryBinaryConstructionUsesLibraryConstantPool(t *testing.T) {
	c := New()
	l, err := c.CompileLibrary(LibrarySource{Name: "packet", Source: "function header n\n return <<n as 4 bits, 15 as 4 bits>>\nend header\n"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use header from packet\non go\n return header(1)\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, failure := p.Result()
	if failure != nil || !v.Equal(Bytes([]byte{0x1f})) {
		t.Fatalf("%v, %v", v, failure)
	}
}

func TestLibraryPrivateAndImportedNamesAreNotReexported(t *testing.T) {
	c := New()
	base, err := c.CompileLibrary(LibrarySource{Name: "base", Source: "constant public = 1\nprivate constant hidden = 2\n"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	top, err := c.CompileLibrary(LibrarySource{Name: "top", Source: "use public from base\nconstant own = public\n"}, []*Library{base}, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	for _, l := range []*Library{base, top} {
		if err := g.AddLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	for _, source := range []string{"use hidden from base\n", "use public from top\n"} {
		if _, err := g.Load(LoadOptions{Name: "s", Source: source}); err == nil {
			t.Fatal("accepted nonexported name:", source)
		}
	}
}

func TestLibraryNeedsAreImmutableAndImportsRequireGrants(t *testing.T) {
	c := New()
	source := LibrarySource{Name: "helper", Source: "private function unused\n ask db to write\n return it\nend unused\nfunction read\n ask db to read\n return it\nend read\n"}
	decls := GrantDecls{"db": {"read": {Mode: Immediate}, "write": {Mode: Immediate}}}
	l, err := c.CompileLibrary(source, nil, decls)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.CompileLibrary(source, nil, nil); err == nil {
		t.Fatal("cached code bypassed declaration checks")
	}
	needs := l.Needs()
	if len(needs) != 2 || needs[0] != (OperationRef{"db", "read"}) || needs[1] != (OperationRef{"db", "write"}) {
		t.Fatal(needs)
	}
	needs[0].Operation = "changed"
	if l.Needs()[0].Operation != "read" {
		t.Fatal("Needs exposed mutable storage")
	}
	top, err := c.CompileLibrary(LibrarySource{Name: "wrapper", Source: "use read from helper\nfunction call\n return read()\nend call\n"}, []*Library{l}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(top.Needs()) != 2 || top.Needs()[1] != (OperationRef{"db", "write"}) {
		t.Fatal("transitive needs:", top.Needs())
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "s", Source: "use read from helper\non go\n return read()\nend go\n"})
	if err == nil {
		t.Fatal("import without Library Grants loaded")
	}
}
