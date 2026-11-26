# psychoscript compared with Northtalk

The question is whether [psychoscript](https://github.com/anomalyco/psychoscript) has ideas that could improve Northtalk's language or its runtime, meaning the Cores and the Hosts. psychoscript is a confined, resumable JavaScript interpreter. This note reads psychoscript's README, support matrix, changelog, Rust README and source at commit `bf492e12017fb25621080676ddb8cd4fa60b7a9d` (2026-11-25). It reads Northtalk at `d0dccdcf`. Every psychoscript path below is relative to that repository at that commit. psychoscript was read as source only: nothing from it was built or run.

## Summary

- **What psychoscript is:** strict-mode JavaScript, compiled to bytecode and run on a VM in TypeScript, with a second VM in Rust held to parity. It is meant for running code a model, user or plugin wrote against an API the host controls. A run can be suspended to bytes and resumed in another process ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md)). Its language is JavaScript. It brings no ideas about messaging, Handlers, Units, Patterns or error recovery.
- **Northtalk already has, often in a stronger form, almost everything psychoscript does at the runtime level:**
  - suspend to bytes, with code recompiled and checked by identity on restore
  - a build identity check on resume
  - pending host calls that are re-run or adopted after a restore
  - cancellation signals passed to host calls
  - a second implementation held to parity by recordings from the first
  - a save and restore at every scheduling point in tests

  Northtalk adds deterministic Fuel, saves that restore on either Core, State Fingerprints and Segment rollback, and psychoscript has none of these.
- **psychoscript is weaker where Northtalk's design matters most.** Its limits are wall-clock time. Its randomness and `Date.now()` read the host engine, and a regular-expression match can't be interrupted. A snapshot resumes only in the build and implementation that wrote it.
- **One idea is worth adopting, and it is tooling-only:**
  - "Did you mean" suggestions in the LSP for `unknown name`, `unknown operation` and the `unknown-message` Lint.
  - psychoscript carries `suggestions` on every structured error. Northtalk's tooling has the names it would need, in the checker's scopes, the Grant declarations and the Host Manifest, but suggests nothing today.
- **Two ideas are worth parking until a Host asks:**
  - Host data kept with a pending call in the save, like psychoscript's `Host.durableFn`.
  - Lending Bytes without a copy to Immediate Operations in native Hosts, like psychoscript Rust's borrowed typed arrays.
- **The rest should be rejected.** These ideas conflict with determinism, load-time checking or the Group Fingerprint, or a Northtalk ADR has already ruled on them:
  - wall-clock timeouts
  - lazy host namespaces
  - streaming bodies
  - Host metadata in the save
  - a snapshot size cap
  - error stack traces in error maps
  - leniency towards familiar-but-wrong code
- **Recommendation:** file one tooling issue for the did-you-mean quick fix, and take nothing else now. Be candid in any follow-up: psychoscript solves a smaller problem, sandboxed JavaScript with resumable runs, that Northtalk's Cores already solve more strictly.

## What psychoscript is

### Goals and shape

