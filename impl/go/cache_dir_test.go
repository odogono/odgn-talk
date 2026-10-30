package northtalk_test

import (
	"os"
	"os/exec"
	"testing"

	talk "northtalk.org/go"
)

// The reactor compiles once per process, so each Core here is a child
// process: the first stores its compilation in the directory, the second
// loads it, and neither reads NORTHTALK_ZIG_CACHE_DIR.
func TestSetCompilationCacheDir(t *testing.T) {
	if dir := os.Getenv("NORTHTALK_TEST_CACHE_DIR"); dir != "" {
		if err := talk.SetCompilationCacheDir(dir); err != nil {
			t.Fatal(err)
		}
		if v := talk.CoreVersions(); v.Core == "" {
			t.Fatal("no Core version")
		}
		if err := talk.SetCompilationCacheDir(dir); err == nil {
			t.Fatal("set the cache directory after compiling")
		}
		return
	}
	dir := t.TempDir()
	for i := range 2 {
		cmd := exec.Command(os.Args[0], "-test.run=^TestSetCompilationCacheDir$")
		cmd.Env = append(os.Environ(), "NORTHTALK_TEST_CACHE_DIR="+dir, "NORTHTALK_ZIG_CACHE_DIR=")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Core %d: %v\n%s", i+1, err, out)
		}
		if entries, err := os.ReadDir(dir); err != nil || len(entries) == 0 {
			t.Fatal("nothing cached", err)
		}
	}
}
