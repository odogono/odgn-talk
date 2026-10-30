package zigwasm

import (
	"context"
	"regexp"
	"testing"
)

// The embedded artifact names the reactor-v* release it was built from, or
// git describe's version after one, marked +hand-swap by hand-swap.sh.
func TestArtifactRecordsReactorVersion(t *testing.T) {
	recorded, err := Recorded()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+(-\d+-g[0-9a-f]+)?(\+hand-swap)?$`).MatchString(recorded.Reactor) {
		t.Fatalf("reactor version %q is not a reactor-v* version", recorded.Reactor)
	}
}

// An artifact.json without a reactor version is refused.
func TestArtifactWithoutReactorVersionIsRefused(t *testing.T) {
	saved := manifest
	t.Cleanup(func() { manifest = saved })
	manifest = []byte(`{"sha256":"00"}`)
	if _, err := Recorded(); err == nil {
		t.Fatal("Recorded accepted an artifact with no reactor version")
	}
	if _, err := NewEngine(context.Background(), ""); err == nil {
		t.Fatal("NewEngine accepted an artifact with no reactor version")
	}
}
