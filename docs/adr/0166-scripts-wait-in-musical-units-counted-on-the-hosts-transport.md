---
status: proposed
---

# Scripts wait in Musical Units counted on the Host's Transport

To arrange a song ([#2044](https://github.com/odogono/odgn-talk/issues/2044)), a Folio Script needs a wait that ends on a bar line, even when the tempo changes during it. So the Unit Catalogue gains two **Musical Units**, `bar` and `beat`. They are counted on the Host's Transport, and the Catalogue gives them no length.

```talk
on drumPart
  loop "bd [hh hh] sd hh" on drums       -- intro
  wait 8 bars
  loop "bd hh sd hh, - - - cp" on drums  -- verse, from bar 9
end drumPart
```

**The language**

- `bar`/`bars` and `beat`/`beats` are each a Unit Kind of their own. Like Calendar Units, they sit outside the dimension system of [ADR 0022](0022-compound-units-convert-into-the-left-operands-units.md). They don't convert into each other or into exact time, and they never appear in a Compound Unit. So `1 bar + 2 beats`, `1 bar + 500 ms` and `8 bars as s` are errors.
- Within one Kind they add, subtract, scale by a plain number and compare. They can be stored and passed like any Quantity.
- Only a plain `wait` accepts them. Timeout Blocks, `maxWait` and Host Operations still take exact durations.
- `wait` takes a whole number of bars or beats, 0 or more. `wait 0 bars` doesn't suspend, and a fraction or a negative number is an error. `wait` doesn't set `it`.
- The Core doesn't turn a Musical Unit into a deadline. It suspends the Run with a musical Wait, and the Host ends that Wait. A Host without a Transport raises an error saying it keeps no musical time. The Host Manifest declares whether a Host keeps musical time, so the editor can flag such a `wait` before it runs.

**What a bar wait means**

- `wait N bars` ends on the Nth bar line after now. A wait that starts exactly on a bar line doesn't count that line. `wait N beats` works the same way on beat lines.
- The Run resumes one lead before the line, as `beat` messages do. It carries that line as its musical time, so a `loop` or `play` straight after the wait starts on that bar, even if the Pump runs late.
- Bars count on the Transport, not in seconds. A tempo change during a wait stretches or shrinks the bars still to come, and the wait still ends on a bar line.
- A paused or stopped Transport holds bar waits. Hush, `stop` and Punch In end them, because they discard the Runs ([ADR 0157](0157-folio-punches-in-an-edited-script-at-the-next-bar.md)).
- On Perform, bar 1 starts when the Transport starts, even for a wait that `openScript` begins before then. On Punch In, counting starts at the punched bar, so parts started together stay in lockstep.

**Folio's Transport**, amending [ADR 0158](0158-folio-plays-instruments-on-one-transport.md):

- `setTimeSignature` takes effect at the next bar line, and bar numbering continues from there. `setTempo` still takes effect at the next beat.
- The `beats` Operation, which turned beats into an exact duration, is removed. `wait 2 beats` replaces it.
- Two Runs of one Script that `loop` on one Instrument still follow last-wins. So a conductor Handler can hand an Instrument from one section to the next.

**Frequency and pitch interval**

- The Catalogue also gains two fixed-factor Kinds:
  - **Frequency:** `Hz` (dimension 1/s) and `kHz` (1000 Hz).
  - **Pitch interval:** a base dimension of its own, with Base Unit `cent`, plus `semitone` (100 cents) and `octave` (1200 cents).
- An Instrument's frequency parameters accept `800 Hz` as well as a plain `800`, which is read as Hz.
- Operations that transpose accept a pitch interval.
- A note and an interval don't add: `c3 + 7 semitones` stays out of scope.

This amends ADR 0022: a Musical Unit is a Catalogue entry with no factor. Hosts and Scripts still can't add Units.

## Considered Options

- **A Transport Operation that returns the time until a bar line** (`ask transport to bars 8` / `wait it`): no language change, but the duration is fixed when the wait starts, so a tempo change during the wait moves it off the grid.
- **A Transport Operation answered on the bar line** (`ask transport to bars 8 and wait`): stays on the grid when the tempo changes, with no language change. Rejected because `wait 8 bars` reads as the author means it, and gives other Hosts with musical time the same form.
- **Waiting for a Transport event** (`wait for bar 9`): needs `beat` or `bar` messages to reach Scripts without an `on beat` Handler, and counting from now means doing arithmetic on absolute bar numbers.
- **`wait 1 bar` as one bar's length from now:** it ends off the grid, so a `loop` after it starts a bar late.
- **Fractional Musical Quantities:** `wait 1.5 bars` has no bar line to end on.
- **A sub-beat Unit** (`tick`): Mini-Notation already divides a bar within a Sound Pattern, and the ticks per beat and triplets would be open questions.
- **`frame` as a Host-timed Unit:** game Scripts already have `on frame` and exact waits, and it would widen the Host contract beyond musical time.
- **`dB`:** logarithmic, so it can't be expressed as a factor.
- **`bpm`:** tempo stays a plain number. `beats/min` would need a Compound Unit mixing a Musical Unit with time.
- **`cycle`:** in Folio a cycle is a bar, so it would be a synonym.

## Consequences

- Every Core implements the musical Wait, and the conformance corpus tests it against a test Host with a scripted musical clock.
- A Script ported to a Host without a Transport fails at its first musical `wait`. Its Host Manifest lets the editor warn about this beforehand.
- Instruments in saved Projects keep working, because frequency parameters still accept plain numbers.
