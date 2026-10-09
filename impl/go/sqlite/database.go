// Package sqlite is a `sqlite` implementation for Go Hosts on
// github.com/ncruces/go-sqlite3, which bundles SQLite and needs no cgo
// (chapter 9, `sqlite` Host obligations; ADR 0070). None of this is the Core:
// a Host passes Databases to Core.SqliteCapability.
//
// One database is one Segment Coordinator, shared by every `sqlite` Grant on
// it. A Segment's first write takes the one writer connection and opens its
// transaction; every other read goes through a read-only connection, which in
// WAL mode sees the last committed state. The write lock lives in this
// process, so the process owns the file: it holds an exclusive lock on a
// sidecar database, `<path>-lock`, until it closes.
package sqlite

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/ncruces/go-sqlite3"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// segment is a Segment, by its Group, since Segment ids are unique only
// within one.
type segment struct {
	group *talk.Group
	id    string
}

// Database is one database a Host offers through `sqlite`. Its methods are
// safe for concurrent use: calls from every Group take turns.
type Database struct {
	// Every Grant on the database maps to this coordinator.
	coordinator *talk.SegmentLifecycle

	mu     sync.Mutex
	lock   *sqlite3.Conn
	reader *sqlite3.Conn
	writer *sqlite3.Conn
	// The Segment that holds the writer's transaction, and its savepoints.
	holder     *segment
	savepoints int
}

// Open opens or creates the database at path, which the process holds until
// Close.
func Open(path string) (*Database, error) {
	if path == "" || path == ":memory:" || strings.HasPrefix(path, "file:") {
		return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "a sqlite database is a file path, which its connections share"}
	}
	d := &Database{}
	opened := []*sqlite3.Conn{}
	fail := func(err error) (*Database, error) {
		for i := len(opened) - 1; i >= 0; i-- {
			opened[i].Close()
		}
		return nil, err
	}
	var err error
	if d.lock, err = sqlite3.Open(path + "-lock"); err != nil {
		return fail(err)
	}
	opened = append(opened, d.lock)
	if err := d.lock.Exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT"); err != nil {
		return fail(fmt.Errorf("another connection holds %s: %w", path, err))
	}
	if d.writer, err = sqlite3.Open(path); err != nil {
		return fail(err)
	}
	opened = append(opened, d.writer)
	if err := d.writer.Exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON"); err != nil {
		return fail(err)
	}
	if d.reader, err = sqlite3.OpenFlags(path, sqlite3.OPEN_READONLY); err != nil {
		return fail(err)
	}
	opened = append(opened, d.reader)
	if err := d.reader.Exec("PRAGMA foreign_keys = ON"); err != nil {
		return fail(err)
	}
	d.coordinator = &talk.SegmentLifecycle{Begin: d.beginSegment, Commit: d.commitSegment, Rollback: d.rollbackSegment}
	return d, nil
}

// Coordinator is the Segment Coordinator every Grant on the database shares.
func (d *Database) Coordinator() *talk.SegmentLifecycle { return d.coordinator }

// Exec runs SQL directly, outside every Segment and with no authorizer, as
// for a migration.
func (d *Database) Exec(sql string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.holder != nil {
		return errors.New("a Segment holds the database's write lock")
	}
	return d.writer.Exec(sql)
}

// Close closes the database, discarding any Segment's uncommitted changes.
func (d *Database) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.holder = nil
	return errors.Join(d.reader.Close(), d.writer.Close(), d.lock.Close())
}

// ------------------------------------------------------------ Operations

func (d *Database) query(c *talk.Call, sql string, params talk.SqlParams, max int64) (talk.SqlRows, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	conn := d.reader
	if d.holds(at(c)) {
		conn = d.writer
	}
	return statement(conn, bindingOf(c), sql, params, max, true)
}

func (d *Database) change(c *talk.Call, sql string, params talk.SqlParams, max int64) (talk.SqlRows, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.acquire(at(c)); err != nil {
		return talk.SqlRows{}, err
	}
	// A call that fails, even after changing rows, changes nothing.
	before := d.writer.TotalChanges()
	if err := d.writer.Exec("SAVEPOINT northtalk_call"); err != nil {
		return talk.SqlRows{}, err
	}
	rows, err := statement(d.writer, bindingOf(c), sql, params, max, false)
	if err != nil {
		return talk.SqlRows{}, errors.Join(err, d.writer.Exec("ROLLBACK TO northtalk_call; RELEASE northtalk_call"))
	}
	// changes() keeps the last data change's count through other statements.
	if d.writer.TotalChanges() > before {
		rows.Changes = d.writer.Changes()
	}
	return rows, d.writer.Exec("RELEASE northtalk_call")
}

