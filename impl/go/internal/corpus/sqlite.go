package corpus

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// replaySqlite keeps no database: each Stub stands for the implementation's
// answer, which the Core converts, and each database has one coordinator
// whose hooks take `stub-effect` lines (chapter 11, Stubs).
type replaySqlite struct {
	replay    *operationReplay
	databases map[string]*talk.SegmentLifecycle
}

// notSql is no SqlValue, passed on for the Core to refuse as `host error`.
type notSql struct{}

func (h *replaySqlite) Coordinator(database string) *talk.SegmentLifecycle {
	if c := h.databases[database]; c != nil {
		return c
	}
	o := h.replay
	c := &talk.SegmentLifecycle{Begin: o.effect("begin"), Commit: o.effect("commit"), Rollback: o.effect("rollback")}
	h.databases[database] = c
	return c
}
func (h *replaySqlite) Query(c *talk.Call, _ string, _ talk.SqlParams, _ int64) (talk.SqlRows, error) {
	return h.rows("query", c)
}
func (h *replaySqlite) Change(c *talk.Call, _ string, _ talk.SqlParams, _ int64) (talk.SqlRows, error) {
	return h.rows("change", c)
}
func (h *replaySqlite) Begin(c *talk.Call) error    { return h.nothing("begin", c) }
func (h *replaySqlite) Commit(c *talk.Call) error   { return h.nothing("commit", c) }
func (h *replaySqlite) Rollback(c *talk.Call) error { return h.nothing("rollback", c) }

// The Go runner replays no recorded calls, so a call without a Stub fails as
// any missing immediate Stub does.
func (h *replaySqlite) rows(operation string, c *talk.Call) (talk.SqlRows, error) {
	v, err := h.replay.invoke("sqlite."+operation, talk.Immediate, c)
	if err != nil {
		return talk.SqlRows{}, err
	}
	rows, err := sqlRowsOf(v)
	if err == nil && operation == "change" && v.Get("changes").Kind() != talk.KindNumber {
		return rows, errSqlForm
	}
	return rows, err
}
func (h *replaySqlite) nothing(operation string, c *talk.Call) error {
	v, err := h.replay.invoke("sqlite."+operation, talk.Immediate, c)
	if err == nil && v.Kind() != talk.KindNothing {
		return fmt.Errorf("a sqlite.%s Stub must give nothing", operation)
	}
	return err
}

// sqliteBindingOf reads a case's `{database, tables, maxRows}` table. A table
// of another form is passed on as it is, for the factory to refuse.
func sqliteBindingOf(raw any) any {
	row, ok := raw.(Setup)
	if !ok {
		return raw
	}
	var b talk.SqliteBinding
	if b.Database, ok = row["database"].(string); !ok {
		return raw
	}
	if b.MaxRows, ok = row["maxRows"].(int64); !ok {
		return raw
	}
	if tables, present := row["tables"]; present {
		list, ok := tables.([]any)
		if !ok {
			return raw
		}
		b.Tables = []string{}
		for _, t := range list {
			name, ok := t.(string)
			if !ok {
				return raw
			}
			b.Tables = append(b.Tables, name)
		}
	}
	return b
}

// errSqlForm is a Stub whose form no implementation may give; the Core turns
// it into `host error`, as the TS runner's form check does.
var errSqlForm = fmt.Errorf("a sqlite Stub gives a malformed result")

var realText = regexp.MustCompile(`^-?\d+(\.\d+)?([Ee][-+]?\d+)?$`)

// sqlRowsOf reads a Stub's `{columns, rows[, changes]}`, with each SQL value
// as `params` would bind it, and `{real: t}` for a double.
func sqlRowsOf(stub talk.Value) (talk.SqlRows, error) {
	var out talk.SqlRows
	columns, rows := stub.Get("columns"), stub.Get("rows")
	if stub.Kind() != talk.KindMap || columns.Kind() != talk.KindList || rows.Kind() != talk.KindList {
		return out, errSqlForm
	}
	out.Columns = []string{}
	for i := 1; i <= columns.Len(); i++ {
		name, ok := columns.Index(i).AsText()
		if !ok {
			return out, errSqlForm
		}
		out.Columns = append(out.Columns, name)
	}
	out.Rows = [][]talk.SqlValue{}
	for i := 1; i <= rows.Len(); i++ {
		row := rows.Index(i)
		if row.Kind() != talk.KindList {
			return out, errSqlForm
		}
		values := []talk.SqlValue{}
		for j := 1; j <= row.Len(); j++ {
			v, err := sqlOf(row.Index(j))
			if err != nil {
				return out, err
			}
			values = append(values, v)
		}
		out.Rows = append(out.Rows, values)
	}
	for _, p := range stub.Entries() {
		if p.Key != "changes" {
			continue
		}
		d, ok := p.Val.AsDec()
		if p.Val.Kind() != talk.KindNumber || !ok {
			return out, errSqlForm
		}
		n, err := strconv.ParseInt(d.String(), 10, 64)
		if err != nil {
			return out, errSqlForm
		}
		// A negative count is passed on for the Core to refuse.
		out.Changes = n
	}
	return out, nil
}

func sqlOf(v talk.Value) (talk.SqlValue, error) {
	switch v.Kind() {
	case talk.KindNothing:
		return nil, nil
	case talk.KindText:
		s, _ := v.AsText()
		return s, nil
	case talk.KindBytes:
		b, _ := v.AsBytes()
		return b, nil
	case talk.KindNumber:
		d, _ := v.AsDec()
		canonical := d.String()
		if !strings.Contains(canonical, ".") {
			if n, err := strconv.ParseInt(canonical, 10, 64); err == nil {
				return n, nil
			}
		}
		f, _ := strconv.ParseFloat(canonical, 64)
		return f, nil
	case talk.KindMap:
		entries := v.Entries()
		if len(entries) != 1 || entries[0].Key != "real" {
			return notSql{}, nil
		}
		t, ok := entries[0].Val.AsText()
		if !ok {
			return notSql{}, nil
		}
		switch t {
		case "NaN", "Infinity", "-Infinity":
			f, _ := strconv.ParseFloat(t, 64)
			return f, nil
		}
		if !realText.MatchString(t) {
			return nil, fmt.Errorf("a sqlite Stub's real must be decimal text: %s", t)
		}
		f, _ := strconv.ParseFloat(t, 64)
		return f, nil
	}
	return notSql{}, nil
}
