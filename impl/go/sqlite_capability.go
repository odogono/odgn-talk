package northtalk

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// sqlite is optional (chapter 7, ADR 0070). The binding names a database the
// Host keeps; Tables, when non-nil, limits the tables a Grant may use, and
// MaxRows caps the rows a call may give.
type SqliteBinding struct {
	Database string
	Tables   []string
	MaxRows  int64
}

// SqlValue is nil (NULL), int64 (INTEGER), float64 (REAL), string (TEXT) or
// []byte (BLOB).
type SqlValue = any

// SqlParams binds List to `?` and `?NNN`, or, when Named is non-nil, Named to
// `:name`, keyed without the colon.
type SqlParams struct {
	List  []SqlValue
	Named map[string]SqlValue
}

type SqlRows struct {
	Columns []string
	Rows    [][]SqlValue // each in column order
	Changes int64        // Change only
}

// The Core has checked the Shapes and max, converted params by the chapter 7
// rules and charged max × perRow. It converts the result, raising `sql` for a
// column named twice and `unrepresentable` for a double it can't hold or a
// string that isn't valid UTF-8. Change, Begin, Commit and Rollback are
// Segment-bound: they act inside the calling Segment's transaction, which the
// coordinator publishes or discards. Begin, Commit and Rollback open, release
// and roll back a savepoint. A failed call leaves the database as it was. Fail
// with ScriptError `sql` {reason}, `constraint` {kind}, `sqlite busy`,
// `not read-only` or `too many rows` {max} (chapter 9).
type SqliteImpl interface {
	// Coordinator is called once per Grant. The same database gives the same pointer.
	Coordinator(database string) *SegmentLifecycle
	Query(c *Call, sql string, params SqlParams, max int64) (SqlRows, error)
	Change(c *Call, sql string, params SqlParams, max int64) (SqlRows, error)
	Begin(c *Call) error
	Commit(c *Call) error
	Rollback(c *Call) error
}

const sqliteMaxWhole = 9007199254740991

var (
	sqliteValueShape = OneOf(NothingShape, NumberShape, TextShape, BytesShape, BoolShape)
	sqliteKinds      = []corevalue.Kind{corevalue.Nothing, corevalue.Number, corevalue.Text, corevalue.Bytes, corevalue.Boolean}
	sqliteConstraint = []string{"unique", "primary key", "not null", "check", "foreign key", "datatype", "trigger", "other"}
)

// errMalformedSqlRows is the `host error` for a result whose form is broken.
var errMalformedSqlRows = errors.New("a sqlite implementation gave a malformed result")

