package zigwasm

import (
	"bytes"
	"context"
	"os"
	"testing"
)

// A second Engine on the same cache directory loads the compiled code the
// first one stored, and its guests still answer.
func TestCompilationCacheDirIsReused(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(CacheDirEnv, dir)
	ctx := context.Background()
	for range 2 {
		e, err := NewEngine(ctx, "")
		if err != nil {
			t.Fatal(err)
		}
		r, err := e.Instantiate(ctx)
		if err != nil {
			t.Fatal(err)
		}
		reply, err := r.Frame(ctx, []byte(`{"m":"hello","ref":1,"protocol":1}`))
		if err != nil || !bytes.Contains(reply, []byte(`"ok"`)) {
			t.Fatal(string(reply), err)
		}
		r.Close(ctx)
		e.Close(ctx)
		if entries, err := os.ReadDir(dir); err != nil || len(entries) == 0 {
			t.Fatal("nothing cached", err)
		}
	}
}
