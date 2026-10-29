# Go embedding

The Go embedding is module `github.com/odogono/odgn-talk/impl/go`, with public
root package `northtalk`. It runs the [embedded Zig Core](#zig-backend) through
wazero and provides immutable values, decimal arithmetic, pinned Unicode text
and the Group embedding interface, which loads Scripts, accepts Deliveries and
Requests, pumps Runs and emits canonical Trace records. The Session Host
provides Entries, Session Commands, a REPL and deterministic Transcript replay.
The Spec, Data Files and Conformance Corpus are the authority
([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

The native Go Core, a separate parser, checker, compiler and interpreter, was
removed in [#1055](https://github.com/odogono/odgn-talk/issues/1055)
([ADR 0117](../../docs/adr/0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md)).
Its implementation notes are in this guide's
[last native version](https://github.com/odogono/odgn-talk/blob/8df027ac174cc42a47d4ad14725bcaea768ddee7/impl/go/README.md).
The archived [comparison probe](../../spikes/go-zig-binding/README.md) and the
[binding investigation](../../docs/research/go-zig-binding.md) record the gates
measured before the switch. Language behaviour is the
[Zig guide](../zig/README.md)'s and the Spec's.

## Moving from the native Go Core

The native Go Core was removed in
[#1055](https://github.com/odogono/odgn-talk/issues/1055)
([ADR 0117](../../docs/adr/0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md)).
The public API is unchanged, and Hosts move by upgrading the module:

- **Builds:** there is no build tag; `talk_native_go` and
  `talk_zig_experimental` no longer exist. Builds need only Go, with
  `CGO_ENABLED=0` if you like; the reactor is embedded. Linux amd64/arm64 and
  macOS arm64 are the supported platforms.
- **Saves are disposable across the switch.** A native Go save (`SaveFormat`
  `go/…`) isn't in the shared save format
  ([ADR 0144](../../docs/adr/0144-a-save-restores-on-either-core.md)), so `Restore`
  refuses it with `invalid save`. There is
  no converter. Before upgrading, either let saved Groups finish on the old
  version, or plan to start them fresh from source and the Host's own data.
  The last commit with the native Core is
  [`8df027ac`](https://github.com/odogono/odgn-talk/tree/8df027ac174cc42a47d4ad14725bcaea768ddee7).
- **Versions:** `CoreVersions` reports the Zig Core, `zig/…`, and its save
  format, so a Host that stores the save format beside each save can tell old
  saves from new ones.
- **Behaviour:** the Corpus passes unchanged. A Library may call its importer's
  Handlers, and a transitive name cycle is accepted, as in TS and Zig
  ([#1037](https://github.com/odogono/odgn-talk/issues/1037)). Error message
  wording may differ; error codes don't.
- **Performance:** the API is slower than native Go was, with more memory per
  Group; the accepted scorecard is on
  [#1103](https://github.com/odogono/odgn-talk/issues/1103).
- **Tools:** run Go Corpus cases with
  `NORTHTALK_CORPUS=<case> go -C impl/go test ./internal/corpus -run TestSelectedCases`;
  `cmd/corpus`, `cmd/fuzzworker` and the fuzzer's `--go-runner` are gone.

## Zig backend

With Go 1.27, the root package API runs the embedded Zig Core by default, and
`CoreVersions` reports Zig's Core/save versions ([ADR 0117](../../docs/adr/0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md), [#1055](https://github.com/odogono/odgn-talk/issues/1055)).

Supported: immutable data Values and Value Encoding; Group/Script names and
lookup; Load and positioned diagnostics; direct Script Deliver/Request; Pump
Clock, Fuel slices/cap and typed lifecycle/accounting/CallFailed Reports;
Inspect/Counters and Grant inspection; Request context cancellation and OnReady;
queued Stop, CancelRun, RewindRun and Revoke. Ordinary `Group.Broadcast` selects
recipients at drain time in load order, including pending message waits and
prior Stop/cancellation. It preserves mailbox and limit rules; callback-generated
Broadcasts run at the next Pump. `Script.Decide` and `Group.DecideBroadcast`
return `Deciding` futures that settle from the Pump's typed `decided` Report,
when the Verdict seals rather than when the Run ends. Context cancellation
before the seal queues `cancel-delivery` by delivery or Broadcast id. The
future learns of the seal only from the Pump's reports, so a deadline that
passes after Zig sealed but before that Pump returns still queues a
cancellation and calls OnReady. Zig then drops it without a record and the
allowed Run carries on. Refused Deliveries, Requests and Decisions with
overrides that can't be represented go through the guest, so they keep their
refusal records. Local Script functions execute in Zig.

Host Objects keep their handles, natives and property callbacks in Go; the
guest sees `{"$object": [kind, id]}`. Every Object Kind the Core knows is
declared in the guest before each Pump and Load, so a Host callback can make
the first handle of a Kind defined earlier. `Group.Object`, `ObjectByID`,
`SetParent`, `Dispose` and `LoadOptions.Owner`/`Objects` work as natively, and
so do Deliver, Request and Decide addressed to an Object, along its Message
Path. Group ownership is checked in Go, in the native order and with the
native refusal records. A Load naming another Group's handle sends the guest a
placeholder it refuses with its own records. Object handles cross as message
arguments, results, Reports, Inspect variables and Capability arguments and
results, including Object Shapes. Decoded handles are the Host's own. Property
`Get`/`Set` run through the guest's `prop` need with the public handle, after
the guest pays the declared cost; failures and panics become the same Host
failures, with `call failed` detail kept in Go. The adapter negotiates
`climb-v1`, so a Request whose message climbs the Message Path settles at its
answer, not at the first Run's end.

Function Values cross with the negotiated `function-metadata-v1` feature as
the guest's `{"$function": [home, display, token, name, required, total, unit]}`.
In Go each is an ordinary `function` Value of its Group, whose identity is the
token: `HomeScript`, `String` and `Equal` behave natively, another Group's is
refused as `wrong group` before encoding, and the storage encoding still
refuses it. They travel in message arguments, results, Reports, Inspect
variables and Capability arguments and results, including Function Shapes.
The Session's passive inspection and descriptions read the declared name
(Nothing for Lambdas) and required/total parameter counts, including defaults,
stale Function Values and repeated Save/Restore. The Session archives Declaration
Documentation by defining-unit identity, using the read-only `script-units`
query after accepted code changes. Old functions keep their original docs
through redefinition, Library replacement and Restore; Lambdas have no docs.
`Group.Call` goes through the guest's `call` with the native admission checks
and records, its context cancelling the call, and the adapter negotiates
`function-gone-v1`, so a call found stale at the drain rejects with `send
failed`, reason `function gone`, as natively.

`Core.CompileLibrary` checks a Library in a guest the Core owns, not with the
Go compiler, and the returned Library keeps its source, imports and Grant
declarations with the guest's identity and `Needs()`. Each Group's guest
compiles a Library, after its imports, the first time `AddLibrary` or
`ReplaceLibrary` names it, and checks the identity matches. Diagnostics, the
add and replace refusals and Trace records are the guest's. `ReplaceLibrary`
returns the typed Reports and settles discarded futures; Grant release hooks
run with reason `reload` before the importers are reloaded. A Lambda in a
Library constant is still stale in its callers (#1036). A Library may call its
importer's Handlers, and a transitive name cycle is accepted (#1037).

`Script.Reload` and `Script.Extend` go through the guest's `reload` and
`extend`, which check, record and refuse them as natively, including `state
too large`, `name reused` and every diagnostic. A Reload returns the typed
Reports of the Runs it discarded, settles their futures, keeps the mailbox
when asked, runs Grant release hooks with reason `reload` and restarts a
stopped Script. Each accepted Reload releases its kept Grants even if the Script
was already stopped. Function Values made by the old code are stale afterwards.

`Group.Save`, `Core.Restore`, `Group.Settle` and `Group.Fingerprint` use the
guest's `save`, `restore`/`resolve`, `settle` and `fingerprint` exchanges.
Saves are the Zig Core's opaque bytes, in the format
`CoreVersions().SaveFormat` names; native Go saves cannot be read. Restore compiles the supplied Libraries in its fresh
guest, rebinds Grants and native Objects through the public callbacks, and
returns typed accounting Reports and pending Calls. Answer, Fail, Reissue and
Adopt retain their queued semantics; adopted Calls own fresh Go contexts.
Object and Function Values in arguments, pending Calls and Script state belong
to the restored Group. Set `RestoreOptions.Name` for the new Group's name;
the Zig save does not retain the old Host name.
The replay bridge retains current Library handles after registration and
successful replacement, including recompiled dependants. A restore offered
replacement identities therefore rejects a mismatch or carries only Script
Variables, according to the Host's policy; refused replacements retain the old
handles.

`restore-bindings-v1` lets resolution register new Grants before its answer,
and returns the Script, Object and Call metadata the adapter needs. Private
Capability handles select callbacks; public Capability names participate in
Fingerprints and declaration matching, independently of registration order.
Save passes through live-effect refusals, with a transport fixture covering
`effects pending`; public scoped/Segment attachments remain the separate
slice. Saves retain each pending Call's Segment id,
including preempted open Joins and suspended waits. Adopted Calls keep their
original Clock across later Pumps; reissued Start reads the new Pump Clock.
Earlier Zig save layouts are refused with `invalid save`, even under
VariablesOnly; drain old Groups on their old runtime or start fresh Groups.
The adapter gate exercises language and Cost Model mismatches through each
Core's own version header, including VariablesOnly accounting, rollback and
stale Function metadata. Go JSON-layout mutation tests run natively; the
adapter checks binary integrity, malformed state and prior-format refusal.
Reissue Fuel faults inside Joins remain [#1068](https://github.com/odogono/odgn-talk/issues/1068).
Unsettled restored Calls have exact native-Go/embedded-Zig Trace and typed
error Data parity, with either rebound or absent Grants.
Save-record input-generating Trace sinks remain part of [#1051](https://github.com/odogono/odgn-talk/issues/1051).

Ordinary immediate, suspending and fire-and-forget Capability Operations attach through the public
Grant API. Declarations retain argument/result Shapes, allowed Operations,
declared costs, MaxPending and optional error catalogues. Call identity,
accessors and Host binding data stay in Go. Start can Answer/Fail synchronously
or from a later goroutine; AnswerWithCost charges on resumption. Callback panics
and Host errors become ordinary Host failures. Abandonment cancels Call.Context
before the next callback, including cancellation cleanup and Calls answered but
discarded before resumption. Late settlements are harmless. Each worker owns its
whole need/result exchange; callbacks, Trace sinks and OnReady run outside
adapter admission and registry locks. Inline sink callbacks submit through the
queue while the original export retains guest ownership. Callback-generated queued inputs receive distinct refs;
worker reentry returns the existing reentrant-call HostError.

`WithReleaseHook` runs during Stop and Revoke with the public GrantContext,
including binding, Clock and reason. Hooks run in Grant-name order, after Call
context cancellation, outside transport locks. Panics cannot refuse release.
Hook-generated inputs and OnReady obey the same worker boundary; repeated Stop
or Revoke does not repeat its release. GrantsAsUsed trims unused hooks.

Scope declarations and Segment-bound Operations run through the guest's lifecycle
needs. Calls retain their Scope name, automatic flag, Run and Segment identity,
and the Go binding. Automatic abandonment uses a fresh context and rejects
budget and settlement calls. Coordinator pointers map to guest names per Group:
aliases of a coordinated Grant share enrollment, while plain Segment Grants
receive separate coordinators. Hooks see every enrolled binding in order.
Commit/rollback outcomes, disabled Grants, provisional Script Variables and
typed `EffectFailure` Reports follow the guest's lifecycle; Host-only details
stay in Go. Cancellation abandons participating scopes before rollback and
unrelated scopes after Script cleanup. Reload validates before abandonment.

Calendar, Locale, Store, sqlite and user factory argument checks run in the
guest before charging; result and failure refinements run at return or
asynchronous resumption. The
adapter forwards the original arguments to Go's factory wrappers, which retain
default resolution, SQL parameter/result conversion and per-step charging.
Locale default tags and sqlite row caps are copied to guest bindings; Host
implementation and coordinator identity stay in Go. Ordinary declarations with
the same public name do not acquire factory checks or catalogue failures.

The adapter negotiates `paused-inputs-v1`, `abandoned-before-needs-v1`,
`crossing-trace-v1`, `climb-v1`, `function-gone-v1`, `function-metadata-v1`, `core-message-v1`,
`standard-refinements-v1`, `inline-inputs-v1` and
`restore-bindings-v1`.
The [inline transport](../../spec/embedding/inline-inputs.md) streams every
complete Trace record before its producer advances. A sink can queue inputs
from execution, error, lifecycle and inspection records; controls retain native
crossing/Stretch boundaries, and ordinary inputs wait for the next Pump.
Concurrent calls enter one Go-side admission queue while an export runs. The
guest services it at checkpoints and export boundaries on its original stack,
without reentering WASM. Admission replies validate and reserve in the guest;
OnReady and sink callbacks run outside adapter locks. Atomic guest work can delay
an admission acknowledgement until its next checkpoint or export boundary.
Without a Trace sink, a Pump has no checkpoint after its drain: a Stop,
CancelRun or Rewind arriving then is admitted at the export boundary and lands in
the next Pump, where native Go would land it in this one (#1267).
The public Host matrix compares exact Trace, Fuel, typed Reports, futures and
inspection with a separately compiled native-Go binary; a Trace-disabled long
export exercises concurrent Delivery, Stop, CancelRun and Answer. The native
reference's refused input from `pumped` is excluded pending #1072.

Unsupported Capability attachments return an `embedded Zig Core: … is not supported` error.
Two Object Kinds sharing a
name in one Group's guest, and a Kind first defined inside a Host callback, are
refused. A Group that has done nothing but exist moves to another guest rather
than meet a Kind of the same name.
Shapes nested beyond 32 levels are also refused. These three declaration limits
are deliberate limits, retained by the maintainer's decision on
[#1050](https://github.com/odogono/odgn-talk/issues/1050).
Pool, Store and sqlite are Go Host facilities and run through the
adapter, including the unchanged tenants example and the Store and sqlite test
kits. The Session Host, REPL and every Session Transcript run on the adapter
([#1053](https://github.com/odogono/odgn-talk/issues/1053)); CI runs them on
Linux amd64/arm64 and macOS arm64 and cross-builds each target without cgo.
Group initialization forwards `GroupOptions.Seed` across its full `uint64`
range, with 0 as the default; Save/Restore preserves the generator's current
state. The shared public Go regression checks default and explicit seeds,
integer-encoding boundaries and restored continuation
([#1285](https://github.com/odogono/odgn-talk/issues/1285)).
Full Corpus acceptance remains separate work.
Large inspection Trace records, replies and Save/Restore inputs use negotiated
[`chunked-wasi-v1`](../../spec/embedding/chunked-wasi.md): each transfer is at
most 64 MiB, and each logical message is at most 2 GiB minus one byte. Both
endpoints still assemble complete messages, so memory use exceeds the chunk
size. The selected acceptance gate includes the unchanged
`limits/persistent-state-minimum` case through hidden Save/Restore replay
([#1286](https://github.com/odogono/odgn-talk/issues/1286)). The
[memory measurements](../../docs/research/go-zig-binding.md#large-state-transport-acceptance-1286)
record the cost of whole-message assembly.

Store uses `valueops.ErrorValue`, `valueops.Size` and the `internal/value`
Encode/Decode/DecodeMembers/JSONString/KindNames helpers. The sqlite module's
`internal/sqlitekit` test helper uses `corpus`, `hostkit` and `value`. These
helpers compute from Spec data rather than executing a Core, so they need no
public API. See the [dependency inventory and decision](https://github.com/odogono/odgn-talk/issues/1052#issuecomment-6227978930).
sqlite per-step charging remains [#911](https://github.com/odogono/odgn-talk/issues/911).

The internal `zigwasm` package verifies the embedded artifact digest. The adapter
checks language, Cost Model and Unicode versions before use. Compiled code is
cached process-wide. A Core's Groups share a pool of guests, one per
`GOMAXPROCS`, each made when a new Group first needs it and given out
round-robin. A guest is one Message Layer Session, holding the Core's
Capability definitions, Object Kinds and compiled Libraries once. The adapter
negotiates `group-exchanges-v1`, so each Group on a guest has its own exchange
and holds the guest for one frame at a time, even while it waits on a Host
callback ([the contract](../../spec/embedding/group-exchanges.md)). A new Group
skips a guest holding an Object Kind the Core has since redefined. A restored
Group has a guest of its own. A new Group initially reserves only a handle.
With `load-fields-v1`, its first Load sends raw UTF-8 source and the Group's
name, Trace flag and seed in one binary frame; another first Group operation
creates guest state with `new-group`. An unused Group needs no `drop-group`.
Guests without the feature retain JSON Load. With `queue-fields-v1`, Deliver, Broadcast and
Decide cross in binary frames too; guests without it receive JSON. Each process
compiles the artifact before its first Group, unless `NORTHTALK_ZIG_CACHE_DIR`
names a directory, where wazero keeps compiled code for later processes,
keyed by its version and the artifact. `BenchmarkBackendColdStart` measures
both, as `cache=none` and `cache=warm`. Go's garbage collector cleans up
after a Group, without per-Value Release: it sends `drop-group` for a shared
guest's Group, and closes a guest once neither its pool nor any Group holds it. Replies
are copied before another export, and returned Values own Go memory. Data
conversion uses the existing iterative codec rather than encoding/json's
nesting limit. Ordinary consumers need Go and pinned module dependencies,
without Zig or a WASM runtime download. The maintainer command
`python3 impl/go/build-artifact.py` rebuilds the embedded copy from
committed Core/spec sources and records its provenance.
The Go Session Host and REPL use the embedded
Core's negotiated `analysis-v1` exchanges for Entry classification and
continuation, positioned syntax diagnostics, implicit Script Variables,
declaration descriptions and documentation, Fix/Continue, Built-in and Standard
Library catalogues, the inspection reader and computed message names. A single
serialized analysis guest shares the adapter's compiled engine and works before
a Group starts; analysis exchanges load nothing and produce no Trace. Value
formatting and pinned Unicode name matching stay with the Host. `session`,
`driver` and `cmd/northtalk` import no Go parser, checker, compiler or
generated catalogue packages. Cancelling an unfinished
inspection expression prevents its property reader from starting.

Every Session test and Session Transcript passes, including the `describe`,
`named-functions`, `object-inspection` and `observation` Transcripts unchanged, including defining documentation, disposed
Object inspection after Restore and Core-raised error messages left out of the
Trace. The Session’s private pending-input hook uses the
negotiated `queued-inputs-v1` query, so callback Deliveries receive one extra
Pump per Host call, Store Notifications drain at the same Clock reading, and
restored settlements are pumped before the next Entry. The query observes the
guest queue without execution or Trace. Decomposed source keeps the source
text as written in the Trace
([#1053](https://github.com/odogono/odgn-talk/issues/1053)).
`adapter-check.sh` runs `./session`, `./driver` and every
`TestSessionTranscriptParity` case.

Sharing guests is what keeps a tenant cheap. On an Apple M5 with 10 guests
per Core, NewGroup plus one Script load takes about 29 µs, against 94 µs and
2.4 MB allocated with a guest per Group and native Go's 4 µs and 6 KB, and a
held Group retains about 88 KB of heap, against 2.4 MB and native Go's 63 KB
([#1103](https://github.com/odogono/odgn-talk/issues/1103)). The performance
limits are tracked in #1103. To repeat the committed benchmark:

```sh
CGO_ENABLED=0 go -C impl/go test -run '^$' -bench GroupInstantiation -benchtime 200x -count 3 .
```

Run the focused public slices from the repository root:

```sh
CGO_ENABLED=0 impl/go/adapter-check.sh
impl/go/adapter-check.sh -race
go -C impl/go vet . ./internal/zigwasm
```

`TestZigBackendCapabilityParity` diffs the Zig adapter's `TestCapabilityBridge`
observations against the native Go Core's, recorded in
[`testdata/native-bridge-observations.json.gz`](testdata/native-bridge-observations.json.gz)
before it was removed. To write the Zig side's observations:

```sh
TALK_BRIDGE_OBSERVATIONS=/tmp/zig.json go -C impl/go test -run '^TestCapabilityBridge$' .
go -C impl/go test -run '^TestZigBackendCapabilityParity$' .
```

The shared Hosts include scoped completion/error/Stop/cancellation/Reload,
automatic cleanup failures, coordinator conflicts and shared enrollment,
definite/unknown effect outcomes, and Standard precharge/result/failure checks.
The unchanged Scope, Segment, coordinator and factory tests join the tagged
selection. `TestCoordinatorMappingHoldsAcrossReloadAndRestore` still needs
Save/Restore; `TestEffectUncertaintyStopsEveryScriptAndCannotReload` reads native
private Script state, so public Host scenarios cover fatal outcomes instead.

The shared public Hosts include callback-generated Broadcasts, cancellation
cleanup order and rollback, refused out-of-range Pump Clocks, and malformed
immediate, Start and later Fail data. Pump results, typed Reports, Fuel, futures,
Trace and inspected state compare exactly; only error wording and Host detail
wording are excluded, and failure detail must remain nonempty. The native tests
install Trace at Group construction and cancel through public Run controls.
Stop also lands when a Host Charge fails, retaining accepted Fuel and its
original reason while discarding the Run without a limit-fault report. Shared
Hosts cover immediate, suspending and fire-and-forget callbacks, Stop from the
Operation or its Trace record, and subsequent Requests to the stopped Script.

An internally generated error Run retains its `during` message map through local
`error` calls, helper calls, later clauses and captured Lambdas, including across
Fuel slicing. Host-delivered `error` messages bind Nothing. Shared public Hosts
compare both cases against native Go with exact Trace, Fuel, typed Reports,
futures and inspected state. Function-call errors retain the original Function
Value in `{fn, args}` metadata, including its captures. Save/Restore retains this
metadata in the failed Run, queued error and locally called error Handler.

Extend rejects local calls into inherited Handlers containing `veto`, including
command, function-style and Lambda calls across earlier extension code units
([#1060](https://github.com/odogono/odgn-talk/issues/1060)). Diagnostics retain each
veto's defining position. The shared public Host compares refusals, unchanged
state and code identity, pending Run resumption and subsequent Host Decisions
against native Go with exact Trace, Fuel, typed Reports, futures and Inspection.

Cancelling a parked queued Run executes its dispatch-local `finally` blocks
without releasing the clause held by the active Run. Shared public Hosts cover
`CancelRun` and Request context cancellation, including cleanup preemption,
with exact Trace, Fuel, typed Reports, futures and inspected-state comparison
to native Go ([#1063](https://github.com/odogono/odgn-talk/issues/1063)).

Send checks its complete Fuel and allocation charge before delivery, call-id
allocation or reply-wait registration. The selection includes the native Send
budget regressions and a shared public Host covering refused and paid Sends,
with and without waiting, against a separately compiled native Go binary.

Known execution differences remain outside the selection:
allocation fault positions and Join accounting ([#1061](https://github.com/odogono/odgn-talk/issues/1061)).

Valid `wait d` and timed message waits suspend and pay their charge even when
their mathematical deadline lies outside the Clock's years 0001–9999. Such a
wait has no inspectable `Until`; an unreachable future deadline has no
`NextDeadline`, while one before the Clock range requests another Pump at the
current reading. Earlier Timeout Blocks still win. Deadlines retain their
exact ordering through save/restore, and Requests remain cancellable
([#1064](https://github.com/odogono/odgn-talk/issues/1064),
[#1260](https://github.com/odogono/odgn-talk/issues/1260)).

Explicit Call answers/failures refuse foreign handles at admission on both Cores,
including nested containers. The shared public Host checks that refusal leaves
the Call pending and accepts a subsequent valid settlement. Native private-function
and save-layout tests cannot run unchanged through a public adapter; snapshot
round trips await Save/Restore, and Go heap-allocation ratios are not a guest
memory measurement.

The same selection, including Pool, Store, storekit, sqlite and tenants,
executes in CI on Linux amd64/arm64 and macOS arm64, with separate pure-Go native
Host and adapter cross-builds. The adapter cross-builds also compile those
facility tests and the tenants executable for every target. It includes unchanged
public-interface Go tests and dedicated adapter tests, rather than asserting the whole native suite
passes under this tag. Full API/Corpus, facility, concurrency and measured
performance acceptance remain in [#884](https://github.com/odogono/odgn-talk/issues/884).

### Hand swap

[`build-artifact.py`](build-artifact.py) refuses uncommitted Core/spec changes. To try an
uncommitted Zig change, swap the embedded copy by hand with
[`hand-swap.sh`](hand-swap.sh). It builds the Zig Core, copies `talk.wasm` and
writes its digest into `artifact.json`, which must match, or `NewEngine` refuses the artifact:

```sh
impl/go/hand-swap.sh
```

Never commit these hand-built files. Restore them with
`git checkout -- impl/go/internal/zigwasm`, then, once the Zig change is
committed, run `python3 impl/go/build-artifact.py` and commit its output. If a test panics
mid-suite, compile once and run tests singly:
`go -C impl/go test -c -o /tmp/adapter.test .`, then
`(cd impl/go && /tmp/adapter.test -test.run '^TestName$')`.

## Task navigation

**Recovery Offers:** this Core parses, checks, lowers and executes offers and two-phase catch search. Ordinary catches test before cleanup; recovery policy can choose a retained local/Library/same-Run action. `offerAvailable`, canonical metadata, costs and choice/entry Trace records are implemented. Nested policy searches stay within their selection boundary; escaping policy Errors carry `during` outward, transfer cleanup preserves or cancels choices as appropriate, and cancellation enumerates dispatch-local and retained scopes once. Dispatch saves retain control stacks, shared owner locals, pending transfers, cleanup progress and attempt numbers. Restore validates every retained code/body/PC, ownership chain, target and cleanup reference before resuming; search and lookup preempt only at the following instruction boundary. [Save/restore evidence](../../docs/reviews/recovery-offers-saves/README.md) covers ordinary catches, nested policy, transfer cleanup, action entry and cancellation. Session Scripts can choose Library offers and replay their Transcripts. The shared TS debugger follows active dispatch control and display retained frames with shared owner locals; Go reproduces their execution Traces through its replay backend. See the [tooling/session evidence](../../docs/reviews/recovery-offers-tooling/README.md) and [language rules](../../spec/04-expressions-and-statements.md#recovery-offers).

Use the [Go task map](NAVIGATION.md) for implementation files, Spec links, tests and root-relative check commands.

## Layout

- The root package implements the available declarations of the
  [embedding interface](../../spec/embedding/talk.go). `value.go`, `encoding.go`
  and `text.go` own immutable values and codecs. `core.go` owns the Core and
  default limits, and `group.go` owns Host inputs. The `zig_*.go` files are the
  adapter to the embedded guest, which [`internal/zigwasm/`](internal/zigwasm/)
  runs under wazero.
- `internal/generated/` holds tables from Spec Data Files and pinned Unicode
  sources, with `UNICODE-LICENSE.txt` beside them.
- `internal/unicode/` supplies NFC, Character boundaries, simple folding, full
  default case mappings and White_Space-based words. Spans use zero-based UTF-8
  byte offsets; Script source positions count scalars from line and column 1.
- `internal/decimal/` supplies exact-input decimals, arithmetic, integral
  rounding and elementary functions. Outward-rounded intervals increase
  precision until both bounds select the same 34-digit half-even result.
  Numbers cache their coefficient as an `int64` when it fits, alongside the
  canonical text; copies remain immutable and restore rebuilds the cache.
  Exact addition, subtraction, multiplication and same-exponent comparison
  use the cached coefficients, preserving the decimal quantum and falling
  back to `math/big` for larger coefficients, overflow or rounding. Display,
  Value Encoding and the save format are unchanged.
- `internal/value/` owns values, Units, comparison, display and strict JSON.
  Containers copy input slices; public accessors return copies.
- `internal/syntax/` keeps only the lexer the Host needs for Selector and
  label validation; the Zig Core parses Scripts. Text Pattern sizes come from
  the `internal/value` pattern reader's tree.
- `internal/valueops/` builds Core error maps, measures a Value's logical size
  and applies `Add` for the Store and Notification Hosts.
- `internal/trace/` orders records and keys by `corpus.toml`. It removes the
  Core's non-parity error wording from Trace values, including nested errors,
  while preserving Script and Host data named `message`.
- `session/` owns Entries, implicit Script Variables, atomic redefinitions,
  foreground/background Runs and Session Commands. It consumes Trace records
  to present output; inspection occurs only for explicit inspection commands.
- `driver/` owns Transcript parsing, recording/replay and terminal interaction;
  `cmd/northtalk/` connects it to filesystem I/O, stdin and Ctrl-C, and runs Script files. Its
  [Pool](#driver-pool) pumps many Groups on a set of workers.
- `examples/tenants/` is the [multi-tenant Example Host](examples/tenants/README.md),
  an HTTP server with a Group per tenant, and the recorder of its Trace Cases.
- `internal/corpus/` reads setups and runs encoding, Trace and Session
  Transcript cases through the public API, with first-divergence output and
  the passing gate. `TestSelectedCases` runs the cases `NORTHTALK_CORPUS` names.
- The [Message Layer](#message-layer), both the native sidecar and WASI
  reactor, is supplied by the Zig Core.
- `internal/apicheck/` compares root exports and signatures with `talk.go`,
  including promoted members. Missing declarations are reported without failing
  until [#141](https://github.com/odogono/odgn-talk/issues/141).

The module has no third-party requirements and no `go.work`. `sqlite/` is a
separate module, `github.com/odogono/odgn-talk/impl/go/sqlite`, so that only
Hosts that offer `sqlite` depend on its driver. Its Core,
`session/`, `driver/` and `cmd/northtalk/` boundaries follow
[ADR 0046](../../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md).

## Build and test

Use Go 1.27 and Bun 1.4.2. From the repository root:

```sh
bun install --frozen-lockfile
bun run unicode:check
go -C impl/go build ./...
go -C impl/go vet ./...
go -C impl/go test -v ./...
go -C impl/go test -race ./...    # skips the exhaustive single-goroutine replays
go -C impl/go/sqlite test ./...  # the sqlite Host, a separate module
gofmt -l impl/go               # must print no paths
```

Unicode tests verify source hashes in `.cache/unicode/18.0.0/`, all five columns
of `NormalizationTest.txt`, scalars absent from its first column, every
`GraphemeBreakTest.txt` row and C/S folding against `CaseFolding.txt`. Missing or
corrupt sources fail. The import-policy test refuses platform Unicode tables,
`strings` case functions and `golang.org/x/text`.

Regenerate from the repository root:

```sh
bun run go:generate
bun run unicode:generate
bun run syntax:generate
bun run check
```

Emitters read Spec Data Files, normative Standard Library source and pinned UCD sources, import no TS Core code and
use `gofmt`. Their `--check` modes refuse missing or stale output without writing.

## REPL and Session Transcripts

**Implemented commands:** [Session observation](../../spec/session-observation.md) adds `:describe`, `:inspect`, `:apropos`, `:trace`/`:untrace`, `:fuel`, marked declaration docs and object-crossing Transcript envelopes. This Core implements the public Run accounting reports, `RestoreResult.reports`, Declaration Documentation ([#436](https://github.com/odogono/odgn-talk/issues/436)), `:describe` and `:apropos` ([#437](https://github.com/odogono/odgn-talk/issues/437)), and `:trace`, `:untrace` and `:fuel` ([#438](https://github.com/odogono/odgn-talk/issues/438)). It also implements `:inspect` and object-crossing envelopes ([#439](https://github.com/odogono/odgn-talk/issues/439)); coordinated release review remains in #370.



- **Value inspection and object Transcripts:** `:inspect` accepts one expression, including a multiline expression, and evaluates it once. Syntax and checking diagnostics use the expression’s own source positions; statements, declarations and trailing input give `! bad arguments`. Passive rows show the held value, sizes, sorted map fields, Function metadata/docs or the actual Object Kind's properties. An object then runs the generated normative reader as a separate ordinary request with the current limits; getters run once in code-point order and print one-level results or parity-safe errors. Generated readers stay out of Session Source/export. New recordings include initial `% setup` and portable Function exposures; recordings without `%` still replay with their original empty-object setup.
- **Object adapters:** supply `Objects(context)` in `session.Environment`; use `Objects.DefineKind` and `.Object` for initial and dynamically returned identities. `.Request(map[string]any)` builds and executes a normalized external worker request, recursively encoding held Values; `.Action(Envelope)` accepts raw Value Encoding, with `.Encode` for Function references. The adapter records actual callback boundaries, ordered actions, errors and synchronous refusals. Supply `ResolveObject` for live Restore. Standalone replay creates dummy native identities and consumes these records through normal Core Shape checks and costs; it does not invoke the original getter or external I/O. Function references preserve actual exposed Values and nested map insertion order, and become invalid after successful Restore. Corpus replay uses the same envelopes in both Trace modes. [The proposed first expectations](../../docs/reviews/object-inspection/README.md) still await human first-blessing review.

Independent Go Trace replay preserves the exact source scalars in `reload`, `extend` and `replace-library`, including decomposed text, so Code identities match the original recording. Standalone Transcript input preserves those bytes too; runtime Text Values still use the pinned NFC/grapheme rules. The [approved source-transport expectations](../../docs/reviews/trace-source/README.md) cover all three inputs and Session inspection through Save/Restore.

- **Declaration Documentation:** `--|` blocks attach to the next top-level declaration as the specification says. A leading block keeps an Entry `NeedsMore`, and the Host refuses a block that documents nothing with `! bad arguments`. The source a declaration was entered with keeps its block, through redefinition, export and reload. `Documentation(name)`, `LibraryDocumentation(library, name)` and `FunctionDocumentation(value)` return the documentation. Each Handler Clause has its own entry. An Import resolves to the declaration that defines it, and a Built-in uses its `stdlib.toml` description. A Function Value's documentation comes from the code that defined it, so a stale one keeps its documentation, including across save and restore.
- **Tracing and Fuel:** the Session Host reads only the public Run accounting reports for these commands. `:trace` filters latch a dispatched Run by its message Selector when it starts; a Command Call shares its caller's Run and is not traced separately, and a Function Value's Run has no Selector to match. `trace start` and `trace end` rows follow a Host call's ordinary output, and Fuel rows follow them. `:fuel <entry>` measures the Entry's root Delivery and every Run and message spawned from it, summing each member Run's latest cumulative Fuel. It stays pending until the root's causal work reports no live Runs and no queued messages. `NeedsMore` waits for a multiline `:fuel` Entry. `:save` keeps filters, latched Runs and measurements; `:restore` prints `fuel abandoned` for each measurement still pending, then continues from the saved ones. The `sessions/observation` case pins the output on both Cores.
- **`:describe` and `:apropos`:** both read declaration source and the Built-in catalogue, so they execute nothing. Describing a current Script Variable takes one explicit `vars` snapshot for its value rows; no other lookup reads the Group. A signature ends at the declaration's grammar head: a function's or Handler's head line, or a Constant's or Script Variable's name. A stale Function Value keeps its original name, arity and documentation through save and restore, even after its executable code is discarded. Describing an Object variable renders its actual Kind metadata without calling getters.


From `impl/go/`, run the Go REPL or record/replay a Transcript:

```sh
go run ./cmd/northtalk
go run ./cmd/northtalk -transcript session.transcript -trace case.trace
go run ./cmd/northtalk -replay ../../corpus/sessions/save-restore/session.transcript
NORTHTALK_CORPUS=sessions/save-restore go test ./internal/corpus -run TestSelectedCases
```

Enter one declaration, statement or expression. Incomplete Entries continue at
`|`, including open fences and interpolation holes. Blank literal lines remain
content; final EOF diagnoses the innermost unfinished construct at its opener.
An Entry beginning with a Handler Selector's first word is a Command Call;
positional and labelled Handlers sharing that word remain distinct.
Expressions print their value. `say` calls `console.write`. Foreground
Runs wait for their console input or real-clock deadline; other suspended Runs
produce background lines when later resumed. Ctrl-C cancels the foreground Run
or drops an unfinished Entry. Ctrl-D and `:quit` exit; `:help` lists Commands.
Prompts, line editing and Ctrl-C presentation are outside Transcript parity.

The Host supports `:grant`, `:mock` (with a `read-only` metered suspending mock), `:stub`, `:answer`, `:fail`, `:charge`, `:clock`,
`:limits`, `:cancel`, `:fix`, `:runs`, `:mailbox`, `:vars`, `:save`, `:restore`,
`:library`, `:export` and `:store`, as specified in
[chapter 12](../../spec/12-sessions-and-tooling.md). Configure Grants and mock
Operations before the first Entry. `:clock virtual 2026-09-30T10:00:00Z` makes
later Pumps deterministic; `:clock advance 1 s` resumes due Runs. Saves retain
Host stubs, limits and virtual-clock state along with the Group and adopt its
pending calls on restore. Declaration and Library replacements are atomic;
failed replacements keep the previous code and variables.

`session.New(Environment{...})` embeds the Host without terminal or filesystem
access. `Now` supplies real-clock readings; `Record` receives Transcript Items;
`Trace` receives canonical Group records; `ReadFile` and `WriteFile` support
Library loading and export; `ReadStoreFile` and `WriteStoreFile` support Store
imports and exports. Call the Host from one goroutine. The supplied built-ins
are console, clock and store; other Capabilities can be mocked. The Host
currently offers no external suspending built-in, so replay refuses `~` answer
records. The CLI loads `:library add NAME PATH` and exports ordinary Library and
starter Script files with `:export DIR`.

`driver.RunREPL` serializes Host calls and accepts an optional interrupt channel.
The caller owns its input reader and must close it to release a blocked read
when cancelling. `driver.ParseTranscript`, `WriteTranscript` and
`ReplayTranscript` use the normative UTF-8/LF format. Replay supplies recorded
real-clock readings and console answers, uses scratch export I/O, and returns
actual recorded output; the CLI fails if it differs from the original file.
Help and quit are terminal actions and are not recorded.

### Running a Script file

`northtalk [-port n] app.talk [args...]` runs the file as one Script, named
for the file, as [chapter 12's Script Runner](../../spec/12-sessions-and-tooling.md#the-script-runner)
and the TS Runner do. A first argument after the flags that ends in `.talk` or
names an existing file is run; arguments after it, flags included, go to
`start` as a list of texts. `-port` (or `--port`), else `PORT`, overrides every
`serve`'s port. Grants, used as needed: `console`, `clock`, `timer`, an
in-memory `store` named `default`, `http` (any address) and, when stdin is a
terminal, `user` with the REPL's prompts, plus `calendar` bound to `UTC`,
`locale` bound to `und` and `sqlite` on a database `main` in a temporary
directory, opened at first use and removed at exit, giving at most 10,000 rows a
call. `calendar` reads Go's time zone database, embedded with `time/tzdata`.
`locale` takes Collation and case mapping from `golang.org/x/text` and names
and number symbols from [a table](cmd/northtalk/locale_data.go) pinned from
Node's ICU by `node impl/go/cmd/northtalk/gen-locale-data.ts`; it supports `und`
and the tags listed there, and any other tag falls back by lookup, so a tag the
TS Runner resolves through Intl, such as `de-CH`, may resolve to `de` here.
`und` has en-US names and symbols, as the TS Runner has on an en-US runtime.
The main module requires `sqlite/` through a `replace`; it stays cgo-free. It exits 0 when no
Run, queued message, timer, Serve Registration or open Exchange is left, 1
after any uncaught error or a load diagnostic (`file:line:col: message`), and
on SIGINT or SIGTERM Delivers `stop`, stops accepting, waits up to 5 s for open
Exchanges and exits 130 or 143; a second signal exits at once.

## Libraries and Standard Library

`Core.CompileLibrary` checks stateless source with explicit imports and Operation
Declarations. `Library.Imports` and `Needs` return copies; needs include direct,
private, unused and transitive Operation references. Code identity includes source
and dependency identities; the Host version label does not affect it.
`Group.AddLibrary` requires matching dependencies first and atomically refuses
missing or mismatched imports, reused names and reserved stdlib names. Private
names and imported names are never re-exported. Imports are linked by name,
including renames, without copying bodies into callers.

## Values and codecs

`Dec` reads number syntax without rounding. `FromFloat` uses shortest round-trip
digits. Decimal printing retains trailing zeros; integer accessors refuse
fractions and overflow, and `Float64Lossy` rounds nearest, ties to even.
Constructors reject invalid input with `HostError{Code: InvalidValue}`.
`InstantFromTime` drops zone and monotonic readings and panics with that Host
error outside years 0001–9999; `Instant` returns the refusal instead.

`Value.String` uses chapter 11's display form. `EncodeValue` preserves supported
kinds and numeric exponents. `DecodeValue` accepts only the canonical numbers,
tags and payloads the encoder writes, refusing other forms as `invalid value`.
This includes the choice between a JSON integer below 2⁵³ in magnitude and
`$dec`, normal-form Units, UTC Instants with the shortest fraction, Civil Dates,
Text Pattern source, padded Base64 and `$map` only for maps with a `$` key.
JSON white space and string escapes are syntax, and text is normalised to NFC.
Malformed UTF-8, lone surrogates and duplicate NFC keys are refused. Text
Patterns are re-parsed and Object tags resolved through the Host's resolver.
The same decoding rules apply to Message Layer inputs, Session object actions
and Store file members; outer Store keys remain literal. Plain JSON refuses non-JSON
kinds with `not encodable`, including `kind` and the first depth-first `path`.
Function Values have Home identity, capture equality and accessors, and are
refused by storage encoding. Group-scoped Host Objects can be registered and
resolved by the Host. Group-owned parent relationships route messages to the
nearest live Owning Script.

Quantity comparison retains sequentially rounded Base Unit magnitudes beyond
the number limit. Some huge Unit exponents remain impractical when interval
bounds and stable-coefficient shortcuts cannot decide the comparison.

## Save, restore and code updates

`Group.Save` returns the Zig Core's save bytes for a Quiescent Group, in the
save format every Core shares
([ADR 0144](../../docs/adr/0144-a-save-restores-on-either-core.md)), and
`CoreVersions().SaveFormat` names their format. `Core.Restore`
refuses native Go saves and corrupt or unreadable bytes with `invalid save`
(see [Moving from the native Go Core](#moving-from-the-native-go-core)). Live
scopes or participants refuse Save with `effects pending`. Restore checks the
saved Group Fingerprint and rebuilds Host handles for Scripts, Objects and
pending Calls; [chapter 10](../../spec/10-save-and-restore.md) defines the
mismatch policies, Reload, Extend and Library replacement.

## Group embedding

**Object element references:** `element s of receiver`, ordinal references
and `the number of elements of receiver` read an `ObjectKindDef`'s optional
`Elements` collection, as [the contract](../../spec/embedding/object-elements.md)
says, with `get-element`, `count-elements` and `prop` crossings in the Trace.
The machine pays the base rate and checks the selector and receiver kinds;
`group_elements.go` checks disposal and collection support, then makes the one
callback and checks its result. Session Transcripts record callbacks as
property crossings on `elements`. The Zig adapter declares a collection only
to a guest offering `object-elements-v1`, and answers its `prop` needs with an
`op`; the Zig reactor does not offer it yet. Go has no `ExportManifest`, so
there is no Manifest declaration here.

`New`, `NewGroup`, `Load`, Script/Group `Deliver`, `Request` and `Decide`, `Broadcast`, `DecideBroadcast`, `Pump`,
`Call`, `Inspect`, `Counters`, `Stop`, `CancelRun`, `RewindRun`, `Reload`, `Extend`,
`ReplaceLibrary`, `Save`, `Restore`, `Settle`, `Fingerprint` and `TraceSink` implement their handoff
signatures. Core compilation caches are mutex-protected and Groups have separate
live state. Load supports Scripts with named Capability Grants and an optional
Owning Object. Owners and well-known Objects are checked for Group ownership and
retained through Reload. Each live Object has at most one Owning Script. Other
unimplemented public declarations are omitted.

Load shares one compact parse between code identity, checking and lowering.
It preserves source and Declaration Documentation without retaining a token
for every blank line. Parsed nodes cache their first source position, and
lowering indexes constants, so long operator chains with repeated or distinct
literals don't repeatedly scan earlier work. Run
`go -C impl/go test . -run '^$' -bench BenchmarkLoadHostileSource -benchmem`
to measure blank lines, empty Handlers and operator chains at increasing sizes.

Any-goroutine deliveries reserve mailbox capacity before joining the input
queue. A Pump takes one Clock reading, drains accepted inputs in order, and
visits Scripts in load order, one Run per turn. Fuel Slice overrun becomes debt
on the next Pump; Fuel Cap limits the Group. Request cancellation joins the same
queue, and Pending results settle after Pump records. Worker reentry, backwards
Clock readings, invalid values and Function Values from other Groups are refused.
Clock readings outside the language's year 1–9999 range are refused with
`invalid value` before the Clock changes or queued inputs are drained. Refused
Pumps are traced at the call, ahead of those still-queued inputs.

`Script.Reload` checks and initializes new code against kept, unrevoked Grants
before discarding old work. A rejected Reload leaves calls and revocation state
intact. Successful Reload abandons scopes and pending calls without Script finally cleanup,
drops queued messages, settles Requests/reply senders as stopped, carries variables
by name when requested, and preserves counters. Carry uses the active Segment's
rollback base for preempted Runs; Function Values from the old code become stale.
A successful Reload restarts Script-addressed execution; a disposed owner
remains skipped by Object routing. Library replacement applies the same Reload
rules to every Script that imports a changed dependency, including extensions.

`Script.Stop` is queued and sticky. It discards running, parked and suspended
Runs without `finally`, rolls back an active Segment, and drops mailbox messages.
Waiting callers fail with `send failed`, reason `stopped`; open Decisions become
undecided with outcome `cancelled`. Stop reports list discarded Runs, dropped
Deliveries and abandoned calls. Pending Capability contexts are cancelled,
and open Capability Scopes receive automatic abandonment.
Owner disposal uses the same termination path with reason `owner disposed`.

Repeated Stops preserve the first reason and emit no additional Stop report
unless later accepted messages need dropping. Those messages still obey mailbox
admission limits. Broadcasts omit stopped Scripts. A Group whose Scripts are all
stopped pumps as `stopped`; Reload clears an ordinary Stop
state and reason. Fatal effect uncertainty stops the Group permanently.

Stops issued during Pump land at its next Host crossing or end, like `CancelRun`.
A crossing records its Host result, then the control input, before result
conversion. A refused Host Input made during a crossing also writes its input
and `refused` records there, in order with urgent controls; its API refusal remains
immediate. Independent Trace replay issues these inputs inside the recorded
property or Capability function, in ordinary and save/restore modes.
An interrupted current Run ends its Stretch as `stop` before the
Stop report, without a RunEnd or cleanup. Cancelling a crossing also skips
conversion of the discarded result; cleanup crossings retain their own charges.

### Driver Pool

`driver.Pool` pumps many Groups on a fixed set of worker goroutines, with a run
queue and one deadline timer per Group, as chapter 9's helpers describe. It is
built on the public interface alone and is outside parity. `Pool.NewGroup`
makes a Group whose `OnReady` queues it, so it is queued once however many
inputs arrive. A Group is pumped by one worker at a time, with the Pool's
`PumpOptions` and a reading of its `Clock`. A `Sliced` or `Rewound` Pump, or an
input queued during the Pump, sends the Group to the back of the queue, so a
Fuel Slice shares the workers between tenants. A Pump's `NextDeadline` arms the
Group's timer; any other Pump of that Group replaces it.

Make worker calls (`Load`, `Reload`, `Inspect`, `Counters`, `Save` and the rest)
through `Member.Do`, which holds the Group as a Pump does. `OnPump` receives each
result on its worker while the Group is still held, so it may Reload after a
`Rewound` Pump. `Pool.Wait` returns once no Group is queued or being pumped;
Groups waiting only on a deadline count as settled. `RealClock` reads the wall
clock. `ManualClock` moves only on `Advance`, which fires due timers earliest
first; the Pool reads the Clock when it pumps, so a Host that needs each
deadline's own reading advances to it and waits. `Member.Remove` and
`Pool.Close` stop timers and leave queued Groups unpumped; nothing is saved.

### Function Value calls

A local Function Value call stays in the caller's Run. A foreign `f(x) and wait`
pays the ordinary call charge, enters the Home Script's FIFO mailbox, and starts
a concurrent Run without Handler Clause dispatch. It runs with the Home Script's
Grants and limits; captures and named defaults bind in its own code unit, including
imported functions. The caller's `MaxWait` bounds the reply. A plain foreign call
raises `would suspend`, a stale value raises `function gone`, and a full Home
mailbox raises `mailbox full` naming the Home Script. Failed admission creates
no call id or receiver Run.

Replies resume the caller in a new Segment without another call charge.
Receiver errors and limits become `send failed`; caller timeout or cancellation
abandons the reply while the Home Run continues. Inspection shows
`call-value-wait` with its pending id, and Function Runs and queued calls use the
Function Value's display label. Mailbox accounting retains the Function Value
and its captures, as well as arguments.

`Group.Call` admits a Host Function Value call like a Request, with Group and
argument validation and optional tighter Run limits. Staleness is checked when
inputs drain; a stale call fails `send failed`, reason `function gone`, without
a Run or Fuel. A live call's arity mismatch is an error at the body's first
instruction, before any execution charge or unwind. It cannot enter catch or
finally cleanup. Defaults and captures use the same binding as Script calls.
Context cancellation uses ordinary Delivery cancellation. A Host Function call
cancelled before dispatch has no Run id and spends no Fuel or allocation; its
Trace `run` record retains the Function Value's `fn` label.

The reviewed `functions/foreign-calls` and full `functions/host-calls` cases pass
unchanged, including Stop and stale Host calls. Full snapshots retain Function
metadata, captures, pending calls and internal sender/receiver pairs. Host Function
Values obtained from the original Group remain tied to that Group.

The Corpus runner reuses the latest Function handle received with a given
Display Form in Capability arguments, property writes, Run results and errors,
unhandled-message reports and inspection values, including nested Lists and
Maps. Host calls, message arguments, Capability Stub results and errors, and pending-call answers and
failures share that binding. Unknown Function handles are refused; declared
Objects reuse their registered handles. The reviewed
`functions/capability-callbacks` case passes unchanged and is required in the
Go passing gate.

### Ordinary Capability Operations

Operation Declarations accept `Description` (text) and `Examples` (a list of source texts). The Message Layer validates both fields on `define-capability`, including refusing null. Documentation stays out of saves and Group Fingerprints, so rewording it does not cause a restore mismatch. Go does not yet export a Host Manifest.

**Metering support:** an `Operation` may set `Metering` to `"read-only"` or `"segment-bound"`, validated at definition and passed to the embedded Zig Core, which implements the [incremental metering contract](../../spec/embedding/metered-operations.md). A suspending `"read-only"` Call may `RequestCharge(fuel)` from any goroutine; its `ChargeRequest`'s `Done` closes when the Pump that processes it reports a `*ChargeResult`. The corpus runner replays `charge-request` inputs and `charge-refused` Stubs. The SQLite factory charges `perStep` per driver step, below.

`Core.DefineCapability` copies Operation declarations and validates their modes,
Shapes, costs and Host functions. `Grant` selects Operations, and `GrantAll`
selects the whole definition with an opaque Host binding. Load copies each named
Grant, so aliases and Scripts have independent revocation state. Shapes include
scalar kinds, exact Units and Unit kinds, Lists, Maps, unions and Optional values.
`AnyShape` accepts data and refuses nested Function Values; `ValueShape` accepts
all Values. A trailing suffix of Optional arguments may be omitted, and the Host
receives only supplied arguments, preserving explicit Nothing.

Immediate `ask` and fire-and-forget `tell`/`say` execute inside the pumping Run.
Argument checks and revoked Grants fail before charging or calling the Host.
The base 10 Fuel, declared Fuel and allocation, and pending dispatch charge are
paid atomically before the Host crossing. `Call.Charge` draws additional Fuel
while the Host function runs; a refused charge faults the Run even if the Host
swallows `ErrLimit`. Immediate results are checked and their conversion charged
before being stored in `it`; fire-and-forget calls leave `it` unchanged. An
accepted Host effect remains committed when later conversion or Script code faults.

A valid custom `ScriptError` raises its code, message and Data with Operation
identity. Data must be a Map or Nothing; other kinds become `host error`.
Foreign Group values in returned failures also become `host error`; explicit
`Call.Fail` refuses them at admission. Catalogue codes, reserved Data keys,
undeclared codes, invalid results, plain errors and panics also become `host error`, with Host-only
detail in `CallFailed`. Returned failures and queued `Call.Fail` inputs retain
Error maps in the Trace even when Data collides with the error envelope. Valid
Nothing/map failures retain their ordinary conversion costs and budget checks.
If Stop or a newly landed cancellation interrupts the Run at an Operation
crossing, the Host failure raises no `host error` and emits no `CallFailed`;
the `call` error record is still written. Operation failures during cancellation's
`finally` cleanup still raise and report normally.
Calls carry the named Grant, binding, Pump Clock, Run and Segment identity.
Caught raises precede subsequent Host call records. Host inputs accepted during
a call join the next Pump; worker reentry is refused.

`Script.Grants` returns fresh, sorted Operation lists. `GrantsAsUsed` trims direct
uses across the whole Script, including unused function bodies. `Script.Revoke`
queues revocation in Host-input order; retained aliases remain independent.
Library needs participate in load/Reload validation and Grant trimming, including
private and transitive calls. Library Operations use the caller's binding and
ordinary Host crossing; compiled code retains only call metadata and declarations.

Suspending `ask … and wait` invokes `Start` once after the same atomic precharge.
`Call.Answer`, `AnswerWithCost` and `Fail` may run on any goroutine, append Host
inputs and call `OnReady`; answers queued during `Start` wait for the next Pump.
An answer or failure carrying another Group's Function Value or Object, including
inside Lists or Maps, panics with `WrongGroup` before queuing or calling `OnReady`.
The Call remains pending and can still accept a valid settlement. Immediate
results and failures returned from `Do` or `Start` retain their `host error`
validation at the Host crossing. The waiting Run retains a 48-byte pending call,
then its answer or failure Data when ready. Validation, result/Data conversion and any late Fuel are charged on
its resuming turn, under the Run budgets, Script slice and Pump cap. Conversion
faults roll back that Segment while preserving earlier committed effects.
Duplicate and abandoned settlements are recorded and ignored.

`MaxPending`, or the effective Run `MaxWait` when it is zero, bounds each call
from suspension using the Pump Clock. Timeout raises `timeout` with `after` and
Operation identity. Timeout, cancellation, Reload and Join abandonment cancel
pending Call Contexts; revocation leaves in-flight calls alone and blocks later
starts. Inspection reports `ask-wait` and pending ids. No turn callback is retained
in machine state.
Ordinary calls have no scope and are not automatic. Immediate and
fire-and-forget calls carry a background Context. Segment-bound Operations use
`DefineSegmentCapability` or `DefineCoordinatedCapability` with synchronous
lifecycle hooks, described below.

### Grant release hooks

`DefineCapability`, `DefineSegmentCapability` and `DefineCoordinatedCapability`
accept Operation declarations and `WithReleaseHook(func(GrantContext))` as
`CapabilityOption` values. A caller expanding a slice uses `[]CapabilityOption`
rather than `[]Operation`. `GrantContext` identifies the Group instance, Script,
named Grant, binding, last Clock reading and `ReleaseReason`: `ReleaseStop`,
`ReleaseReload`, `ReleaseRevoke` or `ReleaseDisable`.

This follows the
[Grant release contract](../../spec/09-embedding.md#the-grant-release-hook)
([#618](https://github.com/odogono/odgn-talk/issues/618)). Stop, owner disposal
and fatal effect uncertainty release all kept Grants with hooks in code-point
name order after abandonment and rollback, before the Stop report. Successful
Reload and Library replacement release those Grants with `reload`, including
revoked and disabled ones. Rejected updates, Extend, Save and Restore release
nothing. Revocation releases once when drained; failed automatic abandonment
releases immediately after its `effect failure` report.

Library replacement completes abandonment and rollback for every affected
Script before releasing any Grants with `reload`. If a rollback leaves effect
state unknown, the Group stops and releases its Scripts with `stop`, keeping
the previous code.

Hooks are synchronous and unmetered, with no Trace record or Fingerprint field.
They may queue Host Inputs; worker calls are `reentrant call`, and panics cannot
refuse release. `grant_release_test.go` verifies lifecycle ordering and identity.
The TS Core supports the same embedding hook; it has no Message Layer adapter,
so its transport tests are deferred. The `store` factory forwards its implementation's release hook; see the router below.

### The notification router

Package [`notify`](notify/) supplies `notify.New(RouterOptions{Limits, Revision})`,
the [notification router](../../spec/09-embedding.md#the-notification-router)
([#619](https://github.com/odogono/odgn-talk/issues/619)). `Watch`, `Unwatch`
and `Release` register and remove watches by owner (Group, Script, named Grant)
and name. `Commit(store, apply)` applies a commit under the Store's mutex and
routes its changed keys as ordinary `Script.Deliver` Deliveries; an error from
`apply` routes nothing. What `MailboxFull` refuses is held within the Store's
four limits, falling back to one Reconciliation Marker on overload, and
`Pumped(g)` retries fairly after each Pump. `Detach` drops a Group. `Save`
writes a checkpoint with the save's SHA-256 and each watched Store's revision,
and `Restore` refuses anything else as `invalid checkpoint` before calling
`Core.Restore`. `Changed(before, after)` is the net-change test, by Value
Encoding bytes.

The router reads Script load order with `(*Group).ScriptNames`, safe inside a
Pump and untraced, and checks restored Grants with `(*Grant).Capability` and
`(*Grant).Binding`. A Group's `OnReady` callback must not call back into the
router synchronously. `notify/kit_test.go` runs the
[router kit](../../corpus/notify-kit/) on stand-in Groups, and
`notify/router_test.go` drives real Groups, including concurrent Pumps and
commits under `-race`. `store.Stores` routes Segment commits and Host
`Replace`/`Clear` through its public `Router`. Hosts call `Router.Pumped`
after Pumps, `Detach` on discard and `Save`/`Restore` for companion
checkpoints. `store.NewWithWatchLimits` overrides the Session watch limits.
The Session Store accepts watching with costs 4/2 and limits 100 watches,
65,536 watch bytes, 1,000 pending Notifications and 1,048,576 pending bytes.
`RouterOptions.Admitted` is told after each Notification a Group admits, with
the router locked, and `store.NewNotifying` passes it on. The Session Host
uses it to pump again at the same Clock reading while Notifications are
queued, retries with `Pumped` after every Pump, keeps checkpoints for
`:save`/`:restore` and detaches a Group it replaces. A Host call that leaves
other Host Inputs queued gets one more Pump of its own; see
`session/pumping_test.go` and the `sessions/store-notif*` Transcripts.

### Segment-bound Operations

A Segment's participant is a Segment Coordinator, a `*SegmentLifecycle` with
synchronous `Begin`, `Commit` and `Rollback` hooks ([ADR 0069](../../docs/adr/0069-segment-bound-grants-share-a-participant-through-a-segment-coordinator.md)).
`DefineCoordinatedCapability` maps each binding to its coordinator once, when
the Grant is created; Load, Reload and Restore keep that pointer, and Grants
with the same pointer share a participant. `DefineSegmentCapability` takes one
`SegmentLifecycle` and gives each named Grant, aliases included, a coordinator
of its own. Segment-bound Operations must be immediate, and all lifecycle
Operations for a scope agree on their Segment-bound status. Hooks receive the
Group instance, Script, Run and Segment ids, last observed Clock, the first
enrolled Grant's name and binding, and every enrolled Grant in `Grants`. They spend no Script resources; reentrant
worker calls are refused. Hook results are `EffectOK`, `EffectFailed` or
`EffectUnknown`; a panic or malformed result is unknown, with Host detail kept
out of the Trace.

The first paid Segment-bound call enrolls its named Grant and calls `Begin`
before entering the Operation. A later call through another Grant on the same
coordinator enrolls it with no hook, while a Grant on another coordinator raises
`segment participant conflict`, naming the first enrolled Grant, before charging
or entering the Host. Preemption,
caught errors and empty Joins retain the participant. Completion and ordinary
errors commit after all boundary checks and scope abandonment; actual suspension
commits before its report or Verdict. Limit Faults, Stop, disposal and successful
Reload roll back. Cancellation first abandons every enrolled Grant's scopes
and rolls back, then runs finally cleanup in a new Segment with its own participant.

Failed abandonment on any enrolled Grant prevents commit and disables only that
Grant; an unrelated abandonment failure only disables its Grant. Definite non-commit restores the Segment's
Script Variables and ends `effect failed`, failing waiting senders without a
Limit Fault, Script catch/finally or an error Handler. Uncertain begin or commit,
and any unsuccessful rollback, stop every Script as `effect state unknown`.
Rollback is attempted once, and Load and Reload cannot revive this Group.
Successful commit finalizes before observing controls queued by its hook.

The runner passes all 30 effect cases unchanged, including Save refusal at live
participant boundaries and the four `effect-coordinator-*` cases for
ADR 0069 (first blessings approved on 2026-10-08), fatal Reload and Library replacement. A refused Save
performs no cleanup, drains no inputs and changes no execution state or counters.
Native tests also pin atomic replacement when a later Script's rollback fails.
The maintainer approved the first blessings of the original 22 effect cases on
2026-10-05; the
[step-4 approval record](../../docs/reviews/go-step-four-blessings/README.md)
records that review. The four remaining cases execute unchanged in the step-5 gate.
The runner gives Grants sharing a `case.toml` `coordinator` name one coordinator,
and each other Grant its own.

### Capability Scopes

Immediate Operations may declare `Scope` as `Opens` plus `Abandon`, or `Closes`.
Definition validates names, matching close targets, argument/result Shapes and
consistent abandonment targets. Grants containing an opener must include its
abandonment Operation; `GrantsAsUsed` keeps that dependency. Definitions copy
the metadata so later Host mutations do not change it.

Each Run owns separate slots by named Grant and scope name, including aliases
sharing a binding. Successful Host return acknowledges acquisition or closure
before result validation, conversion or queued interruption. Duplicate opens
and absent closes raise scope errors without calling the Host. Open scopes
prevent executed suspension boundaries and Join entry; local calls that never
suspend remain valid. Opening inside a Join is refused. These checks precede
instruction charges, while dispatch and ordinary unwind charges still apply.
Preemption retains the slots.

Completion, error, faults, cancellation, Stop, disposal and successful Reload
automatically abandon remaining scopes in reverse opening order before exposing
the outcome. Cancellation cleanup may still use scopes on ordinary Grants until
it ends. Automatic Calls use the saved implementation/binding even after
revocation, with `Automatic`, `ScopeName`, ownership ids, the last Pump Clock and
a fresh non-cancelled Context. They consume no Script Fuel or allocation and
cannot use `Charge`, `Answer` or `Fail`. Reentrant worker calls are refused.

Failed automatic abandonment reports `EffectFailure`, disables only that
Script's named Grant and continues remaining cleanup. Later calls raise
`capability disabled` before revocation checks. `Inspect` lists disabled Grant
names in sorted order; disabled state survives Reload and has no reset API.
Explicit close failures leave the scope open and usable.

All seventeen scope traces pass, including `scope-slots` and
`scope-suspension-boundaries` with corrected guard Fuel and allocation
expectations. Both Cores agree on the complete Traces; the
[charging reconciliation](../../docs/reviews/scope-guard-charging/README.md)
records the boundary audit. Their first blessings were approved for #141; see the
[approval record](../../docs/reviews/milestone-one-blessings/README.md). Disabled Grants survive full and variables-only restore;
Save refuses a preempted Run with live scope slots without abandoning them.

### Clock and Timer Standard Capabilities

`Core.ClockCapability(Costs)` supplies the fixed immediate `now` Operation. It
returns the Pump's Clock reading as an Instant, truncated to whole microseconds, through
an ordinary named Grant. It never reads the Host's wall clock.

`Core.TimerCapability(TimerImpl, Costs)` supplies the fixed fire-and-forget
`schedule` and `cancel` Operations. The Host receives the caller's Call, name,
Instant, message text and data-only argument list. The Host stores timers by
Script and name, replaces repeated names, and delivers due messages with
`Script.Deliver`; the Core does not schedule durable timers itself. Arguments
are checked before costs or Host calls. Neither factory declares Script errors,
so Host failures become `host error`.

Each Operation requires its own `Costs` entry. Fuel and allocation must be whole
nonnegative safe integers; Go's zero-valued allocation means zero. Extra names
are ignored and costs are copied, so later map changes cannot affect calls.
Timer requires a non-nil implementation; an interface holding a nil pointer is
refused too.
Both factories use ordinary Grant trimming, Library needs and atomic charging.

### Console Standard Capability

`Core.ConsoleCapability(ConsoleImpl, Costs)` supplies fixed fire-and-forget
`write` and suspending `read` Operations. `write` forwards its Value to the Host,
including Function Values nested in Containers, and leaves `it` unchanged.
`say` calls `console.write` through the caller's Grant, including in Libraries.
Function Value display uses a Lambda's source unit and line/column, including
`<function session+N:L:C>` for a Session extension, with its captures when present.
Library Lambdas retain the Home Script and Library name. Internal enclosing
Handler names are not displayed.
Named Script functions display as `<function session:double>` even when an
extension defines them; imports retain their defining Library and declaration
name. The defining code unit remains part of equality and call identity, so a
redefinition can produce unequal Function Values with the same display.

The Host starts `read` with a Call and answers it with text without the line
break, including an empty line. Its fixed 2,147,483,647 ms timeout overrides
Script MaxWait. Answers queued during Read resume only in a later Pump;
timeout and cancellation abandon the Call and cancel its Context. Late answers
are traced and ignored. Both Operations retain the Script name and Grant
binding, require copied valid costs and a non-nil implementation, and declare
no Script error codes. Invalid read results and Host failures become `host error`.

### Store Standard Capability

`Core.StoreCapability(StoreImpl, Costs)` supplies immediate `get`, `set`,
`delete`, `keys`, `increment`, `swap`, `watch` and `unwatch`. The Grant binding
names the Store. The interface requires all eight methods, three Segment
hooks and `Release`, and the factory requires all eight costs. `watch` and
`unwatch` give Nothing, never enroll a participant, and are final at the call.
`watch` passes the effective message to the implementation: `storeChanged`
when omitted or Nothing, while the Trace preserves supplied arguments.
After Shapes, empty watch names and non-plain messages raise uncharged
`invalid watch` with `field` set to `name` or `message`, in that order.
Only `watch` declares `watch limit`, with `limit` `watches`, `size` or `pending`.
The factory forwards `Release` for owner cleanup.
The implementation is one Segment Coordinator for every binding, the same
pointer for every `StoreCapability` over one comparable implementation, so
writes to several Stores, or to one Store through several Grants, enroll in one
participant and use its `Begin`, `Commit` and `Rollback` hooks (ADR 0069). Shape checks precede empty-key checks;
`invalid key` is uncharged and never calls the Host. Results must meet each
Operation's Shape. Only declared Store catalogue failures with valid fields
pass through; malformed failures become `host error`.

`Add(a, b)` uses the machine's `+` rules without charging a Run, including
Quantity conversion and date arithmetic. It returns the same `*ScriptError`
and catalogue fields as Script addition. `increment` accepts number and
Quantity amounts at Load and at the Host crossing.

[`store.New(store.Quotas{...})`](store/) supplies named in-memory Stores,
starting empty. It keeps each live Segment's writes to every Store it writes,
in call order, applies a commit to all of them atomically, reserves keys against incompatible writes, and admits
concurrent increments without losing counts. Ownership includes Group identity
and Segment id. Quotas count logical key/value sizes and every Segment's
nonnegative net growth, so another Segment's rollback cannot free capacity
prematurely. This implementation provides no durable backend.

The Session Host builds in this Store with chapter 12's quotas: total size
1,048,576, 1,000 keys and largest value 65,536. `:grant scores store [name]`
binds `default` when no name is supplied. `:mock` refuses `store`. `get` and
`keys` cost 2 Fuel; writes cost 4, with no declared allocation. `:store` shows
committed entries in Unicode code-point order; `load`, `save` and `clear`
import, export and empty a named Store. Imports validate all contents before
replacement and record file contents inline in Transcripts. Store contents
outlive reload and remain outside saves and restores.

Run every language-neutral Store kit sequence with:

```sh
go -C impl/go run ./cmd/storekit
```

The same kit runs in `go -C impl/go test ./internal/storekit`, alongside native
cross-Group reservation, concurrent increment and Session Transcript tests.

### Calendar Standard Capability

`Core.CalendarCapability(CalendarImpl, Costs)` supplies the six fixed immediate
Operations: `today`, `now`, `toCivil`, `toInstant`, `offset` and `zone`. The Host
supplies timezone data and DST gap/overlap rules. Calls retain the caller's Grant
binding and Pump Clock, including through Library frames. Omitted or Nothing
zones are passed as `""` so the Host can use its binding's default; the Trace
retains the supplied argument list.

`toInstant` requires a date-time. With two arguments, the second text is a
recognized disambiguation or a zone; with three, the second is a disambiguation
and the third a zone. Omitted or Nothing disambiguation defaults to `compatible`.
Domain checks follow Shape checks and precede charges and the Host crossing.
Results are checked before conversion: `today` is date-only, `now` and `toCivil`
include time, `toInstant` is an Instant, `offset` has exact Unit `s`, and `zone`
is text. Invalid results become `host error`.

Each Operation declares `unknown zone` with text `zone`; `toInstant` also declares
`ambiguous time` with Civil Date `civil` and text `zone`. These catalogue failures
are accepted only with valid fields and no reserved Data keys. Other Host
failures become `host error`. The factory requires all six copied costs and a
non-nil implementation. Factory checks are private to the definition; ordinary
Capabilities cannot opt into Calendar errors by name or declaration.

### Locale Standard Capability

`Core.LocaleCapability(LocaleImpl, Costs)` supplies eight fixed immediate
Operations: `compare`, `rank`, `upper`, `lower`, `numberSymbols`, `monthNames`,
`dayNames` and `tag`. The Host supplies Collation, case mappings, Locale data and
supported-tag lookup/fallback. The Grant binding supplies a default tag string;
calls retain the caller's binding and Pump Clock through Library frames.

Optional options and tag arguments are distinguished by kind. Omitted or Nothing
options receive a complete map in documented key order: `sensitivity: "variant"`
and `numeric: false`, or `width: "long"` and `form: "format"`. An omitted or
Nothing tag reaches the Host as `""`. The Trace retains supplied arguments.
Shape checks precede option-domain checks in supplied map order, then effective
tag validation, all before charges and Host execution. An explicit tag overrides
a malformed default. The Core checks case-insensitive ASCII RFC 5646 syntax,
including private-use and grandfathered tags, without registry checks, trimming
or canonicalisation. Malformed tags raise `bad locale`; invalid option words or
text in both optional positions raise `out of domain`.

Result checks require `compare` to be exactly -1, 0 or 1, `rank` to contain exactly
the distinct supplied texts with dense positive integer ranks, name lists to
contain 12 or 7 texts, and `numberSymbols` to be a closed map with nonempty
separators/signs, ten nonempty digit texts and positive integer grouping fields.
`tag` must return well-formed tag text; case results are text with Core-owned NFC.
Invalid results and every Host failure become `host error`. All eight costs are
required and copied; the implementation must be non-nil.

### sqlite Standard Capability

For Script examples, transaction behavior and the implementation overview, see
[Using SQLite](../../docs/sqlite.md).

`Core.SqliteCapability(SqliteImpl, Costs, perStep)` supplies the optional
`sqlite` Operations (ADR 0070): immediate `query sql, params [, max]` and
Segment-bound `change`, plus `begin`, `commit` and `rollback`, which open and
close the `transaction` scope. Each binding must be a `SqliteBinding`; the
factory maps it to `impl.Coordinator(database)` when the Grant is created, so
every Grant on one database shares a participant. A binding of another type, or
with `MaxRows` outside 0 to 2^53−1, is refused there. After the Shape checks,
uncharged argument checks give `out of range` for a `max` that isn't a whole
number up to `MaxRows`, and `wrong kind` for `params` that isn't a list or map
or holds a value outside nothing, number, text, bytes and boolean. `query` is
`Metering: "read-only"` and `change` `"segment-bound"`. The call passes the Host
a `beforeStep` that charges `perStep`, which `Query` and `Change` call once
immediately before every SQLite step, the completion check and the probe past
`max` included, returning its error without stepping. It calls the Host with
converted params: a whole number that fits int64 binds as INTEGER, any other as
REAL, and a boolean as 1 or 0.

The Core converts the result. A broken form, such as a short row, more rows than
`max` or a negative `Changes`, is `host error`. A column named twice after NFC
raises `sql`; a NaN, infinity, double of 10^34 or more, or invalid UTF-8 text
raises `unrepresentable` with its `column`. Both are the call's error, with no
message. A Go value that isn't a SqlValue is `host error`. Only declared catalogue
failures with valid fields pass through. The corpus runner replays `sqlite.*`
Stubs as the implementation's `{columns, rows[, changes]}`, with `{real: t}` for
a double, and gives each `database` one coordinator that takes `stub-effect`
lines.

The `sqlite/` module holds an implementation on
[`github.com/ncruces/go-sqlite3`](https://github.com/ncruces/go-sqlite3), which
bundles SQLite 3.53 and needs no cgo. It isn't the Core. `sqlite.Open(path)`
opens one database file, and `sqlite.Databases(map[string]*Database)` is the
`SqliteImpl` over the Host's databases, by the name a binding gives; a binding
naming no database maps to no coordinator, so its Grant is refused. Each
database is one Segment Coordinator. A Segment's first `change` or `begin` takes
the one writer connection and opens its transaction with `BEGIN IMMEDIATE`, and a
Script transaction is a savepoint inside it. Every other read goes through a
read-only connection, which sees the last committed state in WAL mode. The
authorizer enforces chapter 9's denials and the binding's `Tables`, `query` is
checked with `sqlite3_stmt_readonly`, and the driver's prepare tail and bind
names give the one-statement and placeholder checks. The write lock lives in the
process, so the process owns the file: it holds an exclusive lock on a sidecar
database, `<path>-lock`, until `Close`, and a second `Open` fails. `Exec` runs
SQL outside every Segment, as for a migration.

- **Concurrency:** a `Database` is safe for Groups pumped on separate
  goroutines, whose calls take turns on its connections. Their Segments run at
  once, so one Group's first `change` or `begin` raises `sqlite busy` while
  another Group's Segment holds the write lock, with no Fuel Slice involved.
- **Limits:** the database keeps no Stores, so a Store and `sqlite` don't share
  a coordinator, and `Core.StoreCoordinator` is not implemented. `VACUUM` is
  refused by its keyword, since `VACUUM INTO` never reaches the authorizer.
- **Tests:** [`internal/sqlitekit`](internal/sqlitekit/) runs the
  [sqlite test kit](../../corpus/sqlite-kit/) through the factory's
  Operations, by way of the `internal/hostkit` hook. `sqlite/kit_test.go` runs it
  on this implementation, skipping `store.toml`, and `sqlite/host_test.go` runs
  Scripts against it.

### Host Object handles, properties and disposal

`Core.DefineObjectKind(ObjectKindDef)` validates and copies a reusable declaration,
including property Shapes, callbacks and safe costs. `Group.Object(kind, id,
native)` registers a Group-scoped handle. Kind/id pairs are unique within the
Group, even after disposal; different kinds and different Groups may reuse an
id. Native state stays on the Host side. Well-known `LoadOptions.Objects`
bindings are copied, checked for Group ownership and preserved through Reload.
Host calls and Capability results accept registered handles, including nested
containers, and refuse foreign handles.

`Group.Dispose` queues an idempotent Host Input applied before turns at the next
Pump. It may be called from any goroutine or a Host callback. `objectKind(o)`,
`isDisposed(o)` and `the id of o` are Core-owned and usable in Guards. Disposal
changes only lifecycle state: identity, equality, id, kind and Value Encoding
remain available. Atomic lifecycle state permits concurrent metadata reads.
Every accepted disposal input notifies `OnReady` after releasing the queue lock.

`the k of o`, quoted and computed keys invoke a declared property's `Get`;
`set` invokes `Set` after checking the input Shape. A missing key reads Nothing;
a missing or read-only setter raises `read only`. A Shape mismatch precedes the
Host call and its charges. Instruction Fuel and declared Fuel/allocation are
paid atomically before the callback. Get results and custom failure Data are
validated for Shape or error-contract compliance and Group ownership, then
charged for conversion. Panics, invalid results and malformed failures raise
`host error` with the Object Kind and property names; Host detail stays in a
`CallFailed` report with an empty Call id, since properties have no call id.
Each actual call writes a `prop` record before later raises or cancellation.
If Stop or a newly landed cancellation interrupts the Run at that crossing,
the property failure raises no `host error` and emits no `CallFailed` report.
Failures in property calls made during cancellation's finally cleanup still
raise and report normally.
Host effects survive later conversion faults or Script Segment rollback.

Outside Guards, disposed handles reject every non-id key read, including missing
keys, and every property write with `object gone`. Identity inspection remains available.
Property callbacks may queue ordinary Host inputs; these wait for the next
Pump, while `CancelRun` may land at the crossing and run finally cleanup.

Guards reject known Object non-id keys at Load, including computed keys unless
they are the Text literal `id`. Parentheses preserve known roots and literal keys.
A dynamic Guard reads map keys or the Core-held Object `id`; other Object keys
raise `wrong kind` (expected map), charge the ordinary key instruction and skip
the Guard clause without calling the Host. This also applies after disposal.
Missing or read-only setters reached through dynamic keys or aliases still raise
`read only` at runtime. Literal writes through `me` also use the owner
Kind metadata at Load and Reload.

### Object Message Paths

`SetParent` queues parent changes and rejects known cycles and disposed children.
Changes that become invalid while queued, including children unresolved by Restore, leave the parent unchanged, write `refused`, and report a `*HostError` in the next Pump. Later inputs still drain; the report code is covered by parity and its detail is Host-only.
`ParentKinds` remains manifest metadata. Disposal preserves Object identity,
stops its owning Script without finally cleanup, and routing skips to its parent.
Later Script-addressed deliveries are accepted and dropped under the same Stop
reason; Requests fail as stopped and open Decisions become undecided.

Object-addressed Deliveries, Requests and Decisions route to the nearest live
Owning Script. Accepted messages retain admission when a preceding parent input
changes their receiver. Dispatch checks the current path before message
observation or creating a Run; a moved message joins its new mailbox tail,
even beyond depth, without Fuel. An unowned path ends with Unhandled and zero
Fuel. Started, preempted and parked Runs stay in their Script.

`me` is the owner or Nothing; `the target` remains the initially addressed Object,
or the initially addressed Script's owner. `pass` and unmatched messages climb
from the last owner's current parent, checking capacity for the climb. Pending
Requests, waiting sends and open Decisions continue with the same ids. A full
climb emits `climb-full` and ends unhandled. Every receiver applies its own limits,
with Host overrides as additional caps.

Script sends accept Objects, named Scripts and `me`. Unknown Command Calls send
from the owner's parent; their `and wait` forms await the final receiver. At the
end of a path, waiting senders fail with `send failed`, reason `unhandled`.
The eight reviewed Message Path, Decision and owner-disposal corpus cases pin
exact costs, movement order, Targets, Stop reports and Verdicts.

### Scheduling and suspension

Duration waits retain heap frames and release the Script to run other queued
work. Their deadlines use the Pump's Clock reading plus an exact duration,
rounded to whole microseconds, half even. Due timers enter the work queue after
Host inputs, ordered by deadline and then creation. Zero and negative waits
resume only in a later Pump. `NextDeadline` reports the earliest retained timer.
Inspection lists suspended and ready Runs in start order; Persistent State
counts every retained Run.

Local Handler and Function Value calls with `and wait` retain their call frames.
Resumption starts a new Segment snapshot at its actual turn; Fuel and allocation
remain cumulative over the Run. A suspension charges the wait before checking
retained Persistent State. Cancelling a suspended Request removes its timer and
queues finally cleanup in input order, preserving committed earlier Segments.
`CancelRun` also queues cancellation and may land during a Pump at a Host crossing
or Pump end; ordinary settlements still wait for the next Pump. `RewindRun` lands
the same way: a Run that hasn't passed a Suspension Point (its saved
`SuspendedOnce` is false) is rolled back, discarded with reason `rewind`, and its
message put back at the head of the mailbox, and the Pump returns `Rewound`.
`Reload` with `ReloadOptions{KeepMailbox: true}` keeps that mailbox (ADR 0068).
Faulted cleanup rolls back only its own Segment. Deadlines beyond `time.Time`'s
representable range stop at the untouched wait boundary; durations beyond
`time.Duration` are supported when their deadline fits `time.Time`.

Message waits support one-line `wait for`, optional timeouts, and block-form
`when`/`after` branches. Every pending wait observes a dispatched message in
registration order before Handler dispatch, without consuming it. Event tests
use captured locals from registration and current Script Variables; failed
patterns bind nothing, and Guard errors skip and report their branch. The first
matching branch wins. Timers choose the earliest deadline, with source order
breaking ties. A match retains its message and bindings until its Run resumes;
cancellation removes subscriptions, timers and ready events before finally cleanup.
Inspection shows `wait-for` or `wait-for-any` and the earliest deadline, if any.

Event tests pay their own instructions, without a Handler Clause dispatch
charge. Their Fuel and allocation accumulate on the waiting Run, uncapped
there until its next resumed instruction. All observation work counts toward
the Pump's receiving Script slice and Group cap. Observation finishes atomically
even past those budgets; the incoming Run is then preempted before its first
instruction, ahead of newly ready waiters, and slice overrun becomes debt.
Internal `error` messages are observed even without an error Handler. Named
Script filters resolve when waiting begins; missing names raise `object gone`,
and other non-Object filters raise `wrong kind`. Object filters compare the
Delivery's fixed Target; moved messages are observed only by the receiving Script.

Non-waiting `send` to a named Script or an ownerless Script's `me` joins the
receiver's work queue immediately during a Pump. Receivers never run inside the
sender; FIFO order and sender Run identity are preserved. Named receivers can
load after their senders, and their existence is checked when the receiver is
loaded onto the operand stack. Missing names raise `object gone`; ordinary
non-Object Values raise `wrong kind`. Mailbox capacity includes Host inputs
accepted during the Pump. A full mailbox raises `mailbox full`, with the Script
name as `to`, at the paid send; no message is delivered.

The sender pays Cost Model 0's message charge: 20 Fuel plus the rounded-up
message size divided by 32, allocating the message size. The message counts
against the receiving Script's mailbox and its Run uses that Script's own
limits. A self-send updates the sender's retained-state base immediately, so
the queued message counts at its next Persistent State check. Budget faults
prevent delivery; later sender faults, errors or
cancellation preserve already sent messages. Plain `send` leaves `it` unchanged.
Receiver Names remain plain frame data across preemption and contribute no
Value size to Persistent State.

`send … and wait` to a named Script or an ownerless `me` uses the same mailbox
and message charge, then releases the sender's Script until the receiver ends.
Each accepted waiting send gets a call id in that Run's start order. A reply
resumes the sender at a new Segment and is stored in `it`, with no further
send charge. Receiver errors, Limit Faults, cancellation, dropping and unmatched
messages raise `send failed` at the sending instruction, with `reason` and,
for an error, the receiver's error map. A send's reply wait is bounded by the
sender Run's `MaxWait`, including a tightened Delivery override. A timeout raises
`timeout`, with `after` in milliseconds. Sender cancellation runs its cleanup;
cancellation, timeout and a retaining-state fault abandon the reply without
cancelling the receiver.

A pending reply counts 48 bytes toward the sender's Persistent State at
suspension. Once the receiver ends, the ready sender retains the reply Value,
or the receiver's error map for a failure, in place of that call. Resumption
charges, including unwinding through local Handler frames, spend the Pump's
Fuel cap and the Script's slice before following instructions run. Inspection
reports `send-wait` and the pending call id, with no `until` for `MaxWait`.
Foreign Function Value calls use the Home Script mailbox and the same reply
mechanism; see [Function Value calls](#function-value-calls).

`wait for all … end` supports ordinary Capability calls and waiting sends to named
Scripts, Host Objects and `me`, including mixed Joins. Each member starts where
reached, leaves `it` unchanged, and receives a call id in start order. The closing `end` suspends once; its ready resumption
assembles replies in start order and allocates their result List. A Join that
starts no dynamic members returns `[]` immediately without a Segment boundary.
The first arriving failure raises the member's own error with its 1-based `index`
at the closing `join-end` instruction; Script receiver failures use `send failed`.
Other pending members are abandoned in start order, cancelling Capability Contexts
while Script receivers continue. Capability results convert and charge in start order. Body errors, limit faults and sender
cancellation also abandon pending members; cancellation runs normal cleanup.

Each pending member counts 48 bytes toward Persistent State, including across
preemption in an open Join. Early replies replace their pending-call size with
the retained answer; a ready failure retains its Capability Data or receiver error map. Replies
arriving before a preempted Join closes are kept in arrival order. A Run's
`MaxJoin`, including a tightened Delivery override, faults before charging the
member that would exceed it. Each member's `MaxPending` or effective `MaxWait`
begins when the Join closes and is not reset when another member replies.
Script members share the Run's `MaxWait` deadline;
Pump Fuel Caps, Script Fuel Slices and unwind charges still apply when the caller resumes. Inspection reports
`join-end`, pending member ids in start order, and no `until` for call timeouts.

A plain local Handler call to a may-suspend Handler is rejected with
`missing and wait`; function-style calls to a may-suspend Handler are rejected
with `can't suspend here`. A Command Call with `and wait` to a statically
resolved Handler that cannot suspend is rejected with `needless and wait`,
including inherited Handlers and names shared with Script Variables or Constants.
Unresolved calls up the Message Path and `send … and wait` remain valid.
A call cannot hide a nested Join.
Join failures and timeouts use the closing `end` token's source position,
for bare `end` and `end wait`, including Joins in local Handlers and block
Lambdas. The `join-end` PC and 1-based member `index` stay unchanged; a failed
reply retains the receiver's own Error map and source position.
Lambda Errors name their enclosing Handler or function in `at.handler`, while
the generated body-table identities and PCs remain unchanged. Function Value
sizes count captured Values; the `items` measure is zero for a Function Value,
as Cost Model 0 specifies. `errors/lambda-capture-parity` agrees on Go, TS and
TS save/restore for captured Join failures/timeouts and nested Lambdas. The
maintainer approved its first blessing on 2026-10-05 and a later correction on
2026-10-07; see the [step-3 approval record](../../docs/reviews/step-three-blessings/README.md).

Decisions expose a `Deciding` future and a `Decided` report. An
ordinary Handler allows after its successful dispatch charge; an unmatched
message also allows. A matching pending wait allows a Decision before Handler
dispatch. A deciding Handler keeps its Verdict open through
preemption until its first Segment ends or suspends, sealing `Allowed`, or
until `veto` completes its finally cleanup, sealing `Vetoed` with its reason.
The vetoed Run completes with Nothing. Errors, faults, drops and cancellation
before sealing report `Undecided` with the Run's outcome. Reports appear at
the seal, and futures settle after the Pump's records. Context cancellation
after sealing leaves the continuing Run alone. The corpus runner replays
`cancel-delivery` by cancelling the context passed to the public Request,
Decision or Function Value call, waiting for `OnReady` before its next input.
The complete Decision cancellation and Host Function Value cancellation cases
pin mailbox removal, Verdicts, cleanup and exact costs. Native runner tests
also abort a sealed Decision and require no queued input or cancellation.
Load checks reject vetoes
outside deciding entry Handlers, in locally called Handlers, or reachable
after suspension, and reject passes reachable after suspension. Open Decisions
follow Message Paths through `pass` and unmatched Runs.
For a Script with no owner, `pass` completes its Run and reaches the end of the
path, reporting `unhandled` and allowing an open Decision; Requests fail with
`send failed`, reason `unhandled`.

`Group.Broadcast` and `Group.DecideBroadcast` choose recipients when inputs
drain, in Script load order: a Handler or a pending message wait makes a Script
interested. Scripts loaded after the call can participate; earlier queued
disposal or cancellation removes stopped Scripts or cancelled waits. Each
recipient gets a Delivery id and its owner's Target. Broadcasts never climb
Message Paths or emit an `unhandled` report, including after `pass`.

Broadcast admission checks arguments and limit overrides against the Core's
defaults. Each recipient keeps the tighter of its own limits and the override.
Recipients join FIFO mailboxes even past capacity, since they are unknown at
admission. Runs and start Segments carry the Broadcast id. Host input override
Trace maps use the Data File names, including `maxWaitMs` for Go’s `MaxWait`,
measured in whole milliseconds.

A Broadcast Decision settles after every recipient seals. Any veto wins over
undecided outcomes, which win over allowed; an empty Broadcast is allowed.
Vetoes and undecided outcomes retain recipient order across Fuel Slices. Context
cancellation removes or cancels only recipients with an open Verdict; already
sealed Runs continue. Reload and disposal settle only the affected recipients.
The two reviewed Broadcast Decision cases and full
`cancellation/broadcast-recipients` case pass unchanged, including prior Stop
inputs. Snapshots preserve shared Broadcast Decision state and recipient order;
variables-only restore queues discarded open Verdicts for its first Pump.

Queueing Policies apply to the selected entry clause after Destructuring and
Guards. `queued` parks later Runs FIFO while the mailbox keeps flowing;
`dropping` ends a new overlapping Run with outcome `dropped`; `replacing`
cancels earlier Runs whose Verdicts are no longer open and queues their finally cleanup in their existing work
order. Failed Guards never affect a clause's queue. Policy dispatch survives
preemption, and parked and dropped Runs pay dispatch once without entering the
body. A replacement with unpaid dispatch cancels earlier Runs only after
paying the first instruction's combined charge. Parked Runs appear as
`Parked`, count toward Persistent State, and do not
consume mailbox slots. A clause releases its first parked Run when its last
unparked Run ends, including errors, faults and completed cancellation cleanup.
A resumed parked Run starts a new Segment snapshot and keeps its Run budgets.

An uncaught error queues a separate `error` message behind the existing mailbox
messages, with the failed Run as its sender. Error Handler Clauses use ordinary
Destructuring and Guards, including the text-code shorthand. Their `during`
binding holds `{name, args}` for a message or `{fn, args}` for a Function Value
call, with the original Function Value and captures. It is available before Guard
tests and survives clause skips, local calls, preemption and Save/Restore. An unmatched internal error never reports `unhandled`,
and an error Run that errors sends no further message. A full mailbox, including
reserved Host inputs, drops the error with an `error-dropped` Trace note. Queued
errors count toward Persistent State and can resume pending `wait for error`
observers before Handler dispatch.

Inspection and counters are worker calls; a refused call with no error return
panics with `HostError`. Trace callbacks run without the input queue lock.

## Message Layer

The native stdio sidecar and WASI reactor use the [Zig Core](../zig/README.md#building-and-testing). The Go `cmd/messagelayer` executable and its internal transport adapter are retired ([ADR 0090](../../docs/adr/0090-the-native-message-layer-sidecar-uses-zig.md)); the Go public API, facilities and comparison baseline remain. Message Layer consumers need neither Go nor a WASI runtime for the native sidecar.

Go-Core saves cannot be restored on Zig: saves are per Core ([ADR 0008](../../docs/adr/0008-same-core-save-restore.md)). Start fresh Groups from source and Host-owned data, or keep the previous Go runtime/artifact until existing Groups are drained or rebuilt. No save converter is provided.

### WASI reactor

The Message Layer reactor is the [Zig `wasm32-wasi` build](../zig/README.md#building-and-testing), as [ADR 0089](../../docs/adr/0089-the-zig-build-serves-the-message-layer-reactor.md) records. The Go `cmd/messagelayer-wasi` entry point is retired. CI's shared reactor and List-memory checks run against Zig.

#### Historical Go reactor measurements

The following measurements describe the retired Go reactor, not the current Zig default. Reproduce them from the named historical commits and the commands in the linked raw reports. Current reactor build and check commands are in the [Zig guide](../zig/README.md#building-and-testing).

Measured on 2026-10-10 with Go 1.27.2 and the former stripped reactor build:
**12,457,777 bytes raw**, **2,980,976 bytes gzip**, **2,106,513 bytes Brotli**.
The check ran under Wasmtime 49.0.0 with Python 3.14.8, zlib 1.2.12 and
Brotli 1.2.0. The module's SHA-256 was
`68a8eaa630d1799d47bfaa379f0ce2dd437ebb176ae568b5330757e2ec250421`.
These sizes are evidence for this build, not a fixed limit on later builds.

After reducing Standard Library compilation allocations, the Elixir Host's
`mix talk.measure --only latency --no-save` measured **15.5 MiB median** and
**15.8 MiB maximum** linear memory over 20 fresh Wasmex instances on
2026-10-10 (Go 1.27.2, Wasmex 0.15.1, Wasmtime 47.0.2, macOS arm64).
This covers `hello`, one Group, a small Script and one Pump, meeting the
16 MiB startup target in [#585](https://github.com/odogono/odgn-talk/issues/585).
The [measurement record](../../tools/wasi/results/2026-10-10-stdlib-memory.json)
includes the build command, artifact hash and a separate Wasmtime 49.0.0 check.

Adding `map.transform` (#697) pushed eager compilation to 17 MiB. Compiling each
Standard Library on first use brought the same check to **7 MiB** on every one
of twelve fresh instances on 2026-10-14 (Wasmtime 49.0.0, macOS arm64).

#### List memory and Host caps

The following backstop guidance and measurements describe the historical Go
Message Layer artifacts. For current native and WASI transports, use the
[Zig guide](../zig/README.md#native-message-layer-sidecar).

The Allocation Budget and Persistent State measure **logical size**, rather
than physical Go heap or WASI linear memory. Container slots use a 32-byte
tagged Value on 64-bit Hosts (16 bytes on `wasip1`), with kind-specific payloads
shared across immutable copies. Persistent List trees copy a small chunk and
its path during growth; contiguous internal reads materialize an array on demand.
Segment checkpoints and Go's garbage-collection headroom also consume memory. Sharing changes neither Fuel nor logical accounting; the public
Value API remains compatible. Value compaction preserves its codec representation; the current snapshot format is `go/7` because restricted callback frames add execution state.

For a fresh Message Layer Session running one of the flat List-growth
workloads below, set a memory backstop of **64 MiB + 12 × Allocation Budget**:
**256 MiB** with the default 16 MiB budget, or **3,136 MiB (3.0625 GiB)** with
the conformance-minimum 256 MiB budget. Both leave room for the runtime and
reach a Script Limit Fault within the tested cap. A 128 MiB default cap does
not cover the cheapest List elements: `nothing` costs only 16 logical bytes
per item. Additional Scripts, retained state, simultaneous Runs, Host-held
Values, large protocol frames and Trace recording need additional provision;
the formula is measured guidance for these workloads, not a universal bound
on arbitrary Sessions. A physical memory backstop is separate from Script
limits, and exhausting it can terminate the process or WASI instance.

Measured on 2026-10-10 with Go 1.27.2, macOS arm64 and Wasmtime 49.0.0,
using a fresh process/instance per case, default Go GC settings and no Trace:

| Growth workload | Limits | Sidecar peak RSS | `wasip1` peak linear memory |
| --- | --- | --- | --- |
| Run-local List, repeated 64-byte text | default | 39.09 MiB | 90.00 MiB |
| Run-local List, `nothing` | default | 100.95 MiB | 133.50 MiB |
| Script Variable List, repeated 64-byte text | default | 29.61 MiB | 28.50 MiB |
| Script Variable List, `nothing` | default | 37.77 MiB | 37.50 MiB |
| Run-local List, repeated 64-byte text | conformance minimums | 238.50 MiB | 333.00 MiB |
| Run-local List, `nothing` | conformance minimums | 1241.67 MiB | 1563.00 MiB |
| Script Variable List, repeated 64-byte text | conformance minimums | 397.47 MiB | 464.50 MiB |
| Script Variable List, `nothing` | conformance minimums | 751.50 MiB | 835.00 MiB |

The Run-local workloads fault on allocation; Script Variable workloads
commit every 1,000 additions and fault on Persistent State (64 MiB at the
minimums), retaining the last committed List after rollback. Every case
then runs a healthy Handler on the same Session. At conformance minimums,
even the cheapest-element List faults below wasm32's 4 GiB ceiling. RSS and
linear memory are distinct metrics; these are single-run observations, not
cgroup peaks or measurements from the Elixir Host in #553. The
[raw reports and artifact hashes](../../tools/wasi/results/2026-10-10-structural-sharing-memory.json)
record all eight cases per transport for [#598](https://github.com/odogono/odgn-talk/issues/598).
The [earlier buffer-growth measurements](../../tools/wasi/results/2026-10-10-list-memory.json)
remain the evidence for [#584](https://github.com/odogono/odgn-talk/issues/584).

These figures describe the historical Go artifacts. Current sidecar build and memory-check commands are in the [Zig guide](../zig/README.md#native-message-layer-sidecar). The shared memory check enforces the stated backstop; the sidecar check asserts the child's OS-reported peak RSS. CI runs conformance-minimum WASI and native sidecar cases against Zig, including rollback and post-fault reuse. Native Go regression tests still check slot size, sampled heap growth, aliases and concurrent List branches.


## Corpus runner

From `impl/go/`:

```sh
go test ./internal/corpus
NORTHTALK_CORPUS=text-model/chunk-write-padding go test ./internal/corpus -run TestSelectedCases
```

The package's gate runs the complete Corpus through the embedded Zig Core and
fails on any case that does not pass, listed or not, and on a listed case that
no longer exists. Disassembly cases are the Zig Core's own runner's: the Go
Host has no compiler output to compare. Each failure ends with a `reproduce:`
command. The list includes all text-model, load-diagnostic and Value Encoding
acceptance cases, plus reviewed scheduling,
error, Decision, Capability, Library and Standard Library traces. Trace cases replay through the
public embedding interface, with exact records, costs and final state. All three
Counters cases are protected in ordinary and save/restore replay.
`counters/faults-and-cleanup` uses a public Request context for queued cancellation;
it starts no Run and charges no Fuel. Its corrected input was approved on
2026-10-07 ([approval record](../../docs/reviews/milestone-one-blessings/README.md)); see the [Spec derivation](../../docs/reviews/delivery-cancellation/README.md#queued-request-cancellation-correction-364).
Tests separately enforce the full 62-case step-1 set, eight reviewed step-2 cases, 32 step-4
limit/cancellation/Text Pattern cases, all 30 Segment-bound effect cases, and
18 step-5 save/restore, Extend and replacement cases, and all twelve Session
Transcripts, so removing a required case cannot silently
shrink the gate. Five reviewed Core-error cases also pin retained error-map
sizes, and two new error-delivery regressions agree on both Cores. Four
reviewed wait cases pin zero waits, deadlines, rollback and nested frames.
Two new suspension regressions also agree on both Cores, covering work ordering,
cap-held resumptions, duration rounding and long durations. The maintainer
approved the first blessings of these four regressions on 2026-10-05; see the
[step-3 approval record](../../docs/reviews/step-three-blessings/README.md). The reviewed Queueing Policy case also passes; two new
policy regressions agree on both Cores before blessing, covering selected
clauses, Guard skips, preemption, and dispatch and Persistent State limits.
The maintainer approved both policy regressions for #135 on 2026-10-05.
Listing an unreviewed regression case here protects it while its first human
blessing review remains pending.
Three reviewed Decision cases pin errors, faults and preemption before sealing.
A new Decision regression agrees on both Cores, and its first blessing was
approved on 2026-10-05; it covers dispatch charges, dropping, veto
cleanup, unmatched messages and a Run that resumes after its Verdict seals.
Four observation traces reproduce the corrected event-test charge on both Cores,
including atomic cap/slice overruns, debt, late Run faults and Decision sealing.
A new observation regression also agrees on both Cores, and its first blessing
was approved on 2026-10-05; it covers pinned locals, live Script Variables,
branch priority, Guard errors, non-consuming matches, sender filters, timeouts
and internal error observation. The reviewed `suspension/wait-for` case now
agrees on Go, including Script sends and sender filters. Three new send regressions
agree on both Cores; `limits/self-send-persistent` was approved for #135 on
2026-10-05, and the two suspension cases' first blessings were approved on
2026-10-05, with a later `suspension/script-sends` correction approved on 2026-10-07.
They pin FIFO and self sends, full/missing/invalid receiver errors, record order,
immediate delivery surviving a sender error, and preempted receiver identity
without Value size, and same-Segment Persistent State checks after self-send.
The corrected `decisions/broadcast-outcomes` and `objects/wait-target` Traces
also agree on Go after Broadcast Decisions and Object Message Paths were added.
`reload/extend-units` passes unchanged, including old Function Values after
Extend. The nine-case event-test acceptance set requires all eight corrected
Traces and the observation regression in the passing gate, with exact ordinary
and save/restore replay. The [charging reconciliation](../../docs/reviews/event-test-charging/README.md)
records their complete parity verification. Every supported Trace also runs
with Save/Restore between Pumps,
subject to chapter 11's exclusions for old Host handles. Live effects require an
`effects pending` refusal with unchanged inspection and counters before replay
continues on the original Group.

The reviewed `suspension/send-and-wait` Trace also passes unchanged, with replies,
receiver errors, unmatched messages and timeout. Three new paired reply cases
pin resumption unwinding under a Pump cap, pending-call retention faults, and
replacement cancellation with cleanup and ignored late replies.
`limits/send-wait-retention` was approved for #135 on 2026-10-05; the two
suspension cases' first blessings were approved on 2026-10-05, with a later
`suspension/send-reply-preemption` correction approved on 2026-10-07; see the
[step-3 approval record](../../docs/reviews/step-three-blessings/README.md).

Six reviewed ordinary Capability cases and `limits/mailbox-depth` pass unchanged: calls, argument Shapes,
load checks, Host failures, charge faults and omitted optional arguments.
Two new cases agree on Go, TS and TS save/restore before blessing:
`capabilities/declared-allocation` pins atomic pre-Host charging in both modes;
`capabilities/ordinary-grants` pins alias bindings, revocation, trimming and caught
raises before later Host calls. Their first blessings were approved on
2026-10-05, with a later `ordinary-grants` correction approved on 2026-10-07;
see the [step-3 approval record](../../docs/reviews/step-three-blessings/README.md).

Under `--check-passing`, any failing or unsupported case fails, as does a listed
case that no longer exists; an unlisted passing case is reported for addition.
A plain run reports `SKIP` with a reason for unsupported facilities, and
explicitly selecting an unsupported case fails.
Session Transcripts reproduce their existing output and `case.trace` unchanged.
The `sessions/extension-lambdas` regression covers extension Lambdas with and
without captures, calls and display after Save/Restore; its first-blessing review
is pending in the [review record](../../docs/reviews/extension-lambdas/README.md).
The original nine first blessings were reviewed under [#131](https://github.com/odogono/odgn-talk/issues/131#issuecomment-5957819419);
the later `fenced-text` Transcript was approved on 2026-10-05; see the
[fenced-text approval record](../../docs/reviews/fenced-text-blessings/README.md).
Each emitted Trace also replays independently through the public embedding API,
both ordinarily and with Save/Restore between Pumps. Save/Restore replay is part
of the Trace backend. The Go runner has no blessing mode and never changes expected
Corpus lines.

Six reviewed Library-related cases pass unchanged: `libraries/calls`,
`libraries/errors`, `libraries/registration`, `stdlib/calls`,
`stdlib/errors-name-the-call` and `builtins/function-values`. A separate
acceptance test requires all six in the gate.

The new `stdlib/template-migration` regression also agrees on Go, TS and
TS save/restore, and is required in that gate. Its first blessing was approved
by the maintainer on 2026-10-05 for #275; see the
[fenced-text approval record](../../docs/reviews/fenced-text-blessings/README.md).

Three reviewed Library Capability cases also pass unchanged: `libraries/needs-transitive`,
`libraries/needs-suspending` and `capabilities/optional-args`. The new
`libraries/caller-capabilities` regression agrees on Go, TS ordinary execution
and TS save/restore. Its first blessing was approved on 2026-10-05, with a later
correction approved on 2026-10-07; see the [step-3 approval record](../../docs/reviews/step-three-blessings/README.md). It
pins private/transitive needs, caller calls and charges, nested suspension,
Library cancellation cleanup, late answers and revocation. A separate acceptance
test requires all four in the gate.

Three reviewed Standard Capability cases pass unchanged: `standard-clock`,
`standard-clock-fuel` and `standard-timer` under `capabilities/`. A separate
acceptance test requires them in the gate, pinning microsecond readings through
Library calls, declared cost rollback, Timer Host charges and ordinary Deliveries.

The reviewed `standard-console`, `standard-console-timeout` and
`standard-console-cancel` traces also pass unchanged, including nested Function
Values, Library Grants, starting/late costs, the fixed timeout and abandonment.
The reviewed `reload/function-staleness` trace passes with corrected Function
Value display. A separate acceptance test requires all four cases in the gate.

Three reviewed Calendar cases pass unchanged: `standard-calendar`,
`standard-calendar-errors` and `standard-calendar-validation` under
`capabilities/`. A required-case acceptance test protects all three, including
optional arguments, declared failure fields, uncharged domain errors, malformed
results and exact costs.

Three reviewed Locale cases pass unchanged: `standard-locale`,
`standard-locale-ranks` and `standard-locale-validation` under `capabilities/`.
A required-case acceptance test protects all eight Operations, dense-rank
sorting, option/tag validation, malformed answers and exact charges.

The reviewed `builtins/object-kind` and `builtins/kind-of` cases pass unchanged
through public Object registration, well-known bindings and queued disposal.
A required-case acceptance test protects kind inspection for all Value kinds,
identity and Guard behavior across Object kinds that share an id and after
disposal, including exact Fuel, allocation and persistent state.

The corrected `objects/properties` fixture uses a local alias for its runtime
read-only write; Get/Set ordering, declared and conversion costs, Shape errors,
missing keys and disposal remain covered. Its added alias costs two Fuel and
shifts later instruction and source positions. New `load-diagnostics/object-properties`
and `objects/guard-keys` cases pin Load diagnostics, map keys, live/disposed Object
Guard skips and Core ids. Both Cores agree on every record and cost before
recording expectations. Their first blessings were approved on 2026-10-05, with
a later `objects/properties` correction approved on 2026-10-07 (see the
[step-3 approval record](../../docs/reviews/step-three-blessings/README.md)), and required-case tests protect them in the Go gate.

The `capabilities/standard-store*` cases pass in ordinary and save/restore
replay and are required in the Go passing gate. Three keep their
[first-blessing approval](../../docs/reviews/store-blessings/README.md);
`standard-store-segments`, changed for #461, and the new
`standard-store-coordinator` await review. That review remains separate from
the memory Store's 32 store-kit sequences.

### Combined admission and Pump

`Script.RequestPump` and `Group.RequestPump` preserve their respective Script
and Object targets; `Group.CallPump` preserves Function arguments and limit
overrides. Each is a worker call: it admits one input and performs exactly one
ordinary Pump under the same worker guard. Earlier queued inputs keep their
order, and the returned Pending may still be unsettled.

All three return `(DeliveryID, *Pending, PumpResult, error)`. An admission
refusal returns no id or Pending and does not Pump. A Pump refusal after
admission returns the admitted id and Pending alongside the error and leaves
the input queued. Hosts must retain those handles even when `err != nil`.
Initial OnReady is omitted; a Pump refusal notifies after releasing the worker.
Function staleness fails at drain and wrong arity at execution, as with `Call`.

The Go embedding negotiates the accepted fields envelope by default
for new guests, following the [binary-exchange contract](../../spec/embedding/request-pump-binary.md).
The codec uses the generated envelope catalogue from `spec/data/envelope.toml`
for tags, ordered fields, Report names and specialized item kinds. Shared
[`envelope-frames.json`](../testdata/envelope-frames.json) vectors exercise its
framing and Value codecs against reviewed trees and exact re-encoded bytes.
Ordinary Requests, Function calls and Pumps then use binary frames, and the
combined APIs use the guest's combined messages after ordinary admission checks.
Their Pending is registered before sending; context cancellation uses the
exchange's token until its final reply, then the delivery id. Unsupported guests
refuse combined operations before admission, without a two-call fallback.
Set `TALK_ZIG_REQUEST_PUMP=fields` to select fields explicitly, or an empty
value to keep JSON and test unsupported combined calls. `BackendRequestPump` and `BackendCallPump` benchmark the public APIs;
`BackendRequest` retains the separate-call workload.

Host callbacks negotiate `callbacks-fields-v1` by default as well, so the
guest's `op`, `prop`, `effect` and `release` needs and the adapter's results
cross in the fields envelope ([#1311](https://github.com/odogono/odgn-talk/issues/1311)).
Set `TALK_ZIG_CALLBACKS` to an empty value to keep them JSON. On an Apple M5,
interleaved over 8 rounds, `Run/host/immediate` fell from 4.03 ms to 2.10 ms
(5.3× native to 2.8×), `properties` from 2.42 to 1.40 ms, `conversion` from
7.80 to 5.13 ms and `BackendDeferredCall` from 32.5 to 29.5 µs
([measurements](../../bench/results/go-zig-adapter/2026-10-19-callbacks-fields-darwin-arm64/paired.txt)).
