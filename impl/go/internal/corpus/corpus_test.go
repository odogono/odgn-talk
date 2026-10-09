package corpus

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func root(t *testing.T) string {
	t.Helper()
	r, e := filepath.Abs("../../../..")
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestAllCaseSetupsAndTracesRead(t *testing.T) {
	cases, e := Discover(filepath.Join(root(t), "corpus"), nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(cases) < 198 {
		t.Fatal("missing cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if c.Kind == "trace" || c.Kind == "transcript" {
				b, e := os.ReadFile(filepath.Join(c.Dir, "case.trace"))
				if e != nil {
					t.Fatal(e)
				}
				if _, e := ParseTrace(string(b)); e != nil {
					t.Fatal(e)
				}
			}
		})
	}
}
func TestEncodingCasesAndPassingList(t *testing.T) {
	skipUnderRace(t)
	var out bytes.Buffer
	r := Runner{Root: filepath.Join(root(t), "corpus"), Output: &out, Backends: ExecutionBackends()}
	if e := r.CheckPassing(filepath.Join(root(t), "impl/go/corpus-passing.txt")); e != nil {
		t.Fatal(e, out.String())
	}
	if strings.Contains(out.String(), "NEW PASS ") || strings.Count(out.String(), "PASS ") < 50 {
		t.Fatal(out.String())
	}
}
func TestTraceFilledKeysAndValues(t *testing.T) {
	records, e := ParseTrace("> load s identity=abcdef\n> pump clock=2026-09-27T13:30:00Z\n> request d1 to=s message=go args=[2.50 GBP, {a: quote & newline}]\nvars s a=2.50 GBP b=[1, 2]\n")
	if e != nil || len(records) != 4 || records[0].Fields[0].Raw != "abcdef" || records[2].Fields[2].Value.Display() != `[2.50 GBP, {a: quote & newline}]` {
		t.Fatal(records, e)
	}
	for _, s := range []string{"> unknown\n", "> pump\n", "> pump clock=true\n", "> load s identity=ABCDEF\n", "> reload s carry=maybe source=\"x\"\n", "> deliver d1 message=go to=s\n", "> request d1 to=s message=go args=[1,]\n", "> pump clock=2026-09-27T13:30:00Z unknown=1\n"} {
		if _, e := ParseTrace(s); e == nil {
			t.Errorf("accepted %s", s)
		}
	}
	if _, e := ParseTrace("> load s\n"); e != nil {
		t.Fatal("author may omit filled key", e)
	}
	for _, s := range []string{"> save\n", "> deliver to=s message=go\n", "> broadcast message=go\n"} {
		if records, e := ParseTrace(s); e != nil || len(records[0].IDs) != 0 {
			t.Error("author may omit an id the Core assigns", s, e)
		}
	}
	if _, e := ParseTrace("> answer value=1\n"); e == nil {
		t.Error("accepted an answer without its call id")
	}
}
func TestRunnerSelectionSkipsAndDivergence(t *testing.T) {
	corpusRoot := filepath.Join(root(t), "corpus")
	var out bytes.Buffer
	r := Runner{Root: corpusRoot, Output: &out}
	cases, e := Discover(corpusRoot, []string{"bytes/value-encoding"})
	if e != nil || len(cases) != 1 {
		t.Fatal(cases, e)
	}
	if e := r.Run([]string{"bytes/value-encoding"}, false); e != nil || !strings.Contains(out.String(), "PASS bytes/value-encoding (6 lines)") {
		t.Fatal(e, out.String())
	}
	out.Reset()
	if e := r.Run([]string{"bytes/value-encoding"}, true); e != nil || !strings.Contains(out.String(), "supported") {
		t.Fatal(e, out.String())
	}
	if e := r.Run([]string{"text-model/chunk-write-padding"}, false); e == nil {
		t.Fatal("explicit unsupported case must fail")
	}
	if _, e := Discover(corpusRoot, []string{"no-case"}); e == nil {
		t.Fatal("unknown selection")
	}
	e = Compare("test", []string{"one", "two"}, []string{"one", "three"})
	if e == nil || !strings.Contains(e.Error(), "line 2") || !strings.Contains(e.Error(), "expected: two") || !strings.Contains(e.Error(), "actual:   three") {
		t.Fatal(e)
	}
}
func TestSetupRefusesMalformedTOML(t *testing.T) {
	for _, s := range []string{`kind = "encoding"\nkind = "trace"`, `kind = [1,`, `[versions]\nlanguage = "x"\n[versions]`, `kind = "unknown"`, `kind = "encoding"\n[versions]\nlanguage = "wrong"\ncostModel = "0"`} {
		s = strings.ReplaceAll(s, `\n`, "\n")
		if _, e := ReadSetup(s); e == nil {
			t.Errorf("accepted %q", s)
		}
	}
}