// SqliteCapability is optional for Hosts. perRow is whole Fuel charged per row
// of max; a bad one is HostError `invalid value`. Every binding must be a
// SqliteBinding.
func (c *Core) SqliteCapability(impl SqliteImpl, costs Costs, perRow int64) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing sqlite implementation"}
	}
	if perRow < 0 || perRow > sqliteMaxWhole {
		return nil, &HostError{InvalidValue, "the per-row cost must be a whole number"}
	}
	errs := func(codes ...string) []ErrorDecl {
		out := []ErrorDecl{}
		for _, code := range codes {
			out = append(out, ErrorDecl{Code: code})
		}
		return out
	}
	// Charged before the work, whatever the statement then gives. A product
	// past every Fuel limit faults the same as the exact one would.
	chargeRows := func(call *Call, max int64) error {
		fuel := int64(sqliteMaxWhole)
		if perRow == 0 || max <= sqliteMaxWhole/perRow {
			fuel = min(max*perRow, sqliteMaxWhole)
		}
		return call.Charge(fuel)
	}
	statement := func(run func(*Call, string, SqlParams, int64) (corevalue.Value, error)) func(*Call, []Value) (Value, error) {
		return func(call *Call, args []Value) (Value, error) {
			binding, _ := sqliteBindingOf(call.Binding())
			var max corevalue.Value
			if len(args) > 2 {
				max = args[2].inner
			}
			allowed, failure := sqliteRowsAllowed(max, binding)
			if failure != nil {
				return Nothing, scriptError(*failure)
			}
			if err := chargeRows(call, allowed); err != nil {
				return Nothing, err
			}
			sql, _ := args[0].AsText()
			v, err := run(call, sql, sqliteParamsOf(args[1].inner), allowed)
			return Value{v}, err
		}
	}
	statementArgs := []Shape{TextShape, AnyShape, Optional(NumberShape)}
	scoped := func(name string, scope ScopeDecl, act func(*Call) error, codes ...string) Operation {
		return Operation{Name: name, Result: NothingShape, SegmentBound: true, Scope: &scope, Errors: errs(codes...), Do: func(call *Call, _ []Value) (Value, error) {
			return Nothing, act(call)
		}}
	}
	ops := []Operation{
		{Name: "query", Args: statementArgs, Result: ListOf(AnyShape), Errors: errs("sql", "not read-only", "too many rows", "unrepresentable"), Do: statement(func(call *Call, sql string, params SqlParams, max int64) (corevalue.Value, error) {
			result, err := impl.Query(call, sql, params, max)
			if err != nil {
				return corevalue.Value{}, err
			}
			if !sqliteForm(result, max, false) {
				return corevalue.Value{}, errMalformedSqlRows
			}
			return sqliteRowsOf(result)
		})},
		{Name: "change", Args: statementArgs, Result: MapShape(Field{Key: "changes", Shape: NumberShape}, Field{Key: "rows", Shape: ListOf(AnyShape)}), SegmentBound: true, Errors: errs("sql", "constraint", "sqlite busy", "too many rows", "unrepresentable"), Do: statement(func(call *Call, sql string, params SqlParams, max int64) (corevalue.Value, error) {
			result, err := impl.Change(call, sql, params, max)
			if err != nil {
				return corevalue.Value{}, err
			}
			if !sqliteForm(result, max, true) {
				return corevalue.Value{}, errMalformedSqlRows
			}
			rows, err := sqliteRowsOf(result)
			if err != nil {
				return corevalue.Value{}, err
			}
			return corevalue.NewMap([]corevalue.Pair{{Key: "changes", Val: Int(result.Changes).inner}, {Key: "rows", Val: rows}})
		})},
		scoped("begin", ScopeDecl{Opens: "transaction", Abandon: "rollback"}, impl.Begin, "sqlite busy"),
		scoped("commit", ScopeDecl{Closes: "transaction"}, impl.Commit),
		scoped("rollback", ScopeDecl{Closes: "transaction"}, impl.Rollback),
	}
	for i := range ops {
		cost, err := standardCost(costs, ops[i].Name)
		if err != nil {
			return nil, err
		}
		ops[i].Cost = cost
		ops[i].Mode = Immediate
	}
	// Every Grant on one database shares its coordinator (ADR 0069), mapped
	// once, when the Grant is created, which is where a bad binding fails.
	// A binding that isn't a SqliteBinding maps to no coordinator, which
	// Grant refuses as HostError `invalid value`.
	def, err := c.DefineCoordinatedCapability("sqlite", func(binding any) *SegmentLifecycle {
		b, ok := sqliteBindingOf(binding)
		if !ok {
			return nil
		}
		return impl.Coordinator(b.Database)
	}, ops...)
	if err != nil {
		return nil, err
	}
	def.checks = map[string]operationChecks{}
	for _, op := range ops {
		checks := operationChecks{failure: func(code string, data corevalue.Value) bool {
			return slices.ContainsFunc(op.Errors, func(e ErrorDecl) bool { return e.Code == code }) && sqliteFailure(code, data)
		}}
		if op.Name == "query" || op.Name == "change" {
			checks.arguments = func(a []corevalue.Value, binding any, named []corevalue.Pair) *corevalue.Value {
				b, _ := sqliteBindingOf(binding)
				var max corevalue.Value
				if len(a) > 2 {
					max = a[2]
				}
				if _, failure := sqliteRowsAllowed(max, b); failure != nil {
					return failure
				}
				return sqliteCheckParams(a[1], named)
			}
		}
		def.checks[op.Name] = checks
	}
	return def, nil
}

// sqliteBindingOf accepts a SqliteBinding or a non-nil pointer to one.
func sqliteBindingOf(binding any) (SqliteBinding, bool) {
	var b SqliteBinding
	switch x := binding.(type) {
	case SqliteBinding:
		b = x
	case *SqliteBinding:
		if x == nil {
			return b, false
		}
		b = *x
	default:
		return b, false
	}
	return b, b.MaxRows >= 0 && b.MaxRows <= sqliteMaxWhole
}

// sqliteRowsAllowed gives the rows a call may give: max, or the binding's cap
// when it is omitted (the zero Value) or Nothing.
func sqliteRowsAllowed(max corevalue.Value, binding SqliteBinding) (int64, *corevalue.Value) {
	if max.Kind == corevalue.Nothing {
		return binding.MaxRows, nil
	}
	whole, fraction, _ := strings.Cut(max.Number().String(), ".")
	n, err := strconv.ParseInt(whole, 10, 64)
	if strings.HasPrefix(whole, "-") || strings.ContainsAny(fraction, "123456789") || err != nil || n > binding.MaxRows {
		failure := machine.ErrorValue("out of range", corevalue.Pair{Key: "field", Val: mustText("max")}, corevalue.Pair{Key: "value", Val: max})
		return 0, &failure
	}
	return n, nil
}

func sqliteCheckParams(params corevalue.Value, named []corevalue.Pair) *corevalue.Value {
	wrongKind := func(expected string, item corevalue.Value, path ...corevalue.Pair) *corevalue.Value {
		fields := []corevalue.Pair{{Key: "expected", Val: mustText(expected)}, {Key: "got", Val: mustText(corevalue.KindNames[item.Kind])}, {Key: "value", Val: item}}
		fields = append(fields, named...)
		fields = append(fields, corevalue.Pair{Key: "argument", Val: Int(2).inner})
		fields = append(fields, path...)
		failure := machine.ErrorValue("wrong kind", fields...)
		return &failure
	}
	if params.Kind != corevalue.List && params.Kind != corevalue.Map {
		return wrongKind("list or map", params)
	}
	check := func(at corevalue.Value, item corevalue.Value) *corevalue.Value {
		if slices.Contains(sqliteKinds, item.Kind) {
			return nil
		}
		return wrongKind(sqliteValueShape.inner.Expected(), item, corevalue.Pair{Key: "path", Val: corevalue.NewList([]corevalue.Value{at})})
	}
	for i, item := range params.Items() {
		if failure := check(Int(int64(i+1)).inner, item); failure != nil {
			return failure
		}
	}
	for _, p := range params.Entries() {
		if failure := check(mustText(p.Key), p.Val); failure != nil {
			return failure
		}
	}
	return nil
}

