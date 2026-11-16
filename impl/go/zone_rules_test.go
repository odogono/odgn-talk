package northtalk

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func zoneChanges(t *testing.T, v Value) []string {
	t.Helper()
	var out []string
	s := v.String()
	start := strings.Index(s, "changes: [")
	if start < 0 {
		t.Fatalf("no changes in %s", s)
	}
	for _, part := range strings.Split(strings.TrimSuffix(s[start+len("changes: ["):], "]}"), "}, {") {
		out = append(out, strings.Trim(part, "{}"))
	}
	return out
}

func TestZoneRulesFindsEachChange(t *testing.T) {
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	until := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	v, err := ZoneRules("Europe/London", from, until)
	if err != nil {
		t.Fatal(err)
	}
	want := `{zone: "Europe/London", until: 2027-01-01T00:00:00Z, changes: [{at: 2026-01-01T00:00:00Z, offset: 0 s}, {at: 2026-03-29T01:00:00Z, offset: 3600 s}, {at: 2026-10-25T01:00:00Z, offset: 0 s}]}`
	if v.String() != want {
		t.Fatalf("got %s\nwant %s", v, want)
	}
	k, err := ZoneRules("Asia/Kolkata", from, until)
	if err != nil {
		t.Fatal(err)
	}
	if got := zoneChanges(t, k); len(got) != 1 || got[0] != "at: 2026-01-01T00:00:00Z, offset: 19800 s" {
		t.Fatalf("Kolkata: %v", got)
	}
}

// The rules agree with time.Location at points across a southern-hemisphere
// zone, a half-hour zone and London.
func TestZoneRulesAgreesWithLocation(t *testing.T) {
	from := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	until := time.Date(2028, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, zone := range []string{"Australia/Lord_Howe", "America/Santiago", "Europe/London"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		v, err := ZoneRules(zone, from, until)
		if err != nil {
			t.Fatal(err)
		}
		type change struct {
			at     time.Time
			offset string
		}
		var cs []change
		for _, part := range zoneChanges(t, v) {
			fields := strings.SplitN(part, ", offset: ", 2)
			at, err := time.Parse(time.RFC3339, strings.TrimPrefix(fields[0], "at: "))
			if err != nil {
				t.Fatal(err)
			}
			cs = append(cs, change{at, fields[1]})
		}
		for p := from; p.Before(until); p = p.Add(5*24*time.Hour + time.Hour + time.Second) {
			got := ""
			for _, c := range cs {
				if !c.at.After(p) {
					got = c.offset
				}
			}
			_, offset := p.In(loc).Zone()
			if want := Int(int64(offset)).String() + " s"; got != want {
				t.Fatalf("%s at %s: rules give %s, Location %s", zone, p, got, want)
			}
		}
	}
}

func TestZoneRulesRefuses(t *testing.T) {
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	until := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	var he *HostError
	if _, err := ZoneRules("Mars/Olympus", from, until); !errors.As(err, &he) || he.Code != InvalidValue {
		t.Fatalf("unknown zone: %v", err)
	}
	if _, err := ZoneRules("Europe/London", until, from); err == nil || !strings.Contains(err.Error(), "an empty window") {
		t.Fatalf("empty window: %v", err)
	}
	// London kept local mean time, 75 s behind UTC, until 1847.
	if _, err := ZoneRules("Europe/London", time.Date(1840, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(1841, 1, 1, 0, 0, 0, 0, time.UTC)); err == nil || !strings.Contains(err.Error(), "not whole minutes") {
		t.Fatalf("LMT: %v", err)
	}
}
