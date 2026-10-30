# Changelog

Notable implementation changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with an Unreleased
section for work awaiting a release. Language and Cost Model versions are
tracked separately in the Spec's Data Files.

## [Unreleased]

## [0.5.0] - 2026-10-30

### Added

- **spec:** Specify a `keepMailbox` restore option: with `'reload changed'`, a Partial Restore keeps each changed Script's mailbox, so queued messages go to the new code and their senders go on waiting (#1821).
- **ts:** `RestoreOptions.keepMailbox` keeps each changed Script's mailbox in a Partial Restore: its messages go to the new code, a Request's sender goes on waiting for the reply, and the kept messages count toward the Persistent State cap. A live `reload` with `keepMailbox` now counts its kept messages toward the cap too, as the Zig Core does (#1823, #1835).

## [0.4.0] - 2026-10-29

### Breaking

- **ts:** `@northtalk/ts` saves are no longer JSON: `save()` writes the binary save format both Cores share (chapter 10, ADR 0144), so a TS save restores on the Zig Core and a Zig save on the TS Core. Saves written by earlier versions are refused as `invalid save`. A stale Function Value's documentation now survives a restore only in a Session, which keeps it by code unit (#1722).
- **spec:** SQLite charges `perStep` Fuel before every statement step instead of `max × perRow` up front. `sqliteCapability(impl, costs, perStep)` in TS and `Core.SqliteCapability(impl, costs, perStep)` in Go pass `query` and `change` a `beforeStep` callback, which every `SqliteImpl` must call once immediately before each step, the completion check and the probe past `max` included, propagating its refusal without stepping; the `node:sqlite` and Go drivers do. `query` is metered `read-only` and `change` `segment-bound`, so a refused step writes `charge-refused=yes`. Corpus setup takes `perStep`, and `perRow` is refused (#1795).

### Added

- **spec:** Report `unit without number` instead of `unexpected token` when a Unit follows a name or a bracketed expression, as in `wait tick s`. A Unit can only follow a number, so the message suggests `tick as s`, `tick * 1 s` or putting the Unit in the Constant.
- **ts:** Add `group.stateFingerprint()` and `core.stateFingerprint(save)` to the TS Core, so a Host can tell whether two saves hold the same state even though each save's bytes differ (#1697).
- **ts:** The TS Core's `restore` accepts `onMismatch: 'reload changed'`. When the only mismatch is Script code, it continues the Scripts whose code matches and rebuilds each changed Script from its new code with its Script Variables carried over, as a Reload would. `RestoreResult.reloaded` and the Trace `restore` record (`mode=partial`, `reloaded=[…]`) list the rebuilt Scripts (#1707).
- **ts:** The TS Core accepts Operation `metering` declarations and lets a suspending `read-only` call queue `call.requestCharge(fuel)`, settled by the next Pump as accepted, limit or inactive, with the same Trace as the Zig Core. Issued calls keep their eligibility and the request counter across saves, and a pending metered call or unresolved request refuses Save with `effects pending`. Late answers to ended calls are recorded and ignored (#1748).
- **spec:** A Session can make charge requests: `:mock <capability>.<operation> suspending read-only` defines a metered mock, and `:charge <call> <fuel>` queues a request for its pending call and pumps, in the TS, Zig and Go REPLs. The Zig Core now writes a refused charge request before the next Host Input record, as the TS Core does (#1795).
- **ts:** A metered Operation whose callback has a `charge` refused now writes `charge-refused=yes` in its `call` record after the accepted `charged`, as the Zig Core does (#1795).
- **spec:** A save taken after a reissue records the reissued call: its `now` is the Clock reading of the Pump that reissued it, and its `charged` is the Fuel its reissued `Start` charged (#1781).
- **ts:** The TS Core's debug controller can `evaluate` a Handler body in a paused Run's Script, seeing a chosen frame's locals read-only and writing Script Variables, without touching the Trace (#1769).
- **ts:** Add the TS Core's codec for the save format both Cores share: its primitives, header, section frames and digests, and an incremental SHA-256. Saves don't use it yet.

### Fixed

- **ts:** An error inside a Join's body that runs a `finally` block in the Join's frame, then is caught outside the body, now abandons the Join's pending members, as the Zig Core does (#1742).
- **ts:** In the TS Core, a Run unparked by a `queued` clause goes on in a new Segment, so its later Segment ids and saves match the Zig Core's.
- **ts:** Declare the TS `sqlite` Capability's errors with their catalogue fields, as the Zig Core does, so a save that holds a `sqlite` Grant restores on either Core instead of failing with `save mismatch` (#1751).
- **spec:** Write a charge request refused while another is still queued after that request, in the order the Host made the calls, so a Trace with an overlap refusal replays in every Core (#1807).
- **ts:** Make `call.charge(fuel)` follow the Metered Operations rules on every call the TS Core makes, as the Zig Core already does. An amount that isn't a whole number of Fuel, such as `-5` or `1.5`, is now `invalid value` instead of being accepted. Once a charge is refused, later charges in the same callback are refused too, instead of a smaller one getting through. A call reissued after restore draws on the Cleanup Budget while its Run is cancelling.
- **ts:** List a `try`'s Unwind Table entries after those of a `try` inside its catch handler or its `finally` block, as chapter 8 orders them and the Zig Core does. This changes TS disassembly only (#1738).
- **ts:** When an error escapes a Recovery policy, run the policy's own `finally` blocks and the failure's retained cleanup before searching outward from the catching `try`, as chapter 6 says and the Zig Core does. A Guard on an outer catch now sees what those blocks wrote, and the Fuel follows (#1737).
- **ts:** Save the same bytes as the Zig Core after a restore. A reissued call records its reissue's Clock reading and Charge, and a Run that waited on a restored call keeps that call's id as its last wait (#1746, #1781).

### Performance

- **spec:** Shrink the shared save format before its first release: Grants share their declarations, concurrent Runs share the Script Variables they start from, names and other repeated texts are written once in a new `texts` section, and Operation modes and Mark outcomes are single bytes. A Function Value with code no longer repeats its home Script. Saves are now smaller than the old TS JSON saves, and restore is faster (#1758).
- **ts:** Make `core.stateFingerprint(save)` read the State Fingerprint from the save's header instead of hashing every section, as chapter 10 specifies: about 4.3 ms down to 13 µs for an 800 KB save.

## [0.3.0] - 2026-10-28

### Added

- **ts:** Add a `closeTimeoutMs` driver option so `drive.close()` resolves after a bound, reporting Host `run` Promises still pending to `onCloseTimeout`, and document that a suspending Operation's `run` must settle once `call.signal` aborts (#1553).
- **ts:** Add `script.handlers` to Scripts loaded through `createGroup`, and `handlersOf(script)` for any Script, to call Handlers with plain JS arguments and answers over either Core. `group.load<T>()` optionally types those calls.
- **ts:** The TS Core runs `set` through a property's value, such as `set the isLocked of the door of me to true`, with one Get and one Set that a Stop, cancel or rewind never lands between (#1626).
- **spec:** `set` writes a path below a Host Object property, so `set the isLocked of the door of me to true` reads `door`, changes one key and writes it back with one Set. A Stop, cancel or rewind never lands between the read and the write (#1626).
- **spec:** A Host Manifest may name an Owner Kind with `ownerKind`: the Object Kind of `me` for its kind of Script, which tooling reads and the Core never does. `ExportManifest` writes it last and refuses a kind that isn't in `objectKinds` (#1628).
- **spec:** Add `withPath`, `withoutPath` and `hasPath` to the `map` Library, which write, remove and test a value through a Value Path given as data, and `pointerPath` to the `json` Library, which converts JSON Pointer text to a Value Path (#1631).
- **spec:** Add `applyPatch(doc, patch)` to the `json` Library, which applies an RFC 6902 JSON Patch to a value and raises the new `can't patch` error when an operation fails (#1632).
- **ts:** Add `inlineGrants` to expose plain JS functions as immediate or suspending Operations, with plain-data conversion and cancellation signals, over the TS Core and Zig Host Adapter (#1562).
- **ts:** Accept safe-integer JS numbers in `toValue` with `{ numbers: 'integer' }`, including inside arrays, objects and Maps. The default still refuses JS numbers.
- **ts:** Add `createGroup({ name, core?, ...driverOptions })` for a driven Group with `close(reason?)` and `await using` disposal. The root export defaults to the process-wide TS Core; `/wasm` requires an explicit Core.
- **spec:** Run `the elements of o`, `repeat for each` over it, and `every element … whose` / `the first element … whose` on the TS and Zig Cores, through the new `list-elements` instruction (#1627).
- **spec:** Specify walking a Host Object's Object Collection: `the elements of o` gives its members as a list, so `repeat for each` and `every element … whose` work over a room's contents (#1627).

### Fixed

- **ts:** `openSqliteDatabase('')` and `openSqliteDatabase(':memory:')` now say to open a file in a temporary directory instead, and the README explains why an in-memory database isn't supported.
- **ts:** Keep the TS debugger from pausing inside a `set` through a property's value, so a Stop, cancel or Rewind made at a pause can't land between its Get and its Set, and defer a replay landing recorded inside one until the Set (#1642).
- **ts:** Require Node 24.10 or later for every `@northtalk/ts` entry point, including Core-only applications, and verify the packed package and server runtime kits at that minimum. Node 22 and Node versions below 24.10 are no longer supported. Bun and browser support are unchanged.
- **ts:** Passing plain JS where a Value is expected, as in `script.invoke('hit', 'bob')`, now gives an error that names the call, the argument's position and its JS type. It suggests `text()`, `num()` or `toValue()`, or `script.handlers.<name>(...)` for a named Handler. This works on both Cores and for `invoke`, `request`, `deliver`, `decide`, `broadcast`, `call` and `callPump`.

### Performance

- **ts:** Reduce Script and Library Load time by compacting precedence syntax, climbing operator precedence in one parser task, building the semantic tree in the checker's bounds walk, and avoiding repeated token copies and line searches while lexing.
- **ts:** Run TS Core iteration, key reads, appends, function calls and returns on the fast path, and step many instructions per Group callback, cutting `core/fib` and `core/calls` Run time by roughly 35–45% on Bun (#1585).
- **ts:** Reduce TS Core instruction overhead by reusing charging scratch space, popping operand stacks directly and privately owning immutable Value and Map data (#1580).
- **ts:** Defer arithmetic result text until it is read, count decimal digits without BigInt string conversion, and skip multiplying or dividing a checked value by exactly 1.
- **ts:** Cut TS Core Load time by about 15%, and LSP reanalysis by about 13%, by finding the checker's per-element records by source position, sharing unchanged control-flow contexts, building tokens without object spreads and caching recent code identities (#1586).
- **ts:** Build map literals in one pass and append single List items along one edge path in the TS Core, so collecting record rows runs about a third faster (#1583).
- **ts:** Cache Text measurements and Characters in the TS Core, and normalize concatenation only at the join, so building and reading text avoids repeated full-string scans.

## [0.2.0] - 2026-10-23

### Breaking

- **spec:** The binary Request/Pump map layout, `request-pump-map-v1`, is retired. The Spec defines only the JSON and fields layouts. The Zig guest refuses the feature in `hello` like any unknown feature, and the experimental Go adapter no longer accepts `TALK_ZIG_REQUEST_PUMP=map` (#1334).
- **ts:** Add external-source Group snapshots with verified Host-supplied Script and extension sources, explicit variables-only recovery, and checkpoint support. Reduce both save modes with shared Grant declarations and compact JSON graphs. Native TS saves now use format 10; format-9 and older saves are no longer readable.
- **ts:** `@northtalk/ts` and `@northtalk/ts/wasm` export one `Core`, `Group` and `Script` interface, which the TS Core and the Zig Host Adapter both implement, so Host code typed against them switches Cores by its import (ADR 0121). The TS Core's classes are now `TsGroup` and `TsScript`: `Group` is a type only, and the `ScriptHandle` alias is gone. The Abstract Machine's `Script` export is now `CompiledScript`. `newDrivenGroup` takes the Core first, as `newDrivenGroup(core, options)`, and the driver works on either Core, with `close()` waiting for the adapter's Host Promises too. The adapter gains `Script.invoke`, `core.versions` on the TS Core matches it, and it now exports `toValue`, `fromValue`, `talk`, `nowMicros` and `SendFailedReason`.
- **ts:** Type Capability Host functions from their Shapes (ADR 0120): `do`, `run`, `start` and `fire` take arguments as JS values (`shape.text` as a `string`, `shape.number` as a `Decimal`, and so on), and may return the result's JS form. A Capability with a binding is now defined with `defineCapability<Binding>()(name, ops)`.

### Added

- **spec:** An `ask` may name a Result Target, `ask g to op x into y`, which puts the result into `y` as well as `it` (ADR 0112, #1340).
- **ts:** The TS Core parses and lowers a Result Target on `ask`: `ask world to lies item into location` puts the answer into `location` as `put it into location` would, and `it` is still set. A Join Member with a Result Target is `not in a join` at its `into` (#1340).
- **ts:** Add `newDrivenGroup` to `@northtalk/ts/driver` to create a Group already wired to its event-loop driver, so Requests can be awaited immediately (#1417).
- **ts:** Add `drive.close(reason)` and async disposal to stop a driven Group's Scripts, await Promise-backed Host operation cleanup, and cancel scheduling before releasing application resources (#1418).
- **ts:** Add `toValue` and `fromValue`, which convert between Script Values and plain JS data. `toValue` refuses a JS `number` unless the Host passes `{ numbers: 'decimal' }` (ADR 0119, #1419).
- **ts:** Add `Script.invoke(name, ...args)`, which resolves with a Request's answer, `nowMicros()` for manual Pumps, and a `talk` tag that dedents inline NorthTalk source and rejects JS interpolation (#1422).
- **spec:** Specify the TS embedding's `Script.invoke`, `nowMicros()` and `talk` source tag, renaming the unreleased `Script.call` so `call` keeps meaning a Function Value call (#1423).
- **spec:** Add the `degrees(x)` and `radians(x)` Built-ins, which convert between radians, Talk's one angle unit, and degrees. Each is correctly rounded to 34 digits like the trigonometric functions, so `radians(180)` is `pi` and `degrees(pi)` is `180` (#1450).
- **spec:** Add `http`, an optional Standard Capability with which a Script serves HTTP requests itself (`serve`, `unserve`, `respond`), the Script Runner that `northtalk app.talk` becomes, and a `Call`'s delivery id (ADR 0124, ADR 0125, ADR 0126).
- **ts:** Add `@northtalk/ts/http`, a server-only HTTP router on `node:http` that serves the `http` Standard Capability under Bun and Node: shared listeners, longest-prefix matching, Deliveries per request, answers settled from the Pump's reports, a 1 MiB default body limit answered 413, and graceful drain, with the language-neutral http test kit (ADR 0124).
- **spec:** Let a one-line `wait for` take a Guard after any timeout, as in `wait for pressed key or 30 s where key = "Y"`, in every Core (ADR 0109, #1247).
- **spec:** Specify Result Targets on tell-block Operation lines, Command Calls, call statements and waiting sends, including per-member assignment when a Join succeeds (#1350).
- **ts:** Add combined Request/Pump and Function-call/Pump outcomes on the TS and WASM Cores, retaining requested handles when Pump fails. Negotiate the selected binary Message Layer envelope and publish browser-safe, transferable Value/frame codecs under `@northtalk/ts/message-layer` (ADR 0110, #1256).
- **ts:** Give a `send failed` `ScriptError` a typed `reason`, such as `cancelled` or `errored`, so a Host can switch on it without decoding `data` (#1421).
- **ts:** Exchange WASM Operation, property, effect and Grant release callbacks in the negotiated binary fields envelope. Keep JSON compatibility with `createCore({ binaryCallbacks: false })` (#1314).

### Fixed

- **ts:** Support settle-pump frames in the transferable binary codec, preserving queued answers, failure Data and optional late Fuel (#1335).
- **ts:** Fault a talk.ts Run preempted in a Join at a member's saved call site when its reissued call has its Charge refused, recording the fault as a resumed Stretch (#1413).
- **ts:** Omit capability and operation fields from restored `call lost` errors, preserving source locations and Join member indexes (#1407).

### Performance

- **ts:** Run simple TS Core instructions through a fast path, with small integers kept as JS numbers, so `core/loop` runs about 7× faster with unchanged Fuel and allocation (#1297).
- **ts:** Speed up List item replacement in the TS Core without changing Fuel or logical allocation (#1293).
- **ts:** Reduce messaging and Script lifecycle overhead in the TS Core by skipping Trace formatting and Trace-only state counting when no Trace callback is installed, with unchanged Fuel (#1292).
- **ts:** Speed up Text Pattern searches by reusing matcher scratch storage, reducing thread allocation and freezing Match map pairs only once (#1294).
- **ts:** Decode each binary WASM callback Value once, and encode callback results directly from the answer, so binary callbacks are faster than JSON callbacks under both Bun and Node (#1318).

## [0.1.0] - 2026-10-17

### Added

- First public npm release of [`@northtalk/ts`](https://www.npmjs.com/package/@northtalk/ts/v/0.1.0), published under the MIT Licence from [`ts-v0.1.0`](https://github.com/odogono/odgn-talk/tree/ts-v0.1.0), for [#1173](https://github.com/odogono/odgn-talk/issues/1173).
- ESM and TypeScript declarations for the TS Core, Session Host, Stores, notifications, SQLite, driver, Zig reactor embedding and tooling surfaces. The package excludes the corpus replay helpers and `talk.wasm`.
- Support for Node 22 or later (`sqlite` needs Node 22.13 or later), Bun, evergreen browsers and TypeScript 5.9 or later, checked against the packed tarball.

Earlier development notes are preserved below in [Earlier unreleased history](#earlier-unreleased-history).

## Earlier unreleased history

### Changed

- The TS Core moved to `impl/ts/`, inside a Bun workspace whose root also holds the Spec tools in `tools/` ([ADR 0046](../../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md)). Its corpus runner and browser smoke test are now `impl/ts/tools/`. The package and its exports are unchanged.

### Added

- The Session Host of chapter 12 in `@odgn/northtalk/session`, and the `northtalk` REPL in `tooling/cli`, for [#131](https://github.com/odogono/odgn-talk/issues/131). Entries, Session Commands, mocks, the virtual Clock, saves, user Libraries, export and the built-in `clock`, `calendar` and `locale` run as the Spec says, with each built-in answer recorded as a `~` line. The Session Host records the session through its environment's `record`, and `replayTranscript` replays one, comparing what it records. `corpus:run` runs the Session Transcripts in `corpus/sessions/`, and replays each one's `case.trace` as a Trace Case in both replays.

- Process-wide `createCore()`/`Core` and deterministic `exportManifest`, completing [#200](https://github.com/odogono/odgn-talk/issues/200). Existing free-function helpers share the Core's compile caches and definitions. Scripts reuse compilation across Groups, reloads and restores while retaining separate state and per-load checks; extension caching covers complete Script history. Host Manifests export sorted declarations and Shapes without bindings or executable Host callbacks.

- Host-side `decodeJson`, `encodeJson`, `coreVersions` and `Versions`, completing [#199](https://github.com/odogono/odgn-talk/issues/199). Plain JSON preserves exact decimal digits and scale, NFC strings and member order, with shared Host/Library tests for values and errors. Version metadata reads the generated language, Cost Model and Unicode pins and the save-format constant used by save and restore.

- Regression tests that a Limit Fault is never caught (no `catch` or `finally` runs) and that a runaway Script's fault leaves the other Scripts in its Group, and its own rolled-back state, intact, completing [#129](https://github.com/odogono/odgn-talk/issues/129)'s acceptance.

- `call failed` Host reports and `PumpResult.nextDeadline`, part of [#196](https://github.com/odogono/odgn-talk/issues/196). A `host error` now reports its call id, `{capability, operation}` and the Host-side detail (a thrown error, a result that breaks its Shape, or a refused failure code or key) beside its `call-failed` Trace record; the Script still sees no detail. `nextDeadline` is the `pumped` record's `next`. Five tests cover immediate and suspending calls, declared failures and deadlines.

- Group-level regression tests for the `initialiser failed` load diagnostic and the `duplicate object id` Host error, from the [#126](https://github.com/odogono/odgn-talk/issues/126) embedding API and diagnostic audit. The audit's remaining interface gaps are #196 to #200, recorded in the implementation guide.

- TS Core `Script.counters()` and public `Counters`, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Seventeen tests and three Trace Cases cover live, parked, completed and discarded work, faults, cleanup, event tests, Reissue, code changes and restore. Chapter 9 settles counting rules and chapter 11 adds `counters` input/output records.

- Queued Host Object messages follow the live Message Path at dispatch, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Twenty-four regression tests and three Trace Cases cover mailbox transfers, ordering, Requests and Script sends, Decisions, cancellation, receiver limits, path continuation, disposal and save/restore. `wait for … from` now supports evaluated object filters as well as named senders, including block waits and retained state accounting.

- TS Core Function Value calls across Scripts and from the Host through `group.call`, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). Forty-one tests and four Trace Cases cover mailbox Runs, replies, defaults, captures, Home Script Grants and limits, cancellation, timeouts, stale handles and save/restore. Library Constant callbacks bind to the importing Script; display-form readers and corpus replay resolve earlier Host-held handles. The Spec settles foreign charging, Host arity failures, callback Constants/defaults and Function call inspection/error labels.

- TS Core fractional-exponent `^`, continuing [#126](https://github.com/odogono/odgn-talk/issues/126). It uses the correctly rounded `power` math while preserving the operator's Fuel, allocation, overflow fields and integer/Quantity rules. Regression tests and two Trace Cases cover results, domain errors, underflow, limits and rollback; the Spec clarifies operator diagnostics and charging.

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

- TS Core step 1 ([#126](https://github.com/odogono/odgn-talk/issues/126)) is complete: the last five seed blessings and the four Value Encoding cases have had their human review. Stale "isn't blessed" and "Unblessed" headers in ten Text Pattern cases and the encoding cases are corrected, and the implementation guide and corpus README record the step's acceptance.

- Host reports and Inspection now match `talk.ts`, completing [#196](https://github.com/odogono/odgn-talk/issues/196). A `run end`'s `error` is a `ScriptError` (code, text message, other fields as `data`) rather than the raw map, and it carries `at` (code unit, Handler, instruction index and source position) for `errored` and `limit fault`; `limit` and `cleanupFailed` use the Trace's limit names. `unhandled` carries its `target` object. Suspended Runs in an Inspection give `wait`, `until` and `calls`, and mailbox entries omit absent `delivery`/`from` instead of `null`. `ScriptError.data` is now a `Value` (Nothing by default), so a rejected Request's `send failed` gives its reason as a map. Chapter 9 settles which instruction `at` names and what `until` covers. Twelve tests cover the reports and Inspection; Trace output is unchanged.

- `v as n bytes` in a build lowers to its value, its size and `bytes-sized`, so its size is kept.
- A Unit naming two Units of one Unit Kind, such as `2 m*ft`, is `bad unit` rather than a `LoweringError`.
- Twelve `limits/` and `text-patterns/` Trace Cases are blessed by the TS Core and run in CI ([#159](https://github.com/odogono/odgn-talk/pull/159)).
- The `text-model/` Trace Cases are blessed by the TS Core, with Cost Model 0's Fuel, allocation and Persistent State figures and their code identities, and run in CI ([#126](https://github.com/odogono/odgn-talk/issues/126)).
- Apply the shared lint rules and formatting to TypeScript implementation and Spec tooling.

### Fixed

- Wait-for event-test work now counts in a Pump's `fuelUsed`, the receiving Script's Fuel Slice and debt, and the Group Fuel cap ([#193](https://github.com/odogono/odgn-talk/issues/193)). Regression tests and three Trace Cases cover slice debt, the Group cap and faulting on resume.

- Corpus restore replay drops withheld Libraries from its current registry, so a later full restore uses the restored Group's Library set.

- Save format 2 preserves completed and discarded Run Fuel/allocation totals and Limit Fault counts, including variables-only restores. Format 1 is now `invalid save`, since its missing totals cannot be reconstructed without losing already spent work.

- The Spec settles moving-message admission and scheduling: transfers join the destination tail without a new depth check or dispatch charge; already started Runs stay put. Climbs continue from the last owner’s current parent, and receiver limits cannot be loosened by an earlier Host override. Script-addressed messages keep their original owner Target while climbing. Detaching an object writes the required `parent=nothing` Trace field.

- Function ownership is validated at inbound Host boundaries, including nested results, answers, failure Data and properties. Automatic Promise forwarding settles refused results as `host error`, including after Reissue. Foreign reply timers respect each Run’s MaxWait override. Corpus Stubs and answers resolve previously exported Function handles.

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
