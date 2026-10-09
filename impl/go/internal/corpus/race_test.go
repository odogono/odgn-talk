package corpus

import "testing"

// skipUnderRace skips an exhaustive replay that runs on one goroutine, where
// the race detector has nothing to find and slows the replay about twelvefold.
// CI runs the suite once more without -race, which covers it.
func skipUnderRace(t *testing.T) {
	t.Helper()
	if raceEnabled {
		t.Skip("single-goroutine replay; covered by the run without -race")
	}
}
