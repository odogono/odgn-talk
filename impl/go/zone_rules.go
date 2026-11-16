package northtalk

import (
	"fmt"
	"time"
)

// ZoneRules builds Zone Rules for the IANA zone from `from` up to `until`,
// exclusive, from the Host's time zone database (chapter 9, Zone Rules
// builders; ADR 0179). It walks the zone's periods with ZoneBounds, keeping
// only the boundaries where the offset changes.
func ZoneRules(zone string, from, until time.Time) (Value, error) {
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return Nothing, &HostError{InvalidValue, fmt.Sprintf("ZoneRules: unknown zone %s: %v", zone, err)}
	}
	if !from.Before(until) {
		return Nothing, &HostError{InvalidValue, "ZoneRules: an empty window"}
	}
	instant := func(t time.Time) (Value, error) {
		return Instant(t.Unix(), int32(t.Nanosecond()/1000))
	}
	var changes []Value
	add := func(t time.Time, offset int) error {
		if offset%60 != 0 {
			return &HostError{InvalidValue, fmt.Sprintf("ZoneRules: %s is %d s from UTC at %s, not whole minutes", zone, offset, t.UTC().Format(time.RFC3339))}
		}
		at, err := instant(t)
		if err != nil {
			return err
		}
		n, _ := Int(int64(offset)).AsDec()
		q, err := Quantity(n, "s")
		if err != nil {
			return err
		}
		change, err := Map(KV("at", at), KV("offset", q))
		if err != nil {
			return err
		}
		changes = append(changes, change)
		return nil
	}
	_, current := from.In(loc).Zone()
	if err := add(from, current); err != nil {
		return Nothing, err
	}
	for t := from; ; {
		_, end := t.In(loc).ZoneBounds()
		if end.IsZero() || !end.Before(until) {
			break
		}
		if _, offset := end.In(loc).Zone(); offset != current {
			if err := add(end, offset); err != nil {
				return Nothing, err
			}
			current = offset
		}
		t = end
	}
	end, err := instant(until)
	if err != nil {
		return Nothing, err
	}
	name, err := Text(zone)
	if err != nil {
		return Nothing, err
	}
	return Map(KV("zone", name), KV("until", end), KV("changes", List(changes...)))
}
