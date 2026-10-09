package northtalk

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

type sqliteHost struct {
	query  func(*Call, string, SqlParams, int64) (SqlRows, error)
	change func(*Call, string, SqlParams, int64) (SqlRows, error)
	life   *SegmentLifecycle
}

func (h *sqliteHost) Coordinator(string) *SegmentLifecycle { return h.life }
func (h *sqliteHost) Query(c *Call, sql string, p SqlParams, max int64) (SqlRows, error) {
	return h.query(c, sql, p, max)
}
func (h *sqliteHost) Change(c *Call, sql string, p SqlParams, max int64) (SqlRows, error) {
	return h.change(c, sql, p, max)
}
func (h *sqliteHost) Begin(*Call) error    { return nil }
func (h *sqliteHost) Commit(*Call) error   { return nil }
func (h *sqliteHost) Rollback(*Call) error { return nil }

func newSqliteHost() *sqliteHost {
	ok := func(SegmentContext) EffectResult { return EffectResult{Status: EffectOK} }
	empty := func(*Call, string, SqlParams, int64) (SqlRows, error) { return SqlRows{}, nil }
	return &sqliteHost{query: empty, change: empty, life: &SegmentLifecycle{Begin: ok, Commit: ok, Rollback: ok}}
}

func sqliteCosts() Costs {
	return Costs{"query": {}, "change": {}, "begin": {}, "commit": {}, "rollback": {}}
}

// sqliteCalls runs body and gives its `call` Trace lines.
func sqliteCalls(t *testing.T, body string, h *sqliteHost, perRow int64) []string {
	t.Helper()
	core := New()
	def, err := core.SqliteCapability(h, sqliteCosts(), perRow)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := def.Grant([]string{"query", "change", "begin", "commit", "rollback"}, SqliteBinding{Database: "main", MaxRows: 10})
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	group := core.NewGroup(GroupOptions{Trace: &trace})
	script, err := group.Load(LoadOptions{Name: "s", Source: "on go\n" + body + "\nend go", Grants: map[string]*Grant{"db": grant}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := script.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := group.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, line := range trace {
		if strings.HasPrefix(line, "call ") || strings.HasPrefix(line, "call-failed ") {
			out = append(out, line)
		}
	}
	return out
}

func TestSqliteFactoryRefusals(t *testing.T) {
	core := New()
	var host *HostError
	if _, err := core.SqliteCapability(nil, sqliteCosts(), 0); !errors.As(err, &host) || host.Code != InvalidValue {
		t.Fatalf("nil impl: %v", err)
	}
	var typedNil *sqliteHost
	if _, err := core.SqliteCapability(typedNil, sqliteCosts(), 0); !errors.As(err, &host) {
		t.Fatalf("typed nil impl: %v", err)
	}
	for _, perRow := range []int64{-1, 9007199254740992} {
		if _, err := core.SqliteCapability(newSqliteHost(), sqliteCosts(), perRow); !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("perRow %d: %v", perRow, err)
		}
	}
	if _, err := core.SqliteCapability(newSqliteHost(), Costs{"query": {}}, 0); !errors.As(err, &host) {
		t.Fatalf("missing costs: %v", err)
	}
	def, err := core.SqliteCapability(newSqliteHost(), sqliteCosts(), 9007199254740991)
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range []any{nil, "main", SqliteBinding{Database: "main", MaxRows: -1}, SqliteBinding{MaxRows: 9007199254740992}, (*SqliteBinding)(nil)} {
		if _, err := def.Grant([]string{"query"}, binding); !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("binding %#v: %v", binding, err)
		}
	}
	for _, binding := range []any{SqliteBinding{Database: "main"}, &SqliteBinding{Database: "main", Tables: []string{"t"}, MaxRows: 9007199254740991}} {
		if _, err := def.Grant([]string{"query"}, binding); err != nil {
			t.Fatalf("binding %#v: %v", binding, err)
		}
	}
}

