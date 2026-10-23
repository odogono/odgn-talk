# Folio pauses a Play Session on a virtual Host clock

In Browse or Present, an author can Pause a Play Session and Step it one frame at a time ([#1209](https://github.com/odogono/odgn-talk/issues/1209)). While browsing, they can then inspect it in the Variables window or the Message Box. The Core has no notion of being paused: a Host pauses a Group by not pumping it (spec chapter 9). So pausing is a Host policy, kept entirely in Folio's Play worker.

Folio's Play clock is no longer the wall clock. It is a virtual clock: Host time minus the total time spent paused, never going backwards. The Stack's `LiveDebugger.clock()` (`tooling/stack/src/debug.ts`) does the same, and both use one shared module.

While paused:

- no `frame` is delivered and no timer fires, because the clock does not move;
- reader input on the Page is dropped, not queued, and the canvas shows that the session is paused;
- while browsing, the Message Box still runs its line in its own Pump without moving the clock, so a `wait` it starts stays pending until a Resume or a Step.

A Step moves the clock forward by one frame interval, delivers one `frame` to each Script that handles it, fires any timers that come due, runs one Pump and pauses again. Play, Pause and Step sit together in Folio's header and act on whichever Play Session is running. Every Play Session starts unpaused, and leaving Browse or Present ends the session as usual. The Performance window leaves out paused time and counts a Step's Pumps as usual, but leaves the other Pumps run while paused, such as the Message Box's, out of its Pump peaks.

This amends [ADR 0095](0095-folio-delivers-a-frame-message-to-scripts-that-handle-it.md): a `frame` Handler's argument is the milliseconds of Play-clock time since that Script's previous `frame`, so paused time is never counted.

## Considered Options

- **Pausing against the wall clock**: the Core rejects a clock that goes backwards, so a pause cannot rewind it. On Resume every pending `wait` would fire at once, and the next `frame` would carry the whole pause as its elapsed time.
- **A pause in the Core**: every Host would have to implement a debugging concept that only an authoring tool needs. The Core already accepts any clock that never goes backwards.
- **Queuing reader input while paused**: Resume would replay a burst of stale input, and a Step would have to decide how much of the queue to use.
- **Pausing only in Browse**: freezing a game in Present is useful on its own, to look at it, even without the Variables window or Message Box. One set of controls for every Play Session is simpler than controls that come and go with the mode.
- **A Step as one Pump, or a chosen amount of time**: a Pump with no time passing never delivers a `frame` or fires a timer, and a chosen amount of time does not match what a frame means in Play.

## Consequences

- Elapsed time in a Play Session can be reproduced while stepping, and on Resume it continues as if the pause had not happened.
- The Variables window refreshes after each Step or Message Box Pump, because it reads after every Pump.
