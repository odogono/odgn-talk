package sqlite_test

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ncruces/go-sqlite3"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/sqlite"
)

// The kit holds the implementation to each rule; these run it under Groups,
// through the factory and the Core's Segments.

const transfer = `on transfer fromId, toId, amount
  ask db to change "INSERT INTO log (amount) VALUES (?)", [amount], 0
  ask db to begin
  ask db to change "UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, fromId], 0
  if the changes of it is 0 then throw {code: "no account", id: fromId}
  ask db to change "UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, toId], 0
  ask db to commit
end transfer

on spin
  ask db to change "INSERT INTO log (amount) VALUES (1)", [], 0
  repeat forever
  end repeat
end spin
`

type host struct {
	t      *testing.T
	path   string
	def    *talk.CapabilityDef
	script *talk.Script
	group  *talk.Group
}

func open(t *testing.T) (*sqlite.Database, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.sqlite")
	db, err := sqlite.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL); CREATE TABLE log (amount INTEGER); INSERT INTO accounts VALUES (1, 100), (2, 0)"); err != nil {
		t.Fatal(err)
	}
	return db, path
}

func load(t *testing.T, def *talk.CapabilityDef, limits talk.Limits) (*talk.Group, *talk.Script) {
	t.Helper()
	group := talk.New().NewGroup(talk.GroupOptions{})
	grant, err := def.Grant([]string{"query", "change", "begin", "commit", "rollback"}, talk.SqliteBinding{Database: "app", MaxRows: 10})
	if err != nil {
		t.Fatal(err)
	}
	script, err := group.Load(talk.LoadOptions{Name: "s", Source: transfer, Grants: map[string]*talk.Grant{"db": grant}, Limits: limits})
	if err != nil {
		t.Fatal(err)
	}
	return group, script
}

func capability(t *testing.T, db *sqlite.Database) *talk.CapabilityDef {
	t.Helper()
	costs := talk.Costs{}
	for _, op := range []string{"query", "change", "begin", "commit", "rollback"} {
		costs[op] = talk.Cost{Fuel: 1}
	}
	def, err := talk.New().SqliteCapability(sqlite.Databases(map[string]*sqlite.Database{"app": db}), costs, 0)
	if err != nil {
		t.Fatal(err)
	}
	return def
}

func deliver(t *testing.T, group *talk.Group, script *talk.Script, name string, args ...int64) *talk.RunEnd {
	t.Helper()
	values := make([]talk.Value, len(args))
	for i, n := range args {
		values[i] = talk.Int(n)
	}
	if _, err := script.Deliver(talk.Message{Name: name, Args: values}); err != nil {
		t.Fatal(err)
	}
	result, err := group.Pump(time.Unix(0, 0), talk.PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, report := range result.Reports {
		if end, ok := report.(*talk.RunEnd); ok {
			return end
		}
	}
	t.Fatal("no Run ended")
	return nil
}

// rows reads the committed state, as another process would.
func rows(t *testing.T, path, sql string) string {
	t.Helper()
	conn, err := sqlite3.OpenFlags(path, sqlite3.OPEN_READONLY)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	stmt, _, err := conn.Prepare(sql)
	if err != nil {
		t.Fatal(err)
	}
	defer stmt.Close()
	out := ""
	for stmt.Step() {
		for i := range stmt.ColumnCount() {
			out += fmt.Sprintf("%s=%d ", stmt.ColumnName(i), stmt.ColumnInt64(i))
		}
	}
	if err := stmt.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSegmentCommitsItsChanges(t *testing.T) {
	db, path := open(t)
	group, script := load(t, capability(t, db), talk.Limits{})
	if end := deliver(t, group, script, "transfer", 1, 2, 30); end.Outcome != talk.Completed {
		t.Fatalf("outcome %v: %v", end.Outcome, end.Error)
	}
	if got := rows(t, path, "SELECT id, balance FROM accounts ORDER BY id"); got != "id=1 balance=70 id=2 balance=30 " {
		t.Fatal(got)
	}
	if got := rows(t, path, "SELECT amount FROM log"); got != "amount=30 " {
		t.Fatal(got)
	}
}

func TestOrdinaryErrorAbandonsTheTransactionThenCommits(t *testing.T) {
	db, path := open(t)
	group, script := load(t, capability(t, db), talk.Limits{})
	if end := deliver(t, group, script, "transfer", 9, 2, 30); end.Outcome != talk.Errored || end.Error.Code != "no account" {
		t.Fatalf("outcome %v: %v", end.Outcome, end.Error)
	}
	if got := rows(t, path, "SELECT id, balance FROM accounts ORDER BY id"); got != "id=1 balance=100 id=2 balance=0 " {
		t.Fatal(got)
	}
	if got := rows(t, path, "SELECT amount FROM log"); got != "amount=30 " {
		t.Fatal(got)
	}
}

func TestLimitFaultRollsBackTheSegment(t *testing.T) {
	db, path := open(t)
	group, script := load(t, capability(t, db), talk.Limits{FuelPerRun: 10000})
	if end := deliver(t, group, script, "spin"); end.Outcome != talk.LimitFault {
		t.Fatalf("outcome %v: %v", end.Outcome, end.Error)
	}
	if got := rows(t, path, "SELECT count(*) AS n FROM log"); got != "n=0 " {
		t.Fatal(got)
	}
	// The rollback released the write lock.
	if end := deliver(t, group, script, "transfer", 1, 2, 30); end.Outcome != talk.Completed {
		t.Fatalf("outcome %v: %v", end.Outcome, end.Error)
	}
}

// Groups pumped on their own goroutines run Segments at once, so one may
// find another holding the write lock. It never waits: its first `change`
// raises `sqlite busy`, before anything changes.
func TestConcurrentGroupsShareADatabase(t *testing.T) {
	db, path := open(t)
	def := capability(t, db)
	var wg sync.WaitGroup
	var mu sync.Mutex
	completed := 0
	for range 4 {
		group, script := load(t, def, talk.Limits{})
		wg.Go(func() {
			for range 25 {
				end := deliver(t, group, script, "transfer", 1, 2, 1)
				switch {
				case end.Outcome == talk.Completed:
					mu.Lock()
					completed++
					mu.Unlock()
				case end.Outcome != talk.Errored || end.Error.Code != "sqlite busy":
					t.Errorf("outcome %v: %v", end.Outcome, end.Error)
				}
			}
		})
	}
	wg.Wait()
	want := fmt.Sprintf("id=1 balance=%d id=2 balance=%d ", 100-completed, completed)
	if got := rows(t, path, "SELECT id, balance FROM accounts ORDER BY id"); got != want {
		t.Fatalf("%d completed: %s", completed, got)
	}
	if got := rows(t, path, "SELECT count(*) AS n FROM log"); got != fmt.Sprintf("n=%d ", completed) {
		t.Fatalf("%d completed: %s", completed, got)
	}
}

func TestOpen(t *testing.T) {
	for _, path := range []string{"", ":memory:", "file:app.sqlite"} {
		if _, err := sqlite.Open(path); err == nil {
			t.Errorf("%q opened", path)
		}
	}
	_, path := open(t)
	if _, err := sqlite.Open(path); err == nil {
		t.Error("a held database opened twice")
	}
}

func TestBindingNamingNoDatabaseIsRefused(t *testing.T) {
	db, _ := open(t)
	def := capability(t, db)
	if _, err := def.Grant([]string{"query"}, talk.SqliteBinding{Database: "other", MaxRows: 10}); err == nil {
		t.Fatal("a Grant on an unknown database was created")
	}
}
