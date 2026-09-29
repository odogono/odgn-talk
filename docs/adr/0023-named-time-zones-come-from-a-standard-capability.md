# Named time zones come from a Standard Capability, and everything zone-free is built in

A Civil Date is one value kind whose time of day is optional, and dates run from 0001-01-01 to 9999-12-31 in the proleptic Gregorian calendar. Field functions (`year(d)`, `weekday(d)`, …) are Built-ins, and they take Civil Dates only. An Instant has no fields until a Script turns it into a Civil Date. Converting at a fixed offset needs no time-zone database, so it is a Built-in too: `toCivil(i, offset)` and `toInstant(c, offset)`, with the offset an exact duration such as `0 s` or `-5 hr`. Only named zones need Host data. They come from two Standard Capabilities, whose Operation Declarations the spec fixes and whose answers the Host supplies. `clock` has no zone and offers `now`, which gives an Instant. `calendar` is bound to a zone, and offers `today`, a Civil `now` and conversion between Instants and Civil Dates. The Grant sets its default zone, and any call can name another. A local time that falls in a DST gap or overlap is resolved the way Temporal's `"compatible"` disambiguation resolves it, unless the call asks otherwise. The `date` Library builds, formats and parses Civil Dates with templates of named, numeric fields in braces (`"{day:2}/{month:2}/{year}"`). We chose this because reading an Instant's fields in UTC by default is the classic wrong-day bug, and a Script should see a zone wherever one is used. The Cores bundle no tz database (ADR 0021), but UTC and fixed-offset maths is pure, so keeping it built in costs nothing and lets Guards test fields. Reading the time is a permission and a timing side channel in its own right (#8), so a Script that needs Instants shouldn't also need a zone. A Script that serves users in several zones needs to name them per call, while the common case names none. Word-named tokens can't be misread the way `MM` and `mm` are, and one template language covers formatting and parsing.

## Considered Options

- **Field functions over Instants, read in UTC:** convenient, but `day(stamp)` would silently give the wrong day for most of the world.
- **No Built-in conversion, so every conversion goes through a Capability:** it makes UTC maths an effect, puts it in the Trace, and keeps it out of Guards, though it needs no Host data.
- **One `calendar` Capability that also reads the time:** a Script that only timestamps events would be granted a zone it never uses. `ask clock to today` can't work, because a day needs a zone.
- **`now` as a Built-in reading the scheduler's Clock:** deterministic under replay, but #8 made reading the time a Capability, so a Host can withhold it.
- **Zones only at Grant time:** simplest, but a Script that handles users in several zones couldn't do it.
- **Zones only per call:** every call would repeat the zone, and a Host that already knows its tenant's zone couldn't supply it.
- **Rejecting ambiguous local times by default:** exact, but a beginner's Script would fail on two nights a year that nobody tests.
- **Two Civil kinds, a date and a date-time, as in Temporal:** a finer split than beginners need. ADR 0022 already treats "a Civil Date with no time of day" as one kind.
- **A date-only value that behaves like midnight:** a hidden coercion, which ADR 0003 rules out.
- **Temporal's full year range (±271821):** neither strict parser (ADR 0011) accepts expanded years, so some values would print in a form that doesn't read back (ADR 0018).
- **LDML or ISO letters (`YYYY-MM-DD HH:mm`):** familiar, but `MM` against `mm` is a trap, and LDML's `YYYY` is the week-year.
- **strftime (`%Y-%m-%d`):** opaque to beginners.
- **Parsing only through Text Patterns:** they already handle messy input, but a fixed format would need a pattern and a construction call where one template does both directions.
- **Construction that normalises (`makeDate(2026, 2, 30)` giving March 2):** it hides mistakes. Only month arithmetic clamps (#8).
- **RFC 3339 text offsets (`"+05:30"`):** a second parser, where the exact-duration Units already exist.
- **ISO 8601 duration text (`PT1H30M`) and a `formatDuration`:** Quantities already print (`90 min`), and `splitDuration` gives the parts.

## Consequences

- **Civil Dates:** narrows #8 decision 14.
  - A Civil Date is a date, or a date and time of day. There is no time-of-day-only kind.
  - A date-only value and a date-time are never equal, and ordering one against the other is an error, as with an Instant against a Civil Date.
  - Dates run from 0001-01-01 to 9999-12-31, proleptic Gregorian. Construction, parsing or arithmetic outside that range raises `out of range`.
- **Built-ins:** narrows ADR 0021.
  - Fields, each taking a Civil Date: `year`, `month`, `day`, `hour`, `minute`, `second`, `nanosecond`, `weekday`, `dayOfYear`, `isoWeek`, `isoWeekYear` and `hasTime`.
  - `hour`, `minute`, `second` and `nanosecond` raise `wrong kind` on a date-only value.
  - `weekday(d)` is ISO 8601: 1 is Monday and 7 is Sunday. Day and month names come only from the `locale` Capability.
  - `toCivil(i, offset)` gives a date-time, and `toInstant(c, offset)` takes one. The offset is an exact duration that is a whole number of minutes, less than 24 hr in magnitude, and UTC is `0 s`.
  - `day`, `month` and `year` are also Unit names, but a Unit is only a suffix directly after a numeric literal, so `day(d)` parses. `second` is an ordinal only after `the`, so `second(d)` parses too.
- **Standard Capabilities:**
  - The spec fixes their Operation Declarations, so every Host offers the same shapes. Each Host implements them and sets their per-call cost, and the Trace records their answers.
  - `clock`: `now`, immediate, giving an Instant. It answers with `Call.Now()`, the scheduler's Clock reading (ADR 0015).
  - `calendar`: `today` (a date-only value), `now` (a date-time), `toCivil i`, `toInstant c`, `offset i` (the exact duration in effect at `i`) and `zone` (the IANA id in use). All are immediate.
  - Each `calendar` Operation takes an optional trailing IANA zone id, and otherwise uses the zone the Grant binds. An unknown zone raises `unknown zone` with `{zone}`.
  - `toInstant` also takes an optional disambiguation: `"compatible"` (the default: a time in a gap moves forward by the gap's length, and a time in an overlap takes the earlier Instant), `"earlier"`, `"later"` or `"reject"`. `"reject"` raises `ambiguous time` with `{civil, zone}`.
  - Operation names aren't stdlib names, so `calendar`'s `offset` doesn't clash with the `offset` Built-in.
  - `locale` is the third Standard Capability (ADR 0024).
- **The `date` Library:** narrows ADR 0021.
  - Construction: `makeDate(y, m, d)`, `makeDateTime(y, m, d, h, mi)` with optional `s` and `ns`, and `atTime(d, h, mi)`, which adds a time to a date-only value. They are written in the language over `as civil date`.
  - A field that isn't an integer in its range raises `out of range` with `{field, value}`, and is never normalised.
  - `daysInMonth(d)`, `isLeapYear(y)` and `dateOnly(d)` are written from the Built-ins.
  - `formatDate(d, template)` and `parseDate(t, template)` use the same template.
  - `splitDuration(d)` gives `{days, hours, minutes, seconds}`, whole parts with the fraction kept in `seconds`. `monthsBetween(a, b)` counts whole calendar months with #8's clamping rule.
  - The Constant `epoch` is `1970-01-01T00:00:00Z` as an Instant, so a Unix timestamp is `epoch + n s`, and back again is `(i - epoch) as s`.
- **Templates:**
  - Tokens: `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}`, `{weekday}`, and `{fraction:n}` for the first n digits of the nanoseconds. `{{` and `}}` are literal braces.
  - All tokens are numeric. There is no 12-hour clock and no AM/PM, which are locale concerns.
  - In `formatDate`, `:n` pads with zeros and never truncates. In `parseDate`, `:n` needs exactly n digits, and a token with no width takes one or more.
  - A template must contain `{year}`, `{month}` and `{day}`. A time token needs `{hour}` and `{minute}`, and seconds default to 0. `parseDate` gives a date-only value unless the template has time tokens.
  - `parseDate` must match the whole text. A mismatch, or a `{weekday}` that disagrees with the date, raises `can't convert` with `{value, format, at}`.
  - `formatDate` takes Civil Dates only, so an Instant goes through `toCivil` or `calendar` first.
- **Durations:** narrows ADR 0022.
  - Instant − Instant and date-time − date-time give an exact duration in `s`, with at most nine decimal places.
  - Date-only − date-only gives `days` (ADR 0022).
  - Subtracting a date-only value from a date-time, or the reverse, raises `wrong kind`.
- **Sketch 08:** `d - today()` becomes `ask calendar to today` followed by `d - it < 7 days`. The `calendar` Capability in the example Host is the zone-bound one.
- **Left for later:**
  - The literal syntax and the printed form of Civil Dates and Instants.
  - The Cost Model rates for the date Built-ins.
  - The `locale` Operations for month and day names. Resolved by ADR 0024.
- Narrowed by ADR 0024: `monthNames` gives 12 names, January first, and `dayNames` gives 7, Monday first, matching `weekday(d)`. Both take `width` and `form` options. `formatDate`'s tokens stay numeric, and there is no locale date pattern.
