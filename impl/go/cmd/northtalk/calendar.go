package main

// `calendar` on Go's time zone database, with the IANA data embedded so every
// build has the same zones. It follows tooling/stack/src/builtins.ts.

import (
	"slices"
	"time"
	_ "time/tzdata"

	talk "github.com/odogono/odgn-talk/impl/go"
)

const microsPerDay = 24 * 60 * 60 * 1_000_000

type calendar struct{}

// location is the zone in use: the call's, or the Grant's.
func location(c *talk.Call, zone string) (*time.Location, error) {
	if zone == "" {
		zone, _ = c.Binding().(string)
	}
	// LoadLocation reads "" and "Local" as zones of its own.
	if zone != "" && zone != "Local" {
		if loc, err := time.LoadLocation(zone); err == nil {
			return loc, nil
		}
	}
	data, _ := talk.Map(talk.Pair{Key: "zone", Val: mustText(zone)})
	return nil, &talk.ScriptError{Code: "unknown zone", Message: zone + " is not a known time zone", Data: data}
}

func instantMicros(v talk.Value) int64 {
	seconds, micros, _ := v.AsInstant()
	return seconds*1_000_000 + int64(micros)
}

// wallAt is the wall clock in the zone at an Instant.
func wallAt(us int64, loc *time.Location) talk.DateFields {
	t := time.UnixMicro(us).In(loc)
	return talk.DateFields{
		Year: t.Year(), Month: int(t.Month()), Day: t.Day(), HasTime: true,
		Hour: t.Hour(), Minute: t.Minute(), Second: t.Second(), Microsecond: t.Nanosecond() / 1000,
	}
}

// asUTC reads a wall clock as if it were UTC, in epoch microseconds.
func asUTC(w talk.DateFields) int64 {
	return time.Date(w.Year, time.Month(w.Month), w.Day, w.Hour, w.Minute, w.Second, w.Microsecond*1000, time.UTC).UnixMicro()
}

// offsetAt is the zone's offset from UTC at an Instant, in microseconds.
func offsetAt(us int64, loc *time.Location) int64 { return asUTC(wallAt(us, loc)) - us }

func civil(w talk.DateFields, dateOnly bool) (talk.Value, error) {
	if dateOnly {
		w = talk.DateFields{Year: w.Year, Month: w.Month, Day: w.Day}
	}
	return talk.CivilDate(w)
}

func instantOf(us int64) (talk.Value, error) {
	t := time.UnixMicro(us)
	return talk.Instant(t.Unix(), int32(t.Nanosecond()/1000))
}

func (calendar) Zone(c *talk.Call, zone string) (talk.Value, error) {
	loc, err := location(c, zone)
	if err != nil {
		return talk.Nothing, err
	}
	return talk.Text(loc.String())
}

func (calendar) Today(c *talk.Call, zone string) (talk.Value, error) {
	loc, err := location(c, zone)
	if err != nil {
		return talk.Nothing, err
	}
	return civil(wallAt(c.Now().UnixMicro(), loc), true)
}

func (calendar) Now(c *talk.Call, zone string) (talk.Value, error) {
	loc, err := location(c, zone)
	if err != nil {
		return talk.Nothing, err
	}
	return civil(wallAt(c.Now().UnixMicro(), loc), false)
}

func (calendar) ToCivil(c *talk.Call, i talk.Value, zone string) (talk.Value, error) {
	loc, err := location(c, zone)
	if err != nil {
		return talk.Nothing, err
	}
	return civil(wallAt(instantMicros(i), loc), false)
}

func (calendar) Offset(c *talk.Call, i talk.Value, zone string) (talk.Value, error) {
	loc, err := location(c, zone)
	if err != nil {
		return talk.Nothing, err
	}
	seconds, _ := talk.Int(offsetAt(instantMicros(i), loc) / 1_000_000).AsDec()
	return talk.Quantity(seconds, "s")
}

// ToInstant finds the Instants whose wall clock reads c: one, two in an
// overlap, or none in a gap, which `compatible` and `later` move forward past.
func (calendar) ToInstant(c *talk.Call, cv talk.Value, disambiguation, zone string) (talk.Value, error) {
	loc, err := location(c, zone)
	if err != nil {
		return talk.Nothing, err
	}
	fields, _ := cv.AsCivilDate()
	local := asUTC(fields)
	before := offsetAt(local-microsPerDay, loc)
	after := offsetAt(local+microsPerDay, loc)
	var found []int64
	for _, t := range []int64{local - before, local - after} {
		if !slices.Contains(found, t) && wallAt(t, loc) == fields {
			found = append(found, t)
		}
	}
	slices.Sort(found)
	if len(found) == 1 {
		return instantOf(found[0])
	}
	if disambiguation == "reject" {
		data, _ := talk.Map(talk.Pair{Key: "civil", Val: cv}, talk.Pair{Key: "zone", Val: mustText(loc.String())})
		return talk.Nothing, &talk.ScriptError{Code: "ambiguous time", Message: cv.String() + " is ambiguous in " + loc.String(), Data: data}
	}
	if len(found) == 2 {
		if disambiguation == "later" {
			return instantOf(found[1])
		}
		return instantOf(found[0])
	}
	// A gap: `earlier` reads the wall clock with the offset after it.
	small, large := min(before, after), max(before, after)
	if disambiguation == "earlier" {
		return instantOf(local - large)
	}
	return instantOf(local - small)
}
