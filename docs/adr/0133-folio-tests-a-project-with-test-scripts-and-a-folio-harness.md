# Folio tests a Project with Test Scripts and a Folio Harness

An author tests a Folio Project the way ADR 0056 tests Scripts ([#1139](https://github.com/odogono/odgn-talk/issues/1139)). A Project-level Script whose name ends in `.test` is a Test Script. It is saved in the Folio file and hidden from Play. Each of its Test Handlers runs against a fresh Play Session of the Project, starting on the first Page, with the seed fixed. The Test Script joins that Group and reaches every other Script only by message. It may not `extend` the Scripts under test. It is granted the **Folio Harness**, which is ADR 0056's Harness plus five read-only or input verbs: `key:` (sends `keyDown`, then `keyUp`), `click:`, `frame:` (moves the Play clock and delivers one `frame`), `property:of:`, which reads an Element property, and `goTo:`. A Run Tests command in Folio lists each Test Handler's result and links a failure to its line.

Folio's own Example Project tests use a TypeScript Play harness that wraps `PlaySession` with the same virtual clock and settling. Unlike author tests, it may `extend` Scripts and read Canvas drawings.

We chose this because ADR 0056 already gives us a black-box test that adds nothing to the language. Folio only adds the reader input a game needs.

## Considered Options

- **Check Scripts, a new Folio-only test concept:** this would add a second testing vocabulary for no gain.
- **Recorded play-throughs as the primary test:** brittle golden files that are hard to read as specifications (ADR 0056). They were deferred, and [ADR 0134](0134-folio-records-a-play-through-as-a-generated-test-script.md) later made them generated Test Scripts instead.
- **Letting tests `extend` the Scripts under test:** easy board setup, but it breaks the boundary ADR 0056 keeps. Authors expose a setup message instead.
- **Inspecting Canvas drawings from author tests:** this would expose drawing-command encoding as an API. It stays TS-harness-only until there is demand.

## Consequences

- Running `.folio` tests headless with `northtalk test`, and replaying recorded input, are follow-ups.
- `.test` becomes a reserved suffix for Project Script names.