func TestSqliteParamsConversion(t *testing.T) {
	h := newSqliteHost()
	var got []SqlParams
	var maxes []int64
	h.query = func(_ *Call, _ string, p SqlParams, max int64) (SqlRows, error) {
		got = append(got, p)
		maxes = append(maxes, max)
		return SqlRows{}, nil
	}
	sqliteCalls(t, `ask db to query "q", [nothing, 1, 1.0, 1.5, 9223372036854775807, 9223372036854775808, true, false, "é"], 3
ask db to query "q", {a: 2, b: <<0x01, 0xFF>>}
ask db to query "q", [], 4.00`, h, 0)
	want := []SqlParams{
		{List: []SqlValue{nil, int64(1), 1.0, 1.5, int64(math.MaxInt64), 9223372036854775808.0, int64(1), int64(0), "é"}},
		{Named: map[string]SqlValue{"a": int64(2), "b": []byte{1, 0xFF}}},
		{List: []SqlValue{}},
	}
	if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(maxes, []int64{3, 10, 4}) {
		t.Fatalf("got %#v %v", got, maxes)
	}
	if _, isFloat := got[0].List[2].(float64); !isFloat {
		t.Fatalf("1.0 must bind as REAL: %T", got[0].List[2])
	}
}

// Argument checks run before the charge, and the Host is never reached.
func TestSqliteArgumentErrorFields(t *testing.T) {
	h := newSqliteHost()
	h.query = func(*Call, string, SqlParams, int64) (SqlRows, error) {
		t.Fatal("reached the Host")
		return SqlRows{}, nil
	}
	h.change = h.query
	for _, test := range []struct{ body, want string }{
		{`ask db to query "q", [], 11`, `code: "out of range", field: "max", value: 11`},
		{`ask db to query "q", [], 1.5`, `field: "max", value: 1.5`},
		{`ask db to query "q", [], -1`, `field: "max", value: -1`},
		{`ask db to query "q", 3`, `expected: "list or map", got: "number", value: 3, capability: "db", operation: "query", argument: 2, at:`},
		{`ask db to query "q", [1, [2]]`, `got: "list", value: [2], capability: "db", operation: "query", argument: 2, path: [2], at:`},
		{`ask db to change "q", {k: {}}`, `got: "map", value: {}, capability: "db", operation: "change", argument: 2, path: ["k"], at:`},
	} {
		core := New()
		def, _ := core.SqliteCapability(h, sqliteCosts(), 0)
		grant, _ := def.Grant([]string{"query", "change"}, SqliteBinding{Database: "main", MaxRows: 10})
		var trace lines
		group := core.NewGroup(GroupOptions{Trace: &trace})
		script, err := group.Load(LoadOptions{Name: "s", Source: "on go\n" + test.body + "\nend go", Grants: map[string]*Grant{"db": grant}})
		if err != nil {
			t.Fatal(err)
		}
		script.Deliver(Message{Name: "go"})
		group.Pump(time.Unix(0, 0), PumpOptions{})
		if joined := strings.Join(trace, "\n"); !strings.Contains(joined, test.want) {
			t.Fatalf("%s: want %s in\n%s", test.body, test.want, joined)
		}
	}
}

func TestSqliteResultConversion(t *testing.T) {
	h := newSqliteHost()
	h.query = func(*Call, string, SqlParams, int64) (SqlRows, error) {
		return SqlRows{Columns: []string{"n", "r", "t", "b", "z"}, Rows: [][]SqlValue{{int64(-7), 0.1, "é", []byte{0xAB}, nil}}}, nil
	}
	h.change = func(*Call, string, SqlParams, int64) (SqlRows, error) {
		return SqlRows{Columns: []string{}, Rows: [][]SqlValue{{}}, Changes: 3}, nil
	}
	lines := sqliteCalls(t, `ask db to query "q", []
ask db to change "q", []`, h, 0)
	want := []string{
		`call s/r1.c1 op=db.query args=["q", []] result=[{n: -7, r: 0.1, t: "é", b: <<0xAB>>, z: nothing}]`,
		`call s/r1.c2 op=db.change args=["q", []] result={changes: 3, rows: [{}]}`,
	}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("got\n%s", strings.Join(lines, "\n"))
	}
}

