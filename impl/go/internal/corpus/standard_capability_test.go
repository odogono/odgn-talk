package corpus

import (
	"errors"
	talk "github.com/odogono/odgn-talk/impl/go"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStandardReplayRefusesMalformedCostsAndDuplicates(t *testing.T) {
	clock := Setup{"capability": "clock", "costs": Setup{"now": Setup{}}}
	for _, setup := range []Setup{
		{"standard": []any{Setup{"capability": "console", "costs": Setup{"write": Setup{}}}}},
		{"standard": []any{Setup{"capability": "console", "costs": Setup{"write": Setup{"fuel": true}, "read": Setup{}}}}},
		{"standard": []any{Setup{"capability": "clock", "costs": Setup{}}}},
		{"standard": []any{Setup{"capability": "clock", "costs": Setup{"now": Setup{"fuel": "7"}}}}},
		{"standard": []any{Setup{"capability": "clock", "costs": Setup{"now": Setup{"alloc": true}}}}},
		{"standard": []any{Setup{"capability": "clock", "costs": Setup{"now": int64(0)}}}},
		{"standard": []any{clock, clock}},
		{"standard": []any{clock}, "operations": []any{Setup{"capability": "clock", "name": "now", "mode": "immediate", "result": "instant"}}},
	} {
		func() {
			defer func() {
				if v := recover(); v != nil {
					t.Errorf("setup panicked: %v", v)
				}
			}()
			_, err := setupOperations(talk.New(), setup)
			var host *talk.HostError
			if !errors.As(err, &host) || host.Code != talk.InvalidValue {
				t.Errorf("setup %v: %v", setup, err)
			}
		}()
	}
}

func TestStandardClockReplayRefusesStub(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "case.trace"), []byte("> stub clock.now value=2026-10-02T10:00:00Z\n"), 0600); err != nil {
		t.Fatal(err)
	}
	c := Case{Dir: dir, Setup: Setup{"standard": []any{Setup{"capability": "clock"}}}}
	if reason := (executionBackend{}).Support(c); !strings.Contains(reason, "cannot use a Stub") {
		t.Fatal(reason)
	}
}