// sqlValueOf binds a whole number that fits int64 as INTEGER, any other as
// REAL, and a boolean as 1 or 0.
func sqlValueOf(v corevalue.Value) SqlValue {
	switch v.Kind {
	case corevalue.Boolean:
		if v.Bool {
			return int64(1)
		}
		return int64(0)
	case corevalue.Text:
		return v.Text()
	case corevalue.Bytes:
		return slices.Clone(v.Bytes())
	case corevalue.Number:
		canonical := v.Number().String()
		if !strings.Contains(canonical, ".") {
			if n, err := strconv.ParseInt(canonical, 10, 64); err == nil {
				return n
			}
		}
		f, _ := strconv.ParseFloat(canonical, 64)
		return f
	}
	return nil
}

func sqliteParamsOf(params corevalue.Value) SqlParams {
	if params.Kind == corevalue.Map {
		named := make(map[string]SqlValue, len(params.Entries()))
		for _, p := range params.Entries() {
			named[p.Key] = sqlValueOf(p.Val)
		}
		return SqlParams{Named: named}
	}
	list := make([]SqlValue, len(params.Items()))
	for i, item := range params.Items() {
		list[i] = sqlValueOf(item)
	}
	return SqlParams{List: list}
}

// sqliteForm checks the result's form, which is the implementation's; a
// broken one is `host error`.
func sqliteForm(result SqlRows, max int64, change bool) bool {
	if int64(len(result.Rows)) > max {
		return false
	}
	for _, row := range result.Rows {
		if len(row) != len(result.Columns) {
			return false
		}
	}
	return !change || result.Changes >= 0 && result.Changes <= sqliteMaxWhole
}

func sqliteRowsOf(result SqlRows) (corevalue.Value, error) {
	columns := make([]string, len(result.Columns))
	seen := map[string]bool{}
	for i, column := range result.Columns {
		name, err := normalizeHostText(column)
		if err != nil {
			return corevalue.Value{}, fmt.Errorf("a sqlite column name isn't valid UTF-8")
		}
		if seen[name] {
			return corevalue.Value{}, sqliteCoreFailure("sql", "reason", "duplicate column "+name)
		}
		seen[name] = true
		columns[i] = name
	}
	rows := make([]corevalue.Value, len(result.Rows))
	for r, row := range result.Rows {
		pairs := make([]corevalue.Pair, len(columns))
		for i, column := range columns {
			v, err := sqliteValueOf(row[i], column)
			if err != nil {
				return corevalue.Value{}, err
			}
			pairs[i] = corevalue.Pair{Key: column, Val: v}
		}
		m, err := corevalue.NewMap(pairs)
		if err != nil {
			return corevalue.Value{}, err
		}
		rows[r] = m
	}
	return corevalue.NewList(rows), nil
}

func sqliteValueOf(v SqlValue, column string) (corevalue.Value, error) {
	unrepresentable := func() error {
		return sqliteCoreFailure("unrepresentable", "column", column)
	}
	switch x := v.(type) {
	case nil:
		return corevalue.Value{}, nil
	case int64:
		return Int(x).inner, nil
	case float64:
		n, err := decimal.FromFloat(x)
		if err != nil {
			return corevalue.Value{}, unrepresentable()
		}
		return corevalue.Fields{Kind: corevalue.Number, Number: n}.Value(), nil
	case string:
		if !utf8.ValidString(x) {
			return corevalue.Value{}, unrepresentable()
		}
		return corevalue.NewText(x)
	case []byte:
		return corevalue.NewBytes(slices.Clone(x)), nil
	}
	return corevalue.Value{}, fmt.Errorf("a sqlite value must be NULL, INTEGER, REAL, TEXT or BLOB, not %T", v)
}

// sqliteCoreFailure is a failure the Core raises from result conversion. Like
// a Host failure it is the call's error, and like one it has no message.
func sqliteCoreFailure(code, field, text string) error {
	data, _ := Map(KV(field, Value{mustText(text)}))
	return &ScriptError{Code: code, Data: data}
}

func sqliteFailure(code string, data corevalue.Value) bool {
	text := func(key string) bool { return data.Get(key).Kind == corevalue.Text }
	switch code {
	case "sql":
		return text("reason")
	case "constraint":
		return text("kind") && slices.Contains(sqliteConstraint, data.Get("kind").Text())
	case "sqlite busy", "not read-only":
		return true
	case "too many rows":
		return data.Get("max").Kind == corevalue.Number
	case "unrepresentable":
		return text("column")
	}
	return false
}
