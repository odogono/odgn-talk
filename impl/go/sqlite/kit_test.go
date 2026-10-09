package sqlite_test

import (
	"path/filepath"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/sqlitekit"
	"github.com/odogono/odgn-talk/impl/go/sqlite"
)

// The Host keeps no Stores in a database yet, so the kit's co-located Store
// sequences are skipped (#469).
func TestKit(t *testing.T) {
	sequences, err := sqlitekit.Sequences("../../../corpus/sqlite-kit")
	if err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, seq := range sequences {
		t.Run(seq.File+": "+seq.Name, func(t *testing.T) {
			if seq.KeepsStore() {
				t.Skip("needs a Store kept in the database")
			}
			open := func() (sqlitekit.Subject, error) {
				db, err := sqlite.Open(filepath.Join(t.TempDir(), "app.sqlite"))
				if err != nil {
					return sqlitekit.Subject{}, err
				}
				return sqlitekit.Subject{Sqlite: sqlite.Databases(map[string]*sqlite.Database{"app": db}), Exec: db.Exec, Close: db.Close}, nil
			}
			if err := sqlitekit.Run(open, seq); err != nil {
				t.Fatal(err)
			}
			ran++
		})
	}
	if ran < 30 {
		t.Fatalf("only %d kit sequences ran", ran)
	}
}
