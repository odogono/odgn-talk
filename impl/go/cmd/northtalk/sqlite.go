package main

import (
	"os"
	"path/filepath"
	"sync"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/sqlite"
)

// maxRows is the rows one `sqlite` call may give.
const maxRows = 10_000

// lazySqlite is `sqlite` on the database `main`, in a temporary directory,
// opened at its first use and removed by close, as the TS Runner's is.
type lazySqlite struct {
	mu        sync.Mutex
	directory string
	database  *sqlite.Database
	impl      talk.SqliteImpl
	// The one database's coordinator, the same pointer for every Grant.
	coordinator talk.SegmentLifecycle
}

func newLazySqlite() *lazySqlite {
	l := &lazySqlite{}
	// A Segment that never opened the database has nothing to publish.
	segment := func(step func(*talk.SegmentLifecycle) func(talk.SegmentContext) talk.EffectResult) func(talk.SegmentContext) talk.EffectResult {
		return func(c talk.SegmentContext) talk.EffectResult {
			l.mu.Lock()
			database := l.database
			l.mu.Unlock()
			if database == nil {
				return talk.EffectResult{Status: talk.EffectOK}
			}
			return step(database.Coordinator())(c)
		}
	}
	l.coordinator = talk.SegmentLifecycle{
		Begin:    segment(func(s *talk.SegmentLifecycle) func(talk.SegmentContext) talk.EffectResult { return s.Begin }),
		Commit:   segment(func(s *talk.SegmentLifecycle) func(talk.SegmentContext) talk.EffectResult { return s.Commit }),
		Rollback: segment(func(s *talk.SegmentLifecycle) func(talk.SegmentContext) talk.EffectResult { return s.Rollback }),
	}
	return l
}

func (l *lazySqlite) opened() (talk.SqliteImpl, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.impl == nil {
		directory, err := os.MkdirTemp("", "northtalk-run-")
		if err != nil {
			return nil, err
		}
		database, err := sqlite.Open(filepath.Join(directory, "main.db"))
		if err != nil {
			_ = os.RemoveAll(directory)
			return nil, err
		}
		l.directory, l.database = directory, database
		l.impl = sqlite.Databases(map[string]*sqlite.Database{"main": database})
	}
	return l.impl, nil
}

func (l *lazySqlite) close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	var err error
	if l.database != nil {
		err = l.database.Close()
	}
	if l.directory != "" {
		_ = os.RemoveAll(l.directory)
	}
	return err
}

func (l *lazySqlite) Coordinator(database string) *talk.SegmentLifecycle {
	if database != "main" {
		return nil
	}
	return &l.coordinator
}

func (l *lazySqlite) Query(c *talk.Call, sql string, params talk.SqlParams, max int64) (talk.SqlRows, error) {
	impl, err := l.opened()
	if err != nil {
		return talk.SqlRows{}, err
	}
	return impl.Query(c, sql, params, max)
}

func (l *lazySqlite) Change(c *talk.Call, sql string, params talk.SqlParams, max int64) (talk.SqlRows, error) {
	impl, err := l.opened()
	if err != nil {
		return talk.SqlRows{}, err
	}
	return impl.Change(c, sql, params, max)
}

func (l *lazySqlite) Begin(c *talk.Call) error {
	impl, err := l.opened()
	if err != nil {
		return err
	}
	return impl.Begin(c)
}

func (l *lazySqlite) Commit(c *talk.Call) error {
	impl, err := l.opened()
	if err != nil {
		return err
	}
	return impl.Commit(c)
}

func (l *lazySqlite) Rollback(c *talk.Call) error {
	impl, err := l.opened()
	if err != nil {
		return err
	}
	return impl.Rollback(c)
}
