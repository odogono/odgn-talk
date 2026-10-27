# Folio records a play-through as a generated Test Script

ADR 0133 deferred recorded play-throughs ([#1616](https://github.com/odogono/odgn-talk/issues/1616)). An author records one in Browse with **Record Test**, and Folio writes it as a **Recorded Test**: an ordinary Test Handler, added to a Test Script named `recorded.test`, that replays the reader's input through the Folio Harness and ends in assertions. There is no new file kind and no new runner. Run Tests and `northtalk test` run it like any Test Handler, and the author can read and edit it.

- **Start:** Record Test restarts Browse on the first Page with the seed 0, where every Test Handler starts.
- **Input:** only keys and clicks, as `key` and `click` calls. A Page change follows from them, so it isn't recorded. Typing into reader-editable text, pointer movement and answers to `ask user` aren't recorded either, because the Harness has no verbs for them. Each one leaves a `-- not recorded` comment at its place, and Folio warns when recording stops.
- **Time:** rounded to 16 ms `frame` calls, with a run of them written as a `repeat` loop. A Project with no `frame` Handler gets `advance` calls instead.
- **Assertions:** the current Page, each Text Element's `text`, and the `visible` of each Element whose visibility differs from the authored Project. Canvas drawings, fills, positions and Script state are left out. The expected values come from replaying the generated input headless, so a new Recorded Test passes. If that replay ends differently from what the author saw, Folio says so when recording stops.

We chose this because a recording is then only a quick way to write a Test Script, so authors never meet a second testing vocabulary (ADR 0133). Recording reader input, not Host Inputs, keeps a Recorded Test meaningful after the author edits their Scripts.

## Considered Options

- **A Play Recording stored in the Project and replayed by its own runner:** this would need another file format, a runner and a second vocabulary.
- **A golden file for Folio's own tests, on the TS Play harness, as ADR 0133 suggested:** authors would never get it. Folio's Example Projects can ship Recorded Tests instead.
- **Replaying a Trace:** the Trace pins Fuel and Segment details, so it breaks on any Script edit. It stays a Conformance Corpus tool.
- **Every frame's exact elapsed time, or one `frame` per gap between inputs:** the first is unreadable, and the second gives a Script that acts on each frame one large step.
- **Expected values from the live session:** the rounded replay can end differently, which would leave a test failing the moment it is written.

## Consequences

- Recording `ask user` answers and text typing needs new Folio Harness verbs, which is a separate decision.
- Each recording becomes a Test Handler named `testRecording1`, `testRecording2` and so on. The Code Browser opens at it so the author can rename it.