- **The purpose:** "A confined, resumable JavaScript interpreter. Programs are compiled to bytecode and run on a VM with no ambient access … A run can be suspended while it waits, saved to bytes, and resumed later" ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md)). The stated users are code from a model, a user or a plugin, and "long-running programs alive across restarts".
- **The scope:** the repository holds only "the language: compiler, VM, runtime, standard library, snapshots, the Promise API and its optional Effect adapter" ([`AGENTS.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/AGENTS.md)).
- **The implementation:**
  - Acorn parses the source ([`package.json`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/package.json), the only runtime dependency).
  - An allowlist compiler emits bytecode ([`src/compiler/compile.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/compiler/compile.ts)).
  - A register-and-stack VM runs it ([`src/vm.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/vm.ts), 3,736 lines).
  - Part of the standard library is a "prelude" written in JavaScript and shipped as bytecode ([`src/prelude/bytecode.json`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/prelude/bytecode.json)).
- **The Rust implementation:** [`rust/README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/rust/README.md) reports it as "34x faster to start, 4.3x faster per program" than the TS reference.
- **The release:** the package is at 0.2.x, and its changelog has three releases ([`CHANGELOG.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/CHANGELOG.md)).

### Language and values

- **The language:** modern strict-mode JavaScript, with `async`, generators, classes, destructuring and top-level `await` and `return` ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md#language)).
- **Removed for confinement:** `eval`, `Function`, `with`, sloppy mode, `Proxy`, `Reflect`, prototype mutation, private members and `Symbol()`.
- **Changed for model-written code:**
  - A default `sort()` over numbers is numeric.
  - `JSON.parse` of an object returns it unchanged.
  - `import x from "fs"` binds a host global.

  See [`CHANGELOG.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/CHANGELOG.md) and [`interpreter-support.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/interpreter-support.md).
- **Conformance:** it is measured against test262 at a pinned revision. 19,802 of 22,469 kept files pass and 2,667 are listed as known gaps ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md#test262)).
- **The result boundary is `JSON.stringify`,** plus a short table of exceptions:
  - A promise is awaited.
  - A Set becomes an array.
  - An Error becomes `{ name, message, … }`.

  Host arguments cross as copies, nested at most 32 deep ([`interpreter-support.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/interpreter-support.md), [`src/runtime/limits.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/runtime/limits.ts)).

### Host functions, concurrency and errors

These are all in [`src/host-function.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/host-function.ts) and the README's Host functions section.

- **`Host.fn(f, { type })`:**
  - `sync` blocks the program.
  - `async` hands the program a promise at once.
  - `idempotent: true` marks an `async` call safe to run twice, so a suspend may abort it and the resumed run calls it again "with the same key".
- **Call keys:** every call has a key `<runId>:<callId>` ([`src/host.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/host.ts), around line 66) and an `AbortSignal`.
- **`Host.durableFn({ start, wait, cancel })`:** `start` returns JSON that is kept in the snapshot. `wait(data)` gets the result, and is called again after a resume. `cancel(data)` runs if the run ends without the result.
- **`Host.namespace({ keys, resolve })`:** a lazy catalogue of host functions. Any path can be read, and `resolve` gives a function or a `Host.missing(message, suggestions)`.
- **`Host.fail(kind, message, suggestions)`:** reaches the program as a catchable error with the host's `kind`.
- **`suggestions` throughout:** the run's result carries them as `{ ok: false, error: { kind, message, suggestions? } }` ([`src/runtime/errors.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/runtime/errors.ts)). Unsupported syntax fails before the program runs, with a suggestion that describes the supported syntax ([`src/compiler/compile.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/compiler/compile.ts), lines 255 and 301). The suggestions come from the host or are fixed text. psychoscript computes no edit-distance matches.
- **Concurrency:** ordinary JavaScript promises over one microtask scheduler, with "unrestricted host-call concurrency" and at most 10,000 pending promises. There are no timers, no event loop that outlives the program's body, and no messages between programs.
- **`StreamingResponse`:** gives a program a `Response`-like object whose body streams.

### Limits and determinism

- **Limits** ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md#limits)):
  - `timeoutMs` is active wall-clock time, summed across resumes.
  - `maxOutputBytes` caps the result and the logs.
  - Fixed caps cover strings (2^24), arrays (10^7), pending promises (10^4) and BigInts (2^20 bits).
  - "There is no separate memory or step-count limit."
- **Fuel is not metering.** psychoscript's "fuel" is a countdown of 10,000 steps, with built-ins counting 50. When it runs out, the VM reads the clock and yields if 1 ms has passed ([`src/vm.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/vm.ts), lines 148–154 and 337–395).
- **Rust-only limits:** the Rust VM adds `max_heap_bytes`, a thread-CPU clock and an interpreter slice `slice_ms` ([`rust/README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/rust/README.md)).
- **Regular expressions:** "A single regular-expression match runs on the host engine and can't be interrupted" ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md#security-model)).
- **Determinism:** runs are deterministic except for `Math.random()`, `Date.now()`, `new Date()` and `crypto.*`, which read the host engine and "There is no option to seed them". A host has to shadow them with its own globals ([`README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/README.md#determinism)).

### Snapshots

- **The format:** a snapshot is JSON, at format 4. It has a header and a graph of records ([`src/snapshot/snapshot.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/snapshot/snapshot.ts)). The header holds:
  - a build id
  - a hash of the host's globals
  - the run id
  - the program sources with their text and bytecode hashes
  - the limits and the active milliseconds used
  - the host's `metadata` JSON
- **Code is never saved.** "restore recompiles every saved source eagerly and refuses one whose bytecode hash differs from the saved one, so a pc always means the same instruction" ([`src/snapshot.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/snapshot.ts), lines 17–24).
- **The build id** is the package version plus a hash of the format, the opcode table, the compiler version, and the prelude's and internal helpers' bytecode (`buildId`, the same file, line 138).
- **Values with no data form** are reported in `lost`, or fail with `strict` (`capture`, the same file, around line 156).
- **`suspend({ maxBytes })`** caps the snapshot's size.
- **Across implementations:** a snapshot resumes only in the implementation and build that wrote it. The TS and Rust formats differ ([`rust/README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/rust/README.md#parity)).

### Testing and tooling

- **The round trip mode** (`PSYCHOSCRIPT_ROUNDTRIP=1`) saves and restores the run every 2 Fuel ticks and at every host stop, up to 200 round trips per run ([`src/runtime/execute.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/src/runtime/execute.ts), lines 254–268; [`test/preload.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/test/preload.ts)).
- **Rust parity:** Rust is held to the TS reference by recordings that the reference generates and that nobody writes by hand ([`rust/conformance/`](https://github.com/anomalyco/psychoscript/tree/bf492e12017fb25621080676ddb8cd4fa60b7a9d/rust/conformance)). Its test262 skip lists must stay empty both ways. There is no Rust CI job.
- **Other tooling:** a bytecode disassembler script ([`script/disasm.ts`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/script/disasm.ts)) and a bench. There is no LSP, formatter, REPL or trace format in the repository.

## Feature by feature

| psychoscript | Northtalk | Verdict |
| --- | --- | --- |
| No ambient I/O. Only host globals reach outside. | The same, through Grants of Capabilities. They are declared up front, checked at load and in the Group Fingerprint ([chapter 9, Capabilities](../../spec/09-embedding.md#capabilities), [ADR 0012](../adr/0012-capabilities-are-called-through-tell-and-ask.md)). | Has it, stricter. |
| `sync` and `async` host functions | Immediate, Suspending and Fire-and-forget Operation modes (chapter 9). Concurrency inside a Run is a Join ([chapter 5, Joins](../../spec/05-handlers-messages-and-scheduling.md#joins), [ADR 0026](../adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md)). | Has it. |
| `call.key` (`<runId>:<id>`) and `call.signal` | A `Call` gives the call id, the Script's name, the Grant's binding, the Clock reading, the delivery id, and a context or signal cancelled when the call is abandoned (chapter 9; [ADR 0125](../adr/0125-a-host-functions-call-names-the-delivery-that-started-its-run.md)). | Has it. |
| `idempotent: true`, re-run on resume with the same key | The Host settles each pending call after a restore by `Answer`, `Fail`, **Reissue** under the same call id, or **Adopt** ([chapter 10, Settling pending calls](../../spec/10-save-and-restore.md#settling-pending-calls), [ADR 0038](../adr/0038-settling-a-restored-call-is-a-queued-host-input.md)). | Has it, and the Host chooses per call. |
| `Host.durableFn`: work runs across a suspend, `start` data kept in the snapshot | Save is allowed with suspending calls pending, and Adopt continues them. Live Capability Scopes, Segment participants and pending metered calls refuse a save as `effects pending` ([chapter 10, Saving](../../spec/10-save-and-restore.md#saving), [ADR 0049](../adr/0049-live-host-effects-prevent-saving.md)). The save keeps a pending call's id, Grant, Operation, arguments and deadline, but no Host data. | Mostly has it. [Idea 2](#2-host-data-kept-with-a-pending-call-park). |
| `Host.namespace`: a lazy catalogue resolved per path | Every Operation is declared in `DefineCapability`. The names are checked at load, and the declarations are part of the Group Fingerprint and of restore matching. | Rejected by design ([below](#rejected)). |
| `Host.fail(kind, message, suggestions)` | `Fail` with a code, a message and `Data`, whose entries become fields, against the Operation's declared codes ([chapter 6, Errors from Capabilities](../../spec/06-errors-and-limits.md#errors-from-capabilities)). A Host can already put `suggestions` in `Data`. | Has it. |
| `suggestions` on compile and run errors | Load diagnostics and Lints with LSP quick fixes ([chapter 12](../../spec/12-sessions-and-tooling.md)). No did-you-mean for an unknown name, Operation or message. | **Lacks it.** [Idea 1](#1-did-you-mean-in-the-lsp-adopt-tooling-only). |
| Suspend to bytes, resume in another process | Save and restore of a whole Group between Pumps. It is unobservable and works on either Core ([chapter 10](../../spec/10-save-and-restore.md#the-rule), [ADR 0008](../adr/0008-same-core-save-restore.md), [ADR 0144](../adr/0144-a-save-restores-on-either-core.md)). | Has it, stronger. |
| Code never saved, recompiled and checked by bytecode hash | "Code is never saved: a restore compiles each unit again from its source and checks its identity" ([chapter 10, The save format](../../spec/10-save-and-restore.md#the-save-format)). Sources can come from the Host ([ADR 0111](../adr/0111-snapshot-sources-may-come-from-the-host.md)). | Has it, the same design. |
| Build id and hosts hash refuse a foreign snapshot | Language, Cost Model and save-format versions, and the Group Fingerprint, in the header. Grants are matched by declaration. A mismatch goes to the Host's policy: reject, variables-only or Partial Restore ([chapter 10, Restoring](../../spec/10-save-and-restore.md#restoring)). | Has it, with recovery policies. |
| A header hash refuses a changed snapshot (Rust) | Body and section digests, and the State Fingerprint ([chapter 10](../../spec/10-save-and-restore.md#the-state-fingerprint), [ADR 0142](../adr/0142-saved-state-is-compared-by-state-fingerprint.md)). | Has it. |
| A snapshot is TS-only or Rust-only | One binary format that both Cores write byte-identically ([ADR 0144](../adr/0144-a-save-restores-on-either-core.md)). | Northtalk is ahead. |
| `run.metadata`, host JSON in the header | A Session Host saves its observation state beside the Group, not in it (chapter 10). | Rejected ([below](#rejected)). |
| `suspend({ maxBytes })` | Persistent State bounds what each Script keeps, measured at every Segment end ([chapter 6, Limits](../../spec/06-errors-and-limits.md#limits)). | Has an equivalent. |
| `lost` and `strict` for values that can't be saved | Every value is plain data, and Host Objects save by kind and id (chapter 10). | Not applicable. |
| `timeoutMs`, wall-clock time summed across resumes | Fuel per Run, the Allocation Budget, Persistent State, call depth, `MaxWait` and Fuel Slices, all deterministic and in the Cost Model ([chapter 6](../../spec/06-errors-and-limits.md#limits), [chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md), [ADR 0010](../adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)). | Rejected by design. |
| `max_heap_bytes` (Rust) | The Allocation Budget and Persistent State. | Has it. |
| A regex match can't be interrupted | Text Patterns are linear-time, sized by a limit and charged ([ADR 0007](../adr/0007-text-patterns-are-linear-time.md)). | Northtalk is ahead. |
| Randomness and `Date.now()` read the host | `random` draws from a seeded generator that the Group holds and saves ([chapter 7, Random numbers](../../spec/07-libraries-and-the-standard-library.md#random-numbers)). Time comes only from the Pump's Clock reading (chapter 9). | Northtalk is ahead. |
| Round trip mode: save and restore every 2 ticks and at every host stop | Every Trace Case is replayed with a save and restore between each pair of Pumps, and each save is restored on the other Core ([chapter 11, Save and restore replays](../../spec/11-the-trace-and-conformance.md#save-and-restore-replays), [Cross-Core replays](../../spec/11-the-trace-and-conformance.md#cross-core-replays)). The fuzzer draws Fuel Slices from 0, 1, 7 and 30 under that oracle ([`generator.ts`](../../tooling/fuzz/src/generator.ts), [fuzzer README](../../tooling/fuzz/README.md)). A slice of 1 ends a Script's turn after about one instruction, so saves land at almost every instruction. | Has it. |
| Rust held to TS by generated recordings | Twin Cores held to bit-for-bit parity by the Conformance Corpus, with cross-Core differential fuzzing in CI ([ADR 0009](../adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0018](../adr/0018-the-trace-is-the-corpus-case.md)). | Has it, gated in CI. |
| Borrowed typed arrays for sync host functions (Rust) | Bytes cross as converted values, and converting a result is charged ([chapter 9, Values at the boundary](../../spec/09-embedding.md#values-at-the-boundary), [ADR 0030](../adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)). | Lacks it. [Idea 3](#3-lend-bytes-to-immediate-operations-park). |
| `StreamingResponse` | `http` deliberately leaves out streaming bodies, both serving and fetching ([chapter 7](../../spec/07-libraries-and-the-standard-library.md)). | Rejected already. |
| Error `stack` with up to 10 frames, kept across a suspend | An error map carries `at`, and errors raised in stdlib code point at the Script's call ([ADR 0037](../adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md)). The Trace records the Run's path. | Rejected ([below](#rejected)). |
| Leniency for model-written JavaScript (numeric `sort`, `JSON.parse(object)`, `import "fs"`) | Northtalk is its own language with no implicit coercion ([ADR 0003](../adr/0003-no-implicit-coercion.md)). Beginner traps get Lints and quick fixes ([chapter 12](../../spec/12-sessions-and-tooling.md)). | Not applicable. |
| The Effect adapter | Hosts use the shared embedding interfaces ([chapter 9](../../spec/09-embedding.md)). | Not applicable. |
| test262 | The Conformance Corpus is Northtalk's own suite (chapter 11). | Not applicable. |

## Ideas, ranked

### 1. Did-you-mean in the LSP: adopt, tooling-only

- **What psychoscript does:** structured `suggestions` travel with every failure, from the compiler's unsupported-syntax hint to `Host.missing` for an unknown namespace path. The host fills them in, because its intended author, often a model, needs a next step and not only a refusal.
- **What Northtalk lacks:**
  - `unknown name` and `unknown operation` are load diagnostics ([chapter 2's diagnostic table](../../spec/02-grammar.md)), and the `unknown-message` and `unknown-property` Lints use the Host Manifest ([tooling README](../../tooling/stack/README.md#lints)).
  - A search of `tooling/stack/src`, `tooling/stack/README.md` and `impl/ts/src` finds no edit-distance or "did you mean" logic.
- **The change:** for these four diagnostics, the LSP offers up to three nearby names as quick fixes:
  - names in scope from the checker's binding tree
  - the Grant's declared Operations, or the Script's Grant names
  - the Manifest's message Selectors and properties
- **Constraints:**
  - It is tooling only, so nothing it produces is normative ([ADR 0028](../adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
  - The Core's diagnostics, the Trace's `diag` records and the Cores' parity don't change, so no Spec chapter, Core or Host is touched.
  - Keep the suggestions out of the Core diagnostic itself. Otherwise both Cores would have to agree on a distance function and a tie-break, and it would become part of parity for little gain.
- **Cost:** small, one PR in `tooling/stack`, with tests beside the existing quick-fix tests.
- **Recommendation:** adopt. It is the one place where psychoscript's focus on the author helps Northtalk's beginner profile.

### 2. Host data kept with a pending call: park

- **What psychoscript does:** `Host.durableFn` lets `start` return JSON that is saved with the run. After a resume, `wait(data)` gets the result from that data, and `cancel(data)` cleans up.
- **What Northtalk does:**
  - A save keeps each pending call's id, Grant, Operation, arguments and deadline.
  - A Host that wants to Adopt or Reissue after a restore must keep its own map from call id to external job, beside the save.
  - Call ids are counters inside one Group, so two branches restored from one save reuse them. A Host using them as idempotency keys for an outside service must qualify them itself. psychoscript's `<runId>:<id>` has the same limit.
- **The change, if taken:**
  - An optional opaque value, set by the Host at `Start`, saved in the pending-call record and returned in `Restore`'s pending list.
  - It would touch [chapter 10](../../spec/10-save-and-restore.md) and `save-format.toml`, both Cores' save and restore, the Go, Elixir and wasm Hosts' pending lists, and the State Fingerprint's coverage.
  - The data would have to be a Value under the existing Value Encoding, never native.
- **Cost:** medium, across five Spec surfaces and three Hosts.
- **Recommendation:** park. Adopt plus the saved arguments already let a Host find its job again, and no Host has asked. If a durable workflow Host appears, reopen it.
- **A cheaper part:** a sentence under [Host conventions](../../spec/09-embedding.md#host-conventions) about qualifying call ids, if anyone finds it useful.

### 3. Lend Bytes to Immediate Operations: park

- **What psychoscript does:** psychoscript's Rust VM lends a program's bytes to a synchronous host function for the length of the call, with no copy. It copies them for async functions ([`rust/README.md`](https://github.com/anomalyco/psychoscript/blob/bf492e12017fb25621080676ddb8cd4fa60b7a9d/rust/README.md)).
- **Why it would be safe in Northtalk:** Bytes are immutable values ([ADR 0001](../adr/0001-value-semantics.md)). A Zig or Go Host's `Do` could get a read-only borrowed slice, and nothing that Scripts or the Trace can see would change.
- **Constraints:** conversion charges must stay the same, since the Cost Model charges by logical size and not by copies. The embedding interface would need a borrowed accessor whose lifetime ends with `Do`.
- **Cost:** small to medium per Core.
- **Recommendation:** park until a profile shows Bytes copies at the boundary matter, for example in a Folio audio or sample-buffer Host.

### Rejected

- **Wall-clock `timeoutMs`, CPU clocks and time-based slicing.** Northtalk meters with deterministic Fuel, so that both Cores fault at the same instruction ([ADR 0009](../adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0010](../adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)). A Host that wants a wall-clock bound already controls when it Pumps and can stop or cancel a Run (chapter 9).
- **Lazy `Host.namespace` catalogues.** Operations must be declared before Load for load-time checking, `GrantsAsUsed`, the Group Fingerprint and restore matching (chapter 9, chapter 10). A path that resolves at run time would undo all four.
- **`run.metadata` inside the save.** A save holds only Group state, and Host state goes beside it, as Session observation state already does (chapter 10). Host bytes inside the save would need to be in or out of the State Fingerprint, and either answer is wrong for some Host. A Host can wrap the save bytes in its own envelope.
- **A `maxBytes` cap on the save.** Persistent State already bounds each Script, and the save of a Group is the sum.
- **Stack traces in error maps.** An error map is a plain Script value that counts toward allocation and Persistent State, and its fields are settled by the catalogue ([chapter 6](../../spec/06-errors-and-limits.md#the-error-code-catalogue)). A frame list would charge every raise and make Library code positions visible to Scripts. The Trace and the debugger already show the path.
- **`StreamingResponse`.** `http` leaves out streaming bodies on purpose ([chapter 7](../../spec/07-libraries-and-the-standard-library.md)).
- **Leniency for code that is plausible but wrong, such as numeric `sort` or `JSON.parse` of a parsed object.** These patch JavaScript's own traps. Northtalk avoids them in the language ([ADR 0003](../adr/0003-no-implicit-coercion.md)) and points out the rest with Lints.

## What couldn't be verified

- **Nothing was run.** psychoscript's behaviour is taken from its documentation and a reading of its source. This includes the round trip mode, the performance claims in `rust/bench/` and the test262 counts.
- **Two documents were not read in full:** psychoscript's `website/` directory and the 791-line `interpreter-support.md`. I searched them for host, snapshot, limit and suspend items.
- **"No did-you-mean in Northtalk" rests on a search.** I searched `tooling/stack/src`, `tooling/stack/README.md` and `impl/ts/src` for edit-distance and suggestion terms, and found nothing. An editor integration outside those paths could still have one.
- **The slice-1 claim is not a guarantee.** "Saves land at almost every instruction" assumes the fuzzer's slice of 1 preempts before each next instruction, as [chapter 5, Fuel Slices](../../spec/05-handlers-messages-and-scheduling.md#fuel-slices) says. I didn't measure how often generated cases draw it.
