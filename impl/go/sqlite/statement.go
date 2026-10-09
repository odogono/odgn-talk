package sqlite

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/ncruces/go-sqlite3"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Which argument names the table, for each action that uses one.
var tableArg = map[sqlite3.AuthorizerActionCode]int{
	sqlite3.AUTH_CREATE_INDEX: 2, sqlite3.AUTH_CREATE_TABLE: 1, sqlite3.AUTH_CREATE_TEMP_INDEX: 2,
	sqlite3.AUTH_CREATE_TEMP_TABLE: 1, sqlite3.AUTH_CREATE_TEMP_TRIGGER: 2, sqlite3.AUTH_CREATE_TEMP_VIEW: 1,
	sqlite3.AUTH_CREATE_TRIGGER: 2, sqlite3.AUTH_CREATE_VIEW: 1, sqlite3.AUTH_DELETE: 1,
	sqlite3.AUTH_DROP_INDEX: 2, sqlite3.AUTH_DROP_TABLE: 1, sqlite3.AUTH_DROP_TEMP_INDEX: 2,
	sqlite3.AUTH_DROP_TEMP_TABLE: 1, sqlite3.AUTH_DROP_TEMP_TRIGGER: 2, sqlite3.AUTH_DROP_TEMP_VIEW: 1,
	sqlite3.AUTH_DROP_TRIGGER: 2, sqlite3.AUTH_DROP_VIEW: 1, sqlite3.AUTH_INSERT: 1,
	sqlite3.AUTH_READ: 1, sqlite3.AUTH_UPDATE: 1, sqlite3.AUTH_ALTER_TABLE: 2,
	sqlite3.AUTH_ANALYZE: 1, sqlite3.AUTH_CREATE_VTABLE: 1, sqlite3.AUTH_DROP_VTABLE: 1,
}

// The read-only PRAGMAs a Script may use, and those of them that name a table.
var (
	schemaPragmas = []string{"table_info", "table_xinfo", "index_list", "index_info", "index_xinfo", "foreign_key_list"}
	tablePragmas  = []string{"table_info", "table_xinfo", "index_list", "foreign_key_list"}
)

var constraintKinds = map[sqlite3.ExtendedErrorCode]string{
	sqlite3.CONSTRAINT_UNIQUE:     "unique",
	sqlite3.CONSTRAINT_PRIMARYKEY: "primary key",
	sqlite3.CONSTRAINT_NOTNULL:    "not null",
	sqlite3.CONSTRAINT_CHECK:      "check",
	sqlite3.CONSTRAINT_FOREIGNKEY: "foreign key",
	sqlite3.CONSTRAINT_DATATYPE:   "datatype",
	sqlite3.CONSTRAINT_TRIGGER:    "trigger",
}

func failure(code string, fields ...talk.Pair) *talk.ScriptError {
	data, _ := talk.Map(fields...)
	return &talk.ScriptError{Code: code, Data: data}
}

func text(s string) talk.Value { v, _ := talk.Text(s); return v }

func sqlFailure(reason string) *talk.ScriptError {
	return failure("sql", talk.KV("reason", text(reason)))
}

// translated is SQLite's failure as the Script sees it.
func translated(err error) error {
	var e *sqlite3.Error
	if !errors.As(err, &e) {
		return err
	}
	switch e.Code() {
	case sqlite3.CONSTRAINT:
		kind, ok := constraintKinds[e.ExtendedCode()]
		if !ok {
			kind = "other"
		}
		return failure("constraint", talk.KV("kind", text(kind)))
	case sqlite3.BUSY, sqlite3.LOCKED:
		return failure("sqlite busy")
	}
	return sqlFailure(e.Error())
}

