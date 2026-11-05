# musical-time expectation review

Evidence for #2064 on 2026-11-05. The normative rules are [ADR 0166](../../adr/0166-scripts-wait-in-musical-units-counted-on-the-hosts-transport.md), chapter 3's Musical Units and pitch intervals, chapter 5's `wait` in Musical Units and chapter 9's musical clock.

## First expectations

**Approved.** The maintainer approved all four first blessings on 2026-11-05, and each header records it. The TS runner wrote them (PR #2070), and the Zig Core and Go API replay them unchanged since PR #2071. Approval is separate from that agreement ([checking](../../../corpus/README.md#checking)).

| Case | Pins |
| --- | --- |
| [`bar-waits`](../../../corpus/musical-time/bar-waits/) | waits in bars and beats ended by the musical clock, `wait 0` going straight on, a computed count, a failed wait raising in the Run, and a Timeout Block ending a musical wait |
| [`errors`](../../../corpus/musical-time/errors/) | `out of domain` for fractions and negatives, mixing bars, beats and time, Compound Units, `as s`, and Musical Units where only exact durations are accepted |
| [`no-musical-time`](../../../corpus/musical-time/no-musical-time/) | `no musical time` without a clock, and `wait 0 beats` going on without one |
| [`pitch-and-frequency`](../../../corpus/musical-time/pitch-and-frequency/) | `Hz`/`kHz` and `cent`/`semitone`/`octave` arithmetic and conversion, Musical Quantities within one Kind, and the mixed-Kind and squared errors |