func (d *Database) begin(c *talk.Call) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.acquire(at(c)); err != nil {
		return err
	}
	d.savepoints++
	return d.writer.Exec(fmt.Sprintf("SAVEPOINT northtalk_%d", d.savepoints))
}

func (d *Database) commit(c *talk.Call) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.holds(at(c)) || d.savepoints == 0 {
		return errors.New("no transaction of this Segment is open")
	}
	err := d.writer.Exec(fmt.Sprintf("RELEASE northtalk_%d", d.savepoints))
	d.savepoints--
	return err
}

func (d *Database) rollback(c *talk.Call) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.holds(at(c)) || d.savepoints == 0 {
		return errors.New("no transaction of this Segment is open")
	}
	err := d.writer.Exec(fmt.Sprintf("ROLLBACK TO northtalk_%[1]d; RELEASE northtalk_%[1]d", d.savepoints))
	d.savepoints--
	return err
}

// ------------------------------------------------------------ lifecycle

var ok = talk.EffectResult{Status: talk.EffectOK}

// The begin hook only prepares the Segment: its first write takes the lock,
// since a failed begin hook raises `host error` (ADR 0070).
func (d *Database) beginSegment(talk.SegmentContext) talk.EffectResult { return ok }

func (d *Database) commitSegment(c talk.SegmentContext) talk.EffectResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.holds(segment{c.Group, c.SegmentID}) {
		return ok
	}
	d.holder = nil
	if err := d.writer.Exec("COMMIT"); err != nil {
		// A refused COMMIT, as for a deferred constraint, leaves the
		// transaction open.
		if !d.writer.GetAutocommit() {
			err = errors.Join(err, d.writer.Exec("ROLLBACK"))
		}
		return talk.EffectResult{Status: talk.EffectFailed, Detail: err.Error()}
	}
	return ok
}

func (d *Database) rollbackSegment(c talk.SegmentContext) talk.EffectResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.holds(segment{c.Group, c.SegmentID}) {
		return ok
	}
	d.holder = nil
	if !d.writer.GetAutocommit() {
		if err := d.writer.Exec("ROLLBACK"); err != nil {
			return talk.EffectResult{Status: talk.EffectUnknown, Detail: err.Error()}
		}
	}
	return ok
}

// ------------------------------------------------------------ internals

func at(c *talk.Call) segment { return segment{c.Group(), c.SegmentID()} }

func (d *Database) holds(s segment) bool { return d.holder != nil && *d.holder == s }

// acquire takes the write lock for the Segment, or fails with `sqlite busy`.
func (d *Database) acquire(s segment) error {
	if d.holds(s) {
		return nil
	}
	if d.holder != nil {
		return failure("sqlite busy")
	}
	if err := d.writer.Exec("BEGIN IMMEDIATE"); err != nil {
		return translated(err)
	}
	d.holder = &s
	d.savepoints = 0
	return nil
}

func bindingOf(c *talk.Call) talk.SqliteBinding {
	switch b := c.Binding().(type) {
	case talk.SqliteBinding:
		return b
	case *talk.SqliteBinding:
		return *b
	}
	return talk.SqliteBinding{}
}

// Databases is the implementation over the Host's databases, by the name a
// binding gives. A binding naming no database maps to no coordinator, which
// the Grant refuses.
func Databases(databases map[string]*Database) talk.SqliteImpl {
	named := make(map[string]*Database, len(databases))
	for name, d := range databases {
		named[name] = d
	}
	return impl(named)
}

type impl map[string]*Database

func (m impl) db(c *talk.Call) (*Database, error) {
	if d := m[bindingOf(c).Database]; d != nil {
		return d, nil
	}
	return nil, fmt.Errorf("no sqlite database is named %s", bindingOf(c).Database)
}

func (m impl) Coordinator(database string) *talk.SegmentLifecycle {
	if d := m[database]; d != nil {
		return d.coordinator
	}
	return nil
}

func (m impl) Query(c *talk.Call, sql string, params talk.SqlParams, max int64) (talk.SqlRows, error) {
	d, err := m.db(c)
	if err != nil {
		return talk.SqlRows{}, err
	}
	return d.query(c, sql, params, max)
}

func (m impl) Change(c *talk.Call, sql string, params talk.SqlParams, max int64) (talk.SqlRows, error) {
	d, err := m.db(c)
	if err != nil {
		return talk.SqlRows{}, err
	}
	return d.change(c, sql, params, max)
}

func (m impl) Begin(c *talk.Call) error {
	d, err := m.db(c)
	if err != nil {
		return err
	}
	return d.begin(c)
}

func (m impl) Commit(c *talk.Call) error {
	d, err := m.db(c)
	if err != nil {
		return err
	}
	return d.commit(c)
}

func (m impl) Rollback(c *talk.Call) error {
	d, err := m.db(c)
	if err != nil {
		return err
	}
	return d.rollback(c)
}