// authorizer is the authorizer for one call under binding (chapter 9, the
// authorizer).
func authorizer(binding talk.SqliteBinding) func(sqlite3.AuthorizerActionCode, string, string, string, string) sqlite3.AuthorizerReturnCode {
	var tables []string
	if binding.Tables != nil {
		tables = make([]string, len(binding.Tables))
		for i, t := range binding.Tables {
			tables[i] = strings.ToLower(t)
		}
	}
	// SQLite gives no table as NULL, which arrives as "".
	usable := func(table string) bool {
		name := strings.ToLower(table)
		// The schema tables are read and written for the statement's own work.
		return table == "" || tables == nil || strings.HasPrefix(name, "sqlite_") || slices.Contains(tables, name)
	}
	return func(action sqlite3.AuthorizerActionCode, arg1, arg2, _, _ string) sqlite3.AuthorizerReturnCode {
		switch action {
		case sqlite3.AUTH_TRANSACTION, sqlite3.AUTH_ATTACH, sqlite3.AUTH_DETACH, sqlite3.AUTH_SAVEPOINT:
			return sqlite3.AUTH_DENY
		case sqlite3.AUTH_FUNCTION:
			if strings.EqualFold(arg2, "load_extension") {
				return sqlite3.AUTH_DENY
			}
			return sqlite3.AUTH_OK
		case sqlite3.AUTH_PRAGMA:
			pragma := strings.ToLower(arg1)
			if pragma == "user_version" && arg2 == "" {
				return sqlite3.AUTH_OK
			}
			if slices.Contains(schemaPragmas, pragma) && (!slices.Contains(tablePragmas, pragma) || usable(arg2)) {
				return sqlite3.AUTH_OK
			}
			return sqlite3.AUTH_DENY
		case sqlite3.AUTH_READ:
			// A pragma's table-valued function reads what the pragma would.
			name := strings.ToLower(arg1)
			if strings.HasPrefix(name, "pragma_") && !slices.Contains(schemaPragmas, name[len("pragma_"):]) {
				return sqlite3.AUTH_DENY
			}
		}
		if at, ok := tableArg[action]; ok && !usable([]string{arg1, arg2}[at-1]) {
			return sqlite3.AUTH_DENY
		}
		return sqlite3.AUTH_OK
	}
}

// statement runs one statement under the binding's authorizer.
func statement(conn *sqlite3.Conn, binding talk.SqliteBinding, sql string, params talk.SqlParams, max int64, readOnly bool) (rows talk.SqlRows, err error) {
	// VACUUM INTO writes a copy without consulting the authorizer.
	if strings.EqualFold(firstWord(sql), "VACUUM") {
		return rows, sqlFailure("VACUUM is not allowed")
	}
	if err := conn.SetAuthorizer(authorizer(binding)); err != nil {
		return rows, err
	}
	defer func() { err = errors.Join(err, conn.SetAuthorizer(nil)) }()
	stmt, tail, err := conn.Prepare(sql)
	if err != nil {
		return rows, translated(err)
	}
	if stmt == nil {
		return rows, sqlFailure("the SQL holds no statement")
	}
	defer func() { err = errors.Join(err, stmt.Close()) }()
	// Anything after the first statement but white space, comments and `;`.
	for tail != "" {
		more, rest, err := conn.Prepare(tail)
		if more != nil || err != nil || rest == tail {
			if more != nil {
				more.Close()
			}
			return rows, sqlFailure("a call runs one statement")
		}
		tail = rest
	}
	if readOnly && !stmt.ReadOnly() {
		return rows, failure("not read-only")
	}
	if err := bind(stmt, params); err != nil {
		return rows, err
	}
	rows.Columns = make([]string, stmt.ColumnCount())
	for i := range rows.Columns {
		rows.Columns[i] = stmt.ColumnName(i)
	}
	rows.Rows = [][]talk.SqlValue{}
	for stmt.Step() {
		if int64(len(rows.Rows)) == max {
			return talk.SqlRows{}, failure("too many rows", talk.KV("max", talk.Int(max)))
		}
		row := make([]talk.SqlValue, len(rows.Columns))
		for i := range row {
			switch stmt.ColumnType(i) {
			case sqlite3.INTEGER:
				row[i] = stmt.ColumnInt64(i)
			case sqlite3.FLOAT:
				row[i] = stmt.ColumnFloat(i)
			case sqlite3.TEXT:
				// The Core refuses text that isn't UTF-8 as `unrepresentable`.
				row[i] = string(stmt.ColumnRawText(i))
			case sqlite3.BLOB:
				row[i] = append([]byte{}, stmt.ColumnRawBlob(i)...)
			}
		}
		rows.Rows = append(rows.Rows, row)
	}
	if err := stmt.Err(); err != nil {
		return talk.SqlRows{}, translated(err)
	}
	return rows, nil
}

