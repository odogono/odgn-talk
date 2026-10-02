# Changelog

Notable implementation changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with an Unreleased
section for work awaiting a release. Language and Cost Model versions are
tracked separately in the Spec's Data Files.

## [Unreleased]

### Added

- The final five seed Trace Cases are blessed by the TS Core and join the default CI replay: Fuel/allocation minimums, the Persistent State minimum, matching Fuel exhaustion, leading-group canonical patterns and empty-match replacement. Their headers derive the corrected figures and position from the Spec. All existing corpus cases now execute; the implementation guide records the remaining Core gaps for [#126](https://github.com/odogono/odgn-talk/issues/126).

- TS Core Locale Standard Capability factory and `LocaleImpl`, completing all five Standard Capability factories for [#126](https://github.com/odogono/odgn-talk/issues/126). Thirteen tests and three Trace Cases cover eight Operations, tag syntax, option defaults, dense ranks, result validation, Fuel, Library needs and save/restore replay. The Spec settles optional arguments, validation order and the syntax-only RFC 5646 contract.

- TS Core Calendar Standard Capability factory and `CalendarImpl`, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Ten tests and three Trace Cases cover six Operations, optional zones and disambiguation, domain and result checks, declared catalogue failures, Fuel rollback, Library needs and save/restore replay. The Spec settles Nothing defaults and invalid three-argument disambiguation.

- TS Core trailing Optional Capability arguments, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Twelve regression tests and three Trace Cases cover all Operation modes, Joins, literal and dynamic checks, Library compilation and imports, code changes, costs and save/restore settlement. The Host and Trace retain the supplied argument list.

- TS Core Console Standard Capability factory, `ConsoleImpl` and `shape.value`, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Ten regression tests and three Console Trace Cases cover `say`, nested Function Values, Library needs, reads with extra Fuel, cancellation, the human-input timeout, Host failures and save/restore replay. The corpus runner supports Console through `[[standard]]`.

- TS Core Clock and Timer Standard Capability factories, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Nine regression tests and three Trace Cases cover exact Pump readings, fixed declarations, Host timer calls, costs, Library needs and save/restore replay. The corpus runner supports `[[standard]]` for both.

- TS Core `GrantsAsUsed`, kept-Grant inspection and queued revocation, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Fourteen regression tests and three Capability Trace Cases cover caller aliases, Library needs, pending calls, code changes and save/restore replay.

- Library `needs` in the TS Core: explicit compilation declarations, direct and transitive Operation discovery, `missing grant` and imported-call mode/count/Shape checks, with caller bindings and suspension. Replacement retains dependent compilation declarations. Twelve regression tests and two Library Trace Cases continue [#126](https://github.com/odogono/odgn-talk/issues/126).

- TS Core same-family Save and Restore, Group Fingerprints, full and variables-only restores, Host rebinding and pending-call Answer, Fail, Reissue and Adopt, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Twenty-seven regression tests, nine blessed save/restore seeds and two new reissue Trace Cases cover the changes; every implemented Trace Case also runs with save/restore between eligible Pumps.

- TS Core Reload, Extend and atomic Library replacement with transitive importers, variable carry/reset, separate extension code units and stale Function Values, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Twenty-one tests, five `reload/` Trace Cases and the newly supported `pattern-size-literal-limit` seed cover the changes.
- Spec rules for the extension Persistent State cap, inherited tables and links in extension lowering, and preserving exact source scalars in Trace inputs.

- TS Core Broadcasts, AbortSignal cancellation for Requests and Decisions, CancelRun, sticky Stop Script and owner disposal, plus clause-level `queued`, `dropping` and `replacing` policies, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Cancellation cleanup with Segment rollback, call abandonment, a separate Cleanup Budget, Fuel Slices and cap preemption, and `cleanupFailed` reports; six cancellation Trace Cases and four newly supported seeds.
- Spec rules for post-Stop Deliveries and Group state, the cleanup-failure report shape, ready-state accounting and abandonment after preempted cleanup; replay handles Stops and CancelRun inside Host crossings and mailbox refusals ahead of queued inputs.

- Decisions in the TS Core: `decide`, `decideBroadcast`, `veto`, first-Segment Verdict sealing, `decided` reports, Message Path passing, Broadcast aggregation and `wait for` allowing a Decision, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Twenty-two tests and nine decision Trace Cases cover seals, preemptions, errors, faults, dispatch and recipients.
- Decision load checks for veto outside a deciding entry Handler, local Handler calls, veto in Joins and veto or deciding pass after a possible Suspension Point. Spec fixes include function-style Handler calls in the veto restriction, forbid veto inside a Join, define Broadcast overrides as additional per-recipient caps, and place dispatch-time `decided` records before the Handler's Stretch.

- Host Objects and the Message Path in the Core: `defineObjectKind`, `group.object`, `setParent`, `dispose`, owners and well-known objects, Deliveries and Requests to objects, climbing on `unhandled` and `pass`, `me` and `the target`, sends to objects and Command Calls up the path, properties with `prop` records, `isDisposed`, and objects in the display form and the Value Encoding; with `objects/` Trace Cases, and Spec fixes for `send … to me` in a Script that owns nothing, undefined properties and property failures, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Joins and `wait for` in the Core: Join Members started where they stand, `MaxJoin`, answers in start order, failing fast with `index` and abandoning the rest; one-line and block `wait for` with `from`, captures, Guards, timeouts and `after` branches, matched as each message is dispatched; and the `not in a join` and `empty join` load checks; with `suspension/joins` and `suspension/wait-for` cases, `max-join-minimum` blessed, and Spec fixes for an event's argument count, its test's charges and naming a Script in `from`, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Suspension in the Core: `wait`, suspending Operations with `answer`, `fail`, late costs and `maxPending`, `send … and wait` with its reply, `send failed` and `MaxWait`, and `and wait` calls to Handlers and local Function Values, with timers, `abandon` and `late-answer` records, Persistent State counting suspended Runs, and the `missing and wait`, `needless and wait` and `can't suspend here` load checks; with `suspension/` Trace Cases, six seed cases blessed, and Spec fixes for `wait`'s `wrong kind`, late-answer charges, `abandon`'s order and an unhandled Run's clause, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Capabilities and `send` in the Core: `defineCapability`, Shapes and Grants, the load checks of `ask`, `tell` and `say`, immediate and fire-and-forget Operations with their costs, `Charge`, Shape checks, `Fail` and `host error`, and `send` between Scripts with `mailbox full`; with `capabilities/` Trace Cases, the corpus runner's Stubs, the `mailbox-depth` seed case blessed, and Spec fixes for naming a Script in a `send`, Shape mismatch fields, `Fail` Data charges and `call` records, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- The stdlib Libraries in the Core: `text`, `list`, `map`, `bytes`, `json`, `date` and `units`, compiled from their normative source and always available, with errors raised in stdlib code naming the Script's call (ADR 0037); with `stdlib/` Trace Cases, and Spec fixes for a stdlib Library's version and identity and for leaving them out of the Group Fingerprint, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Library calls in the Core: `compileLibrary`, `addLibrary` and the `add-library` Host Input, calls to imported functions and Handlers, imported Constants and defaults, Function Values made from Library code, errors and Limit Faults inside Library code, code identities that cover imports, and the `not in a library` load errors; with `libraries/` Trace Cases, and Spec fixes for adding a Library before its imports and for identities, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- The number and Float Built-ins in the Core: `sqrt`, `exp`, `ln`, `log10`, `power`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan` and `atan2`, correctly rounded to 34 digits, and `fromFloat64`, `fromFloat32`, `toFloat64` and `toFloat32`; with `math/` Trace Cases, and Spec fixes for the fields of their domain errors and the rounding of floats, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Instants and Civil Dates in the Core: the `instant` and `civilDate` Host constructors, their display form and `$instant` and `$date` Value Encoding, date arithmetic and comparison, `as civil date` and `as instant`, and the date Built-ins; with `dates/` Trace and Value Encoding cases, and Spec fixes for the fields of date errors, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Bytes and Binary Patterns in the Core: the `bytes` Host constructor, their display form and `$bytes` Value Encoding, `<< … >>` builds, Binary Pattern matching, `byte` chunks, `the bytes of`, `as text` and `as bytes`, comparison and Bytes searches; with `bytes/` Trace and Value Encoding cases, and Spec fixes for what chapters 4 and 8 left open, including the `bytes-sized` instruction for `v as n bytes` in a build, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Quantities in the Core: the `quantity` Host constructor, their display form, Value Encoding and ranges of them, Quantity literals, arithmetic and `as` through Base Units, equality and ordering in Base Units, and `abs`, `floor`, `ceiling`, `truncate` and `round` keeping the Unit; with `quantities/` Trace and Value Encoding cases, and Spec fixes for what chapter 3 left open, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- The Core's Group: Load with code identities and load diagnostics, queued Deliveries and Requests, Pumps that follow chapter 5's turns with Fuel Slices, debt and the Fuel cap, Persistent State at each Segment's end, Inspect, and a Trace sink writing chapter 11's records; and Trace Case replay and bless in the corpus runner, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- The Core's Abstract Machine: loading code units, Handler Clause dispatch, calls and Lambdas, unwinding through the Unwind Table, Cost Model 0 Fuel and allocation with Limit Faults and rollback, exact decimal arithmetic, chunks, properties, Built-ins, and Text Patterns on chapter 8's Pike VM, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).

- Core normative lowering of checked Scripts and Libraries onto chapter 8's code units (constant pool, definitions, variables, objects, body table, code, Unwind Table and event table), with the canonical disassembly, generated instruction tables, a structural check of every lowered source against `machine.toml`, and explicit-stack passes for deep source, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Disassembly Cases under `corpus/disassembly/`, together emitting every instruction, and corpus runner support for running them and for `--bless`ing their expected files.

- Core construct and Guard diagnostics: duplicate map keys, number literal limits, unknown kinds and impossible conversions, misplaced `ignoring case` and `delimited by`, Text Pattern Captures in repetitions and invalid `as number`, misplaced rests, partial-byte bit runs, Script `private` declarations and Guard calls, Lambdas and Host Object properties, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Core control-flow and body-context diagnostics: misplaced `exit repeat`/`next repeat`, transfers that leave `finally`, `pass` and `the target` inside Lambdas, `pass` naming another message, and invalid Handler suffix combinations, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Core read-only Constant and Lambda capture checks, bare-variable `set` diagnostics, named function argument contracts, default ordering and initializer/default reference checks with exact diagnostic positions and ordering, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- Core name resolution with typed semantic trees, source spans, whole-body local collection, Lambda captures, and exact ordered load-time diagnostics for invalid names, clashes and duplicate bindings, continuing [#126](https://github.com/odogono/odgn-talk/issues/126).
- A lossless Core modal lexer and predictive parser, with typed concrete syntax trees, original token/trivia spans, exact source reconstruction and first-error syntax diagnostics for [#126](https://github.com/odogono/odgn-talk/issues/126).
- Browser-safe generated syntax/Unit tables, regeneration checks and Core parsing tests covering diagnostic fixtures, corpus Scripts, Standard Libraries and documentation examples.

- The first TypeScript Core value foundation for [#126](https://github.com/odogono/odgn-talk/issues/126): generated, pinned Unicode 18 tables for NFC normalization, Character boundaries and case mapping.
- Immutable public text, number, boolean, Nothing, list and map values, with canonical display and Value Encoding readers and writers.
- Text helpers for NFC joins, scalar ordering, whole-Character literal searches and chunk splitting.
- Unicode conformance tests, value round-trip tests, an execution runner for the NFC encoding case, and a browser bundle with a smoke test.
- Type checks and implementation checks in CI, alongside the existing Spec checks.
- TypeScript linting with ESLint and `@nkzw/eslint-config`, formatting with Prettier, and CI checks for both.

### Changed

- `v as n bytes` in a build lowers to its value, its size and `bytes-sized`, so its size is kept.
- A Unit naming two Units of one Unit Kind, such as `2 m*ft`, is `bad unit` rather than a `LoweringError`.
- Twelve `limits/` and `text-patterns/` Trace Cases are blessed by the TS Core and run in CI ([#159](https://github.com/odogono/odgn-talk/pull/159)).
- The `text-model/` Trace Cases are blessed by the TS Core, with Cost Model 0's Fuel, allocation and Persistent State figures and their code identities, and run in CI ([#126](https://github.com/odogono/odgn-talk/issues/126)).
- Apply the shared lint rules and formatting to TypeScript implementation and Spec tooling.

### Fixed

- The Spec now states that Run-ending `return`, `pass` and `veto` check Persistent State before their own charge, matching the Core and the corrected minimum-limit Trace. Suspension checks follow the charged instruction and any Host effect.

- Spec rules for Optional Capability argument omission: only an outer Optional suffix may be omitted, explicit Nothing remains supplied, and no placeholders or defaults are inserted. Declared costs still apply; `say` keeps exactly one source argument. No syntax or Cost Model rate changes.

- Spec gaps in Console's embedding interface and fixed declarations. The new `value` Shape accepts all values, including nested Function Values, so Console can show their text form; `any` remains data-only and storage still refuses Function Values. No syntax or Cost Model rate changes.

- Spec rules for Standard Capability factory costs: required per-Operation entries, bounded whole numbers, copied costs and ignored extra names; explicit Clock and Timer arities and error declarations; and Trace setup conflicts, Clock Stubs and Host-owned timer Deliveries. No syntax or Cost Model rate changes.

- Restoring retains each Grant's saved Operation set even when the Host rebinds a wider template, and preserves aliases such as `__proto__`. Existing extension calls reconstruct before revocation state applies. Reissue keeps revoked pending calls under Host control when their Grants rebind. Rejected Reloads and Library replacements keep old code, Grants and revocation state. The Spec fixes one-time Grant trimming, inspection, revocation no-ops and code-change boundaries; Cost Model rates are unchanged.

- Library Capability validation runs before code-cache reuse and on every Script import, including Reload, Extend, replacement and restore. Nested Lambda calls are checked once at their own sites. The Spec now fixes declaration input, needs ordering, alias names and import diagnostics; Cost Model rates are unchanged.

- Reissue Fuel cutoff preserves committed state and abandons only pending calls, including partially answered Joins. Backwards Pumps write their refusal while retaining queued inputs.
- Spec gaps in canonical Fingerprint declarations, Save id counters, numeric call-id ordering, reissue Fuel accounting and discarded Broadcast Decisions are settled. Cost Model rates are unchanged.

- Existing Script names no longer overwrite declared bindings during checking. Decision checks include calls from extensions into older vetoing Handlers, and Function Values receive immutable code identities before initialisers run.

- Persistent State counts ready Runs and their retained answers, as well as parked Runs and cancellation cleanup. Seven existing Trace Cases have corrected state figures; Cost Model rates are unchanged.

- Delivery and Decision limit overrides reject fractional, negative and non-finite values before allocating ids, including fractional `MaxWait`.

- Uncaught Run errors now enqueue the Script's `error` message, including `on error` text shorthand, `during` binding in Guards, dropping unmatched error messages and preventing an error-message chain. Pending waits observe these messages even without an error Handler; queued error messages count toward Persistent State until dispatch. Seven existing traces are re-blessed for that state and turn ordering.

- A Run's clause in its `seg` and `preempt` records is its entry Handler's, not that of a Handler it called by name.
- A Built-in that raises is charged by its own rate, `builtin.<name>`, as chapter 8 says, instead of failing on a rate that doesn't exist.
- The Core's parser, and the grammar check's, read a build whose first field is a build, `<< <<1, 2>> >>`, as chapter 1 lexes it.

[Unreleased]: https://github.com/odogono/odgn-talk/commits/main/
