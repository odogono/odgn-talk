package value

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"northtalk.org/go/internal/decimal"
)

var civilSyntax = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?)?$`)
var instantSyntax = regexp.MustCompile(`^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?)(Z|[+-][0-9]{2}:[0-9]{2})$`)

// DateRangeError separates a syntactically valid unsupported year from a
// malformed date, for the Script conversion error catalogue.
type DateRangeError struct{ Year int }

func (e *DateRangeError) Error() string { return fmt.Sprintf("year %d outside date range", e.Year) }

func NewCivil(f DateFields) (Value, error) {
	if f.Year < 1 || f.Year > 9999 {
		return Value{}, &DateRangeError{f.Year}
	}
	if f.Month < 1 || f.Month > 12 || f.Day < 1 || f.Day > 31 || f.Hour < 0 || f.Hour > 23 || f.Minute < 0 || f.Minute > 59 || f.Second < 0 || f.Second > 59 || f.Microsecond < 0 || f.Microsecond >= 1e6 {
		return Value{}, fmt.Errorf("invalid Civil Date fields")
	}
	if !f.HasTime && (f.Hour != 0 || f.Minute != 0 || f.Second != 0 || f.Microsecond != 0) {
		return Value{}, fmt.Errorf("time fields without HasTime")
	}
	t := time.Date(f.Year, time.Month(f.Month), f.Day, 0, 0, 0, 0, time.UTC)
	if t.Day() != f.Day || int(t.Month()) != f.Month {
		return Value{}, fmt.Errorf("nonexistent Civil Date")
	}
	return Fields{Kind: CivilDate, Date: f}.Value(), nil
}
func ParseCivil(s string) (Value, error) {
	m := civilSyntax.FindStringSubmatch(decimal.Trim(s))
	if m == nil {
		return Value{}, fmt.Errorf("invalid Civil Date text")
	}
	num := func(i int) int { n, _ := strconv.Atoi(m[i]); return n }
	f := DateFields{Year: num(1), Month: num(2), Day: num(3), HasTime: m[4] != "", Hour: num(4), Minute: num(5), Second: num(6)}
	if m[7] != "" {
		f.Microsecond, _ = strconv.Atoi(m[7] + strings.Repeat("0", 6-len(m[7])))
	}
	return NewCivil(f)
}
func NewInstant(seconds int64, micros int32) (Value, error) {
	if seconds < -62135596800 || seconds > 253402300799 {
		return Value{}, &DateRangeError{time.Unix(seconds, 0).UTC().Year()}
	}
	if micros < 0 || micros >= 1e6 {
		return Value{}, fmt.Errorf("invalid Instant")
	}
	return Fields{Kind: Instant, Seconds: seconds, Micros: micros}.Value(), nil
}
func ParseInstant(s string) (Value, error) {
	m := instantSyntax.FindStringSubmatch(decimal.Trim(s))
	if m == nil {
		return Value{}, fmt.Errorf("invalid Instant text")
	}
	civil, e := ParseCivil(m[1])
	if e != nil {
		return Value{}, e
	}
	f := civil.Date()
	offset := 0
	if m[2] != "Z" {
		h, _ := strconv.Atoi(m[2][1:3])
		min, _ := strconv.Atoi(m[2][4:6])
		if h >= 24 || min >= 60 {
			return Value{}, fmt.Errorf("invalid UTC offset")
		}
		offset = (h*60 + min) * 60
		if m[2][0] == '-' {
			offset = -offset
		}
	}
	t := time.Date(f.Year, time.Month(f.Month), f.Day, f.Hour, f.Minute, f.Second, 0, time.UTC)
	return NewInstant(t.Unix()-int64(offset), int32(f.Microsecond))
}
func civilText(f DateFields) string {
	s := fmt.Sprintf("%04d-%02d-%02d", f.Year, f.Month, f.Day)
	if f.HasTime {
		s += fmt.Sprintf("T%02d:%02d:%02d", f.Hour, f.Minute, f.Second)
		if f.Microsecond != 0 {
			s += "." + strings.TrimRight(fmt.Sprintf("%06d", f.Microsecond), "0")
		}
	}
	return s
}

// InstantFromTime truncates t toward the past to the microsecond. Unix and
// Nanosecond already floor, so negative times truncate correctly.
func InstantFromTime(t time.Time) (Value, error) {
	return NewInstant(t.Unix(), int32(t.Nanosecond()/1000))
}

// Time is the Instant as a UTC time.Time.
func (v Value) Time() time.Time {
	return time.Unix(v.Seconds(), int64(v.Micros())*1000).UTC()
}