// bind binds params, or fails with `sql` unless they match the statement's
// placeholders: a list binds `?` and `?NNN`, and a map binds `:name`.
func bind(stmt *sqlite3.Stmt, params talk.SqlParams) error {
	count := stmt.BindCount()
	names := []string{}
	positional := false
	for i := 1; i <= count; i++ {
		switch name := stmt.BindName(i); {
		case name == "" || name[0] == '?':
			positional = true
		case name[0] != ':':
			return sqlFailure("only ?, ?NNN and :name placeholders are allowed")
		default:
			names = append(names, name[1:])
		}
	}
	if positional && len(names) > 0 {
		return sqlFailure("placeholders are either positional or named")
	}
	if params.Named == nil {
		if len(names) > 0 {
			return sqlFailure("a list binds only positional placeholders")
		}
		if len(params.List) != count {
			return sqlFailure(fmt.Sprintf("the statement has %d parameters, and %d were given", count, len(params.List)))
		}
		for i, v := range params.List {
			if err := bindOne(stmt, i+1, v); err != nil {
				return err
			}
		}
		return nil
	}
	if positional {
		return sqlFailure("a map binds only :name placeholders")
	}
	if len(names) != len(params.Named) {
		return sqlFailure(placeholders(names))
	}
	for _, name := range names {
		v, ok := params.Named[name]
		if !ok {
			return sqlFailure(placeholders(names))
		}
		if err := bindOne(stmt, stmt.BindIndex(":"+name), v); err != nil {
			return err
		}
	}
	return nil
}

func placeholders(names []string) string {
	if len(names) == 0 {
		return "the statement has no parameters"
	}
	return "the statement's parameters are :" + strings.Join(names, ", :")
}

// bindOne binds a float64 as REAL even when it is whole (chapter 7).
func bindOne(stmt *sqlite3.Stmt, i int, v talk.SqlValue) error {
	switch x := v.(type) {
	case nil:
		return stmt.BindNull(i)
	case int64:
		return stmt.BindInt64(i, x)
	case float64:
		return stmt.BindFloat(i, x)
	case string:
		return stmt.BindText(i, x)
	case []byte:
		if len(x) == 0 {
			// A nil or empty slice would bind NULL.
			return stmt.BindZeroBlob(i, 0)
		}
		return stmt.BindBlob(i, x)
	}
	return fmt.Errorf("a sqlite value must be nil, int64, float64, string or []byte, not %T", v)
}

// firstWord is the SQL's first word, after white space and comments.
func firstWord(sql string) string {
	for {
		sql = strings.TrimLeft(sql, " \t\n\r\f\v")
		switch {
		case strings.HasPrefix(sql, "--"):
			_, rest, found := strings.Cut(sql, "\n")
			if !found {
				return ""
			}
			sql = rest
		case strings.HasPrefix(sql, "/*"):
			_, rest, found := strings.Cut(sql[2:], "*/")
			if !found {
				return ""
			}
			sql = rest
		default:
			end := strings.IndexFunc(sql, func(r rune) bool {
				return !(r == '_' || r == '$' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r > 0x7f)
			})
			if end < 0 {
				return sql
			}
			return sql[:end]
		}
	}
}