func TestSqliteResultFailures(t *testing.T) {
	for _, test := range []struct {
		name  string
		rows  SqlRows
		err   error
		want  string
		host  bool
		max   string
		query bool
	}{
		{name: "duplicate", rows: SqlRows{Columns: []string{"é", "é"}, Rows: [][]SqlValue{}}, want: `error={code: "sql", reason: "duplicate column é"}`},
		{name: "duplicate first", rows: SqlRows{Columns: []string{"a", "a"}, Rows: [][]SqlValue{{struct{}{}, math.NaN()}}}, want: `error={code: "sql", reason: "duplicate column a"}`},
		{name: "nan", rows: SqlRows{Columns: []string{"x"}, Rows: [][]SqlValue{{math.NaN()}}}, want: `error={code: "unrepresentable", column: "x"}`},
		{name: "inf", rows: SqlRows{Columns: []string{"x"}, Rows: [][]SqlValue{{math.Inf(-1)}}}, want: `error={code: "unrepresentable", column: "x"}`},
		{name: "huge", rows: SqlRows{Columns: []string{"x"}, Rows: [][]SqlValue{{1e34}}}, want: `error={code: "unrepresentable", column: "x"}`},
		{name: "utf8", rows: SqlRows{Columns: []string{"y"}, Rows: [][]SqlValue{{"\xff"}}}, want: `error={code: "unrepresentable", column: "y"}`},
		{name: "go type", rows: SqlRows{Columns: []string{"x"}, Rows: [][]SqlValue{{3}}}, host: true},
		{name: "short row", rows: SqlRows{Columns: []string{"x"}, Rows: [][]SqlValue{{}}}, host: true},
		{name: "too many", rows: SqlRows{Columns: []string{}, Rows: [][]SqlValue{{}, {}}}, max: ", 1", host: true},
		{name: "negative changes", rows: SqlRows{Columns: []string{}, Changes: -1}, host: true},
		{name: "huge changes", rows: SqlRows{Columns: []string{}, Changes: 9007199254740992}, host: true},
		{name: "plain error", err: errors.New("boom"), host: true},
		{name: "busy", err: &ScriptError{Code: "sqlite busy"}, want: `error={code: "sqlite busy"}`},
		{name: "bad constraint", err: &ScriptError{Code: "constraint", Data: mustMap(t, KV("kind", mustPublicText("odd")))}, host: true},
		{name: "not read-only on change", err: &ScriptError{Code: "not read-only"}, host: true},
	} {
		h := newSqliteHost()
		h.change = func(*Call, string, SqlParams, int64) (SqlRows, error) { return test.rows, test.err }
		lines := sqliteCalls(t, `ask db to change "q", []`+test.max, h, 0)
		joined := strings.Join(lines, "\n")
		if test.host {
			if len(lines) != 2 || !strings.HasPrefix(lines[1], "call-failed ") {
				t.Fatalf("%s: want host error, got\n%s", test.name, joined)
			}
		} else if len(lines) != 1 || !strings.HasSuffix(lines[0], test.want) {
			t.Fatalf("%s: want %s, got\n%s", test.name, test.want, joined)
		}
	}
}

func TestSqliteChargesRows(t *testing.T) {
	h := newSqliteHost()
	lines := sqliteCalls(t, `ask db to query "q", [], 4
ask db to query "q", []`, h, 3)
	if !strings.Contains(lines[0], "charged=12") || !strings.Contains(lines[1], "charged=30") {
		t.Fatalf("got\n%s", strings.Join(lines, "\n"))
	}
}

func mustMap(t *testing.T, pairs ...Pair) Value {
	t.Helper()
	v, err := Map(pairs...)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