func TestTOMLReadsMultiLineLiteralStrings(t *testing.T) {
	for source, want := range map[string]string{
		"s = '''[\"x'); DROP TABLE t; --\"]'''": `["x'); DROP TABLE t; --"]`,
		"s = '''\nraw \\n\nlines'''":            "raw \\n\nlines",
		"s = '''quoted '''''":                   "quoted ''",
	} {
		got, err := ReadTOML(source)
		if err != nil || got["s"] != want {
			t.Errorf("%q gave %q, %v; want %q", source, got["s"], err, want)
		}
	}
	if _, err := ReadTOML("s = '''open"); err == nil {
		t.Error("accepted an unclosed literal")
	}
}

type traceFixture struct{ actual []string }

func (traceFixture) Support(Case) string { return "" }
func (b traceFixture) Run(_ Case, records []Record) ([]string, error) {
	if b.actual != nil {
		return b.actual, nil
	}
	out := make([]string, len(records))
	for i, record := range records {
		out[i] = record.Raw
	}
	return out, nil
}
func TestTraceBackendAndPassingGate(t *testing.T) {
	dir := t.TempDir()
	cdir := filepath.Join(dir, "fixture")
	if e := os.Mkdir(cdir, 0700); e != nil {
		t.Fatal(e)
	}
	setup := "kind = \"trace\"\n[versions]\nlanguage = \"1.0-rc.2\"\ncostModel = \"0\"\n"
	if e := os.WriteFile(filepath.Join(cdir, "case.toml"), []byte(setup), 0600); e != nil {
		t.Fatal(e)
	}
	trace := "> pump clock=2026-09-27T13:30:00Z\npumped state=idle fuel=0\n"
	if e := os.WriteFile(filepath.Join(cdir, "case.trace"), []byte(trace), 0600); e != nil {
		t.Fatal(e)
	}
	list := filepath.Join(dir, "passing.txt")
	if e := os.WriteFile(list, []byte("fixture\n"), 0600); e != nil {
		t.Fatal(e)
	}
	var out bytes.Buffer
	r := Runner{Root: dir, Output: &out, Backends: map[string]Backend{"trace": traceFixture{}}}
	if e := r.CheckPassing(list); e != nil || !strings.Contains(out.String(), "PASS fixture (2 lines)") {
		t.Fatal(e, out.String())
	}
	r.Backends["trace"] = traceFixture{[]string{"> pump clock=2026-09-27T13:30:00Z", "pumped state=idle fuel=1"}}
	out.Reset()
	if e := r.CheckPassing(list); e == nil || !strings.Contains(out.String(), "line 2") {
		t.Fatal(e, out.String())
	}
	r.Backends["trace"] = traceFixture{}
	if e := os.WriteFile(list, nil, 0600); e != nil {
		t.Fatal(e)
	}
	out.Reset()
	if e := r.CheckPassing(list); e != nil || !strings.Contains(out.String(), "NEW PASS fixture") {
		t.Fatal(e, out.String())
	}
	r.Backends["trace"] = traceFixture{[]string{"> pump clock=2026-09-27T13:30:00Z", "pumped state=idle fuel=1"}}
	out.Reset()
	if e := r.CheckPassing(list); e == nil || !strings.Contains(out.String(), "reproduce: go -C impl/go run ./cmd/corpus fixture") {
		t.Fatal("an unlisted failing case must fail the complete gate", e, out.String())
	}
	r.Backends["trace"] = traceFixture{}
	if e := os.WriteFile(list, []byte("missing\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := r.CheckPassing(list); e == nil {
		t.Fatal("missing listed case must fail")
	}
}
