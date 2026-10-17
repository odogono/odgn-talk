# Go Core

The Go Core is module `github.com/odogono/odgn-talk/impl/go`, with public root
package `northtalk`. It provides immutable values, decimal arithmetic, pinned
Unicode text, a front end and standalone Abstract Machine execution. Its Group
embedding interface loads Scripts, accepts Deliveries and Requests, pumps Runs and
emits canonical Trace records. The Session Host provides Entries, Session
Commands, a REPL and deterministic Transcript replay. The Spec, Data Files and Conformance Corpus are
the authority; the TS Core is not a reference
([ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

Native Go remains the default and supported embedding package. An opt-in
[experimental Zig backend](#experimental-zig-backend) exercises public data/Request and Capability
embedding slices through wazero. The separate
[comparison probe](../../spikes/go-zig-binding/README.md) retains its native-Go
baseline and broader callback experiments; the
[binding investigation](../../docs/research/go-zig-binding.md) records the gates
before replacing the Go Core.

A Timeout Block, `with timeout of d … end timeout`, bounds the waits written inside it ([ADR 0073](../../docs/adr/0073-a-timeout-block-sets-one-deadline-for-the-waits-written-inside-it.md)). `timeout-start` pushes a deadline, the Clock reading plus `d` or the enclosing block's when that is no later, which stays on the stack below the body as an iterator does, so Unwind depths count it and a catch outside the block drops it. `exit repeat` and `next repeat` emit `timeout-end` for each block they leave. Each Suspension Point reads the topmost deadline on its frame's stack: past it, the instruction raises `timeout` with `deadline: true` at once, and otherwise the block's deadline replaces the wait's own timer when it is no later, or for a Join, is a timer of its own set before its members'. The checker reports `not in a timeout` and `empty timeout`, and a Host `Fail` may not use the reserved key `deadline`.

A `tell g` block calls each line's Operation of the Grant `g` ([ADR 0063](../../docs/adr/0063-a-tell-block-calls-several-operations-of-one-grant.md)). The parser reads `end` as the block's close and any other first word as an Operation name. Each line is an `ask` until the checker resolves it against the unit's Grants: a fire-and-forget Operation's line without `and wait` becomes a `tell`, once, so an importing Script's recheck tests the Library's lines as compiled. Lines then lower, check suspension and join as the one-line calls they stand for, at their Operation names. A Grant the unit doesn't hold is one `unknown operation` at the block's receiver. With no Grants, as in Disassembly Cases, every line lowers as an `ask`. `DefineCapability` refuses `end` as an Operation name.

An Operation with `Command: true` is also a Host Command, called by its name alone ([ADR 0094](../../docs/adr/0094-host-commands-are-command-call-spellings-of-granted-operations.md)). `DefineCapability` refuses the flag on a Reserved Word with `invalid value`. The flag is part of the Operation Data, so the Group Fingerprint and restore's declaration matching carry it, written after `segmentBound` and only as `true`, and saves keep it. `OperationCheck.Command` carries it to the checker, from Load, Extend, Reload, `CompileLibrary` and Library replacement. After declarations are collected, `resolveHostCommands` in [operations.go](internal/check/operations.go) resolves each unlabelled Command Call that names no Handler of the unit, local, imported or from an earlier Extend, to the one Operation its Grants offer as `command`. That runs before validation, so a Library's Host Commands aren't `not in a library`, while `and wait` on one stays `not in a join` and `not in a timeout` as for any Command Call. `checkOperations` then rewrites the node into the one-line call it stands for, a `tell` for a fire-and-forget Operation without `and wait` and otherwise an `ask`, so load checks, lowering, `needs`, GrantsAsUsed and an importer's recheck see an ordinary Operation call, and no instruction is added. `wrong mode`, `wrong argument count` and `wrong argument` are reported at the command's name or argument. Two Grants offering the called command are `name clash` at the call, and an Import named like any offered command is `name clash` at its name in the `use` line. The compile cache key already includes the Grant declarations, `command` included, so resolved calls never share a unit with unresolved ones; the code identity is unchanged. A Library's `needs` and recorded calls are read from its checked tree, which holds the resolved calls even on a cache hit. Go still rejects an unresolved Command Call in a Library with `not in a library`, where TS and Zig accept it. The Session Host's mocked Operations have no `command` flag. Check with `go -C impl/go test ./internal/check . -run HostCommand` and `go -C impl/go run ./cmd/corpus capabilities/host-commands`.

Any `repeat` head accepts `collecting e into v` ([ADR 0059](../../docs/adr/0059-a-repeat-may-collect-its-results.md)). The target is a local initialized to `[]` before the head is evaluated. Each completed pass appends one value after the body; `next repeat` and `exit repeat` skip it, and an error keeps the partial list. Bodies may read the target and suspend, but Container writes, pattern bindings and inner collecting clauses cannot write that target. Targets clash with Script Variables, Constants, well-known objects and the loop's own iteration bindings.

Whose Clauses ([ADR 0074](../../docs/adr/0074-a-whose-clause-picks-the-chunks-whose-condition-holds.md)) parse as a whole Expression into a `whose` node, whose `NameToken` is the chunk word: an Every Head is a `chunk` node with an `every` ordinal, and either head sits in a `delimited` node when it has `delimited by`, so `no item chunk` covers it. A Whose Key is a `key` node on a synthetic `it`, never a name. The checker reports `not in a whose` at a condition's non-Built-in call or Lambda, and an `unknown name` in a condition suggests `it's` in its message. Lowering walks the plural property with `iterate` and `next`, and `it` in the condition loads the innermost clause's temp, as chapter 8 lays out. `the items of` a list is the list itself, as chapter 4's property table says.

`a otherwise b` and `the optional k of x` follow [chapter 4](../../spec/04-expressions-and-statements.md#nothing-defaults) of language 1.0-rc.3. `otherwise` parses as the lowest `binary` operator and lowers to `branch-not-nothing` and `pop` at its own token, so the left side runs once and the fallback only on Nothing. Optional reads parse into `optional-key` and `optional-key-computed` nodes — `the optional of m` stays the ordinary key read by the `optional-key` decision — and lower to `get-optional-key` instructions at their `the`, which read maps and Nothing only, reject every Host Object with no Host crossing, and are never Containers. Both forms are checked in every operand in Guards, Constants and other restricted expressions. The Go Core passes the shared `disassembly/nothing-defaults` case and the `nothing-defaults/` and `load-diagnostics/nothing-defaults` Trace Cases.

Maps use persistent balanced trees for key lookup and insertion order. Lists
use persistent balanced trees of at most 32 values per chunk. A Map key write,
a List point replacement or deletion, and List growth with `put … after/before`,
spreading or `collecting` copy only the affected tree paths and chunks. Their
storage work is O(log n) per changed item, including branches from retained
values. Replacing or deleting a List range still rebuilds the result. Retained
values, Segment checkpoints and Host reads keep their original contents.
Logical contents sizes are cached and updated incrementally, as if nothing were
shared; Fuel and logical allocation follow the unchanged Cost Model, including
charging the full result size for `collecting`. Save/Restore uses the same value
format and reconstructs independent storage.


Whole Host Object properties can be assigned with `set` through `me`, `it`
or `the target`, including intermediate keys/chunks that locate the Object.
These implicit bindings cannot be replaced or used as roots for ordinary
Container mutations. `set` does not modify chunks inside a property's value.
Direct known-owner read-only properties are checked at load; `it` and Target
properties are checked at runtime ([ADR 0085](../../docs/adr/0085-property-writes-do-not-replace-implicit-bindings.md)).

## Experimental Zig backend

With Go 1.27, `-tags talk_zig_experimental` selects Zig behind the existing root
package API. `CoreVersions` then reports Zig's Core/save versions. Ordinary builds
retain native Go. The tag is a development slice, with no full API compatibility
or Go Core retirement claim.

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
Library constant is still stale in its callers (#1036), and two checks only
native Go makes, a Library calling its importer's Handler and a transitive name
cycle, are decided in #1037.

`Script.Reload` and `Script.Extend` go through the guest's `reload` and
`extend`, which check, record and refuse them as natively, including `state
too large`, `name reused` and every diagnostic. A Reload returns the typed
Reports of the Runs it discarded, settles their futures, keeps the mailbox
when asked, runs Grant release hooks with reason `reload` and restarts a
stopped Script. Each accepted Reload releases its kept Grants even if the Script
was already stopped. Function Values made by the old code are stale afterwards.

`Group.Save`, `Core.Restore`, `Group.Settle` and `Group.Fingerprint` use the
guest's `save`, `restore`/`resolve`, `settle` and `fingerprint` exchanges.
Saves are opaque `zig/11` bytes; native Go saves remain per-Core and cannot be
read by this backend. Restore compiles the supplied Libraries in its fresh
guest, rebinds Grants and native Objects through the public callbacks, and
returns typed accounting Reports and pending Calls. Answer, Fail, Reissue and
Adopt retain their queued semantics; adopted Calls own fresh Go contexts.
Object and Function Values in arguments, pending Calls and Script state belong
to the restored Group. Set `RestoreOptions.Name` for the new Group's name;
the Zig save does not retain the old Host name.

`restore-bindings-v1` lets resolution register new Grants before its answer,
and returns the Script, Object and Call metadata the adapter needs. Private
Capability handles select callbacks; public Capability names participate in
Fingerprints and declaration matching, independently of registration order.
Save passes through live-effect refusals, with a transport fixture covering
`effects pending`; public scoped/Segment attachments remain the separate
slice. Restored Call Segment ids are reconstructed from retained Run state
without changing the save format. Original Call Clock retention across later
Pumps remains [#1067](https://github.com/odogono/odgn-talk/issues/1067).
Reissue Fuel faults inside Joins remain [#1068](https://github.com/odogono/odgn-talk/issues/1068),
and uncaught lost-call error Data differs from native Go ([#1069](https://github.com/odogono/odgn-talk/issues/1069)).
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
default resolution, SQL parameter/result conversion and per-row charging.
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
The public Host matrix compares exact Trace, Fuel, typed Reports, futures and
inspection with a separately compiled native-Go binary; a Trace-disabled long
export exercises concurrent Delivery, Stop, CancelRun and Answer. The native
reference's refused input from `pumped` is excluded pending #1072.

Unsupported Capability attachments return an `experimental Zig backend` error.
Two Object Kinds sharing a
name in one Group's guest, and a Kind first defined inside a Host callback, are
refused. A Group that has done nothing but exist moves to another guest rather
than meet a Kind of the same name.
Shapes nested beyond 32 levels are also refused. These three declaration limits
are deliberate experimental limits, retained by the maintainer's decision on
[#1050](https://github.com/odogono/odgn-talk/issues/1050).
Unsupported calls do not fall back to native Go language execution.
Pool, Store and sqlite remain native-Go Host facilities and run through the
adapter, including the unchanged tenants example and the Store and sqlite test
kits. Session/REPL and full Corpus acceptance remain separate work.

Store retains `machine.ErrorValue`, `machine.Size` and the `internal/value`
Encode/Decode/DecodeMembers/JSONString/KindNames helpers. The sqlite module uses
no Go Core internals directly; its `internal/sqlitekit` test helper uses
`corpus`, `hostkit` and `value`. These helpers compute from Spec data rather than
executing the Go Core, so they remain shared under either backend without new
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
Group has a guest of its own. Each process
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
`python3 spikes/go-zig-binding/build-artifact.py` rebuilds both embedded copies
from committed Core/spec sources and records identical provenance.
With `talk_zig_experimental`, the Go Session Host and REPL use the embedded
Core's negotiated `analysis-v1` exchanges for Entry classification and
continuation, positioned syntax diagnostics, implicit Script Variables,
declaration descriptions and documentation, Fix/Continue, Built-in and Standard
Library catalogues, the inspection reader and computed message names. A single
serialized analysis guest shares the adapter's compiled engine and works before
a Group starts; analysis exchanges load nothing and produce no Trace. Value
formatting and pinned Unicode name matching stay with the Host. The untagged
build retains Go analysis behind `!talk_zig_experimental` until the Go Core's
retirement gate. `session`, `driver` and `cmd/northtalk` import no Go parser,
checker, compiler or generated catalogue packages. Cancelling an unfinished
inspection expression prevents its property reader from starting.

Native Session tests and all Session Transcripts pass. The experimental
backend also passes the `describe`, `named-functions`, `object-inspection` and
`observation` Transcripts unchanged, including defining documentation, disposed
Object inspection after Restore and Core-raised error messages left out of the
Trace. The Session’s private pending-input hook uses the
negotiated `queued-inputs-v1` query, so callback Deliveries receive one extra
Pump per Host call, Store Notifications drain at the same Clock reading, and
restored settlements are pumped before the next Entry. The query observes the
guest queue without execution or Trace. On the experimental backend, every
Session test and Session Transcript passes, including decomposed source, whose
Trace keeps the source text as written
([#1053](https://github.com/odogono/odgn-talk/issues/1053)).
`zig-experimental-check.sh` runs `./session`, `./driver` and every
`TestSessionTranscriptParity` case.

Sharing guests is what keeps a tenant cheap. On an Apple M5 with 10 guests
per Core, NewGroup plus one Script load takes about 29 µs, against 94 µs and
2.4 MB allocated with a guest per Group and native Go's 4 µs and 6 KB, and a
held Group retains about 88 KB of heap, against 2.4 MB and native Go's 63 KB
([#1103](https://github.com/odogono/odgn-talk/issues/1103)). The performance
limits are tracked in #1103. To repeat the committed
benchmark, run with and without `-tags talk_zig_experimental`:

```sh
CGO_ENABLED=0 go -C impl/go test -run '^$' -bench GroupInstantiation -benchtime 200x -count 3 .
```

Run the focused public slices from the repository root:

```sh
CGO_ENABLED=0 impl/go/zig-experimental-check.sh
impl/go/zig-experimental-check.sh -race
go -C impl/go vet -tags talk_zig_experimental . ./internal/zigwasm
```

`TestZigBackendCapabilityParity` builds an untagged test binary, runs its
`TestCapabilityBridge` with `TALK_BRIDGE_OBSERVATIONS` set, and diffs that
native JSON against the Zig adapter's observations. To inspect the native side
alone:

```sh
TALK_BRIDGE_OBSERVATIONS=/tmp/native.json go -C impl/go test -run '^TestCapabilityBridge$' .
go -C impl/go test -tags talk_zig_experimental -run '^TestZigBackendCapabilityParity$' .
```

The shared Hosts include scoped completion/error/Stop/cancellation/Reload,
automatic cleanup failures, coordinator conflicts and shared enrollment,
definite/unknown effect outcomes, and Standard precharge/result/failure checks.
The unchanged Scope, Segment, coordinator and factory tests join the tagged
selection. `TestCoordinatorMappingHoldsAcrossReloadAndRestore` still needs
Save/Restore; `TestEffectUncertaintyStopsEveryScriptAndCannotReload` reads native
private Script state, so public Host scenarios cover fatal outcomes instead.

`build-artifact.py` refuses uncommitted Core/spec changes. To try an
uncommitted Zig change, build it and swap the embedded copy by hand; the
digest in `artifact.json` must match, or `NewEngine` refuses the artifact:

```sh
(cd impl/zig && zig build -Dtarget=wasm32-wasi -Doptimize=safe)
cp impl/zig/zig-out/bin/talk.wasm impl/go/internal/zigwasm/talk.wasm
# then set "sha256" in impl/go/internal/zigwasm/artifact.json to:
shasum -a 256 impl/go/internal/zigwasm/talk.wasm
```

Never commit these hand-built files. Restore them with
`git checkout -- impl/go/internal/zigwasm`, then, once the Zig change is
committed, run `build-artifact.py` and commit its output. If a test panics
mid-suite, compile once and run tests singly:
`go -C impl/go test -c -tags talk_zig_experimental -o /tmp/adapter.test .`, then
`(cd impl/go && /tmp/adapter.test -test.run '^TestName$')`.

The shared public Hosts include callback-generated Broadcasts, cancellation
cleanup order and rollback, refused out-of-range Pump Clocks, and malformed
immediate, Start and later Fail data. Pump results, typed Reports, Fuel, futures,
Trace and inspected state compare exactly; only error wording and Host detail
wording are excluded, and failure detail must remain nonempty. The native tests
install Trace at Group construction and cancel through public Run controls.

An internally generated error Run retains its `during` message map through local
`error` calls, helper calls, later clauses and captured Lambdas, including across
Fuel slicing. Host-delivered `error` messages bind Nothing. Shared public Hosts
compare both cases against native Go with exact Trace, Fuel, typed Reports,
futures and inspected state. Function-call error metadata still needs the
chapter 6 `{fn, args}` correction in both Cores ([#1084](https://github.com/odogono/odgn-talk/issues/1084)).

Known execution differences remain outside the selection:
inherited veto checking on Extend ([#1060](https://github.com/odogono/odgn-talk/issues/1060)),
allocation fault positions and Join accounting ([#1061](https://github.com/odogono/odgn-talk/issues/1061)),
Send charging before delivery ([#1062](https://github.com/odogono/odgn-talk/issues/1062)),
parked-Run cancellation ([#1063](https://github.com/odogono/odgn-talk/issues/1063)),
out-of-range wait durations ([#1064](https://github.com/odogono/odgn-talk/issues/1064)),
and Stop at a failed Host charge ([#1065](https://github.com/odogono/odgn-talk/issues/1065)).
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

## Task navigation

**Recovery Offers:** this Core parses, checks, lowers and executes offers and two-phase catch search. Ordinary catches test before cleanup; recovery policy can choose a retained local/Library/same-Run action. `offerAvailable`, canonical metadata, costs and choice/entry Trace records are implemented. Nested policy searches stay within their selection boundary; escaping policy Errors carry `during` outward, transfer cleanup preserves or cancels choices as appropriate, and cancellation enumerates dispatch-local and retained scopes once. Dispatch saves retain control stacks, shared owner locals, pending transfers, cleanup progress and attempt numbers. Restore validates every retained code/body/PC, ownership chain, target and cleanup reference before resuming; search and lookup preempt only at the following instruction boundary. [Save/restore evidence](../../docs/reviews/recovery-offers-saves/README.md) covers ordinary catches, nested policy, transfer cleanup, action entry and cancellation. Session Scripts can choose Library offers and replay their Transcripts. The shared TS debugger and Playground follow active dispatch control and display retained frames with shared owner locals; Go reproduces their execution Traces through its replay backend. See the [tooling/session evidence](../../docs/reviews/recovery-offers-tooling/README.md) and [language rules](../../spec/04-expressions-and-statements.md#recovery-offers).

Use the [Go task map](NAVIGATION.md) for implementation files, Spec links, tests and root-relative check commands.

## Source nesting

The Go Core bounds recursive parser regions and the resulting syntax-tree
depth to 64, on native and WASI builds. This safety limit covers expressions,
blocks, binding and Text Patterns, Interpolation Holes, and operator or
property chains built without parser recursion. Load, Library compilation and
Session Entries refuse excessive nesting with a positioned
`source nesting too deep` diagnostic; a refused Load leaves the Group usable.
The diagnostic and bound are Go implementation limits, outside the Spec's
shared diagnostic catalogue; the Spec does not currently set a source nesting
bound for both Cores ([#582](https://github.com/odogono/odgn-talk/issues/582)).

## Layout

- The root package implements the available declarations of the
  [embedding interface](../../spec/embedding/talk.go). `value.go`, `encoding.go`
  and `text.go` own immutable values and codecs. `core.go` owns compilation and
  default limits; `group.go` owns Host inputs, and `group_run.go` pumps Runs.
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
- `internal/syntax/` owns lossless UTF-8 lexing and parsing. `Tree.Source()`
  reconstructs every source byte; only Text literal values are NFC.
- `internal/check/` resolves declarations, body slots, captures and initializer
  dependencies. Diagnostics sort by source position, then catalogue order.
- `internal/lower/` produces canonical instructions, source maps, Unwind Tables
  and Event Tables. Labels use instruction indices, never byte offsets. Its
  Go-private byte encoding round-trips each body's instruction stream.
  Operands, Cost Model keys and suspension flags are resolved after labels
  receive their final instruction indices; runtime operand views are read-only.
- `internal/machine/` executes checked code with heap frames, detached operand
  evaluation, clause dispatch, unwind state and generated Cost Model 0 charges.
  Trial stacks and locals reuse detached buffers within an execution turn;
  accepted charges copy their results back before effects commit. Returned
  call frames supply cleared buffers for later calls in that turn. These
  temporary buffers are discarded on preemption, suspension or completion.
- `internal/snapshot/` encodes plain heap data and explicitly named Group/code
  references; Host bindings and futures stay outside snapshots.
- `internal/trace/` orders records and keys by `corpus.toml`. It removes the
  Core's non-parity error wording from Trace values, including nested errors,
  while preserving Script and Host data named `message`.
- `session/` owns Entries, implicit Script Variables, atomic redefinitions,
  foreground/background Runs and Session Commands. It consumes Trace records
  to present output; inspection occurs only for explicit inspection commands.
- `driver/` owns Transcript parsing, recording/replay and terminal interaction;
  `cmd/northtalk/` connects it to filesystem I/O, stdin and Ctrl-C. Its
  [Pool](#driver-pool) pumps many Groups on a set of workers.
- `examples/tenants/` is the [multi-tenant Example Host](examples/tenants/README.md),
  an HTTP server with a Group per tenant, and the recorder of its Trace Cases.
- `internal/corpus/` reads setups and runs encoding, disassembly, Trace and
  Session Transcript backends. `cmd/corpus/` provides selection, first-divergence output and the gate.
- `internal/fuzz/` runs differential fuzz cases through the corpus runner's
  incremental replay Host, resolving symbolic Host Inputs as the fuzzer's TS
  runner does. `cmd/fuzzworker/` serves it over the
  [fuzzer's worker protocol](../../tooling/fuzz/README.md#dual-core-mode).
- The [Message Layer](#message-layer), both the native sidecar and WASI
  reactor, is supplied by the Zig Core. The Go embedding API stays native Go.
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
go -C impl/go run ./cmd/corpus --check-passing
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
go run ./cmd/corpus sessions/save-restore
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

The Host supports `:grant`, `:mock`, `:stub`, `:answer`, `:fail`, `:clock`,
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

## Front-end and lowering checks

A Script Variable or Constant may share a local Handler's name in either
declaration order. Value references read the variable or Constant; Command
Calls resolve the Handler separately, including from a Script extension.

Statically resolved Function and Built-in calls are checked at load against
their required and total parameter counts. Built-ins accept omitted trailing
defaults from chapter 7; invalid counts report `wrong argument count` at the
callee's name. Calls through shadowing variables remain dynamic and check
arity when they run.

Command Call arguments may start with any Name, including contextual words in
the FOLLOW set such as `times`, `before` and `whose`, as
[chapter 2](../../spec/02-grammar.md#statements) specifies. These words still
cannot start a chunk index; `item mod 2` reads `item` as a Name.

Argument Labels in Handler heads, Command Calls, target-first `send`, `pass`
and `wait for` form Selectors as [chapter 2](../../spec/02-grammar.md#argument-labels)
specifies. `move p to sq` names `move:to:`; positional calls retain `move`.
Selectors identify Clauses, Message Paths, wait events and their `it`, and Trace
records. Host Deliveries, Requests, Broadcasts and Decisions reject malformed
colon-containing names or mismatched argument counts at the call with `invalid value`.

`send (e) with a to r` computes its message name ([ADR 0057](../../docs/adr/0057-a-send-may-compute-its-message-name.md)).
It lowers to `send-named`, `send-named-wait` or `join-send-named`, which pop
the name below the arguments. The name is checked before the receiver:
non-text raises `wrong kind`, and text that isn't a Name or a Selector with one
argument per part raises `bad message name`. A receiver Name for a Script the
Group doesn't hold raises `object gone` at the send, after that check.

A Fallback Handler, `on any message m`, takes the messages no Handler Clause
matches ([ADR 0064](../../docs/adr/0064-a-fallback-handler-receives-messages-no-clause-matches.md)).
Its clauses are `fallback` bodies named `any message`, and `pass any message`
lowers to `pass`. `machine.StartDelivery` appends them, from every code unit,
after the Selector's clauses, with the uncharged message map `{name, args}` as
their one argument. Broadcasts, Decisions and `error` messages never reach
them, and neither do local Command Calls. A Fallback Run reports its message's
Selector as its Handler, plus `fallback`, which is derived from the selected
body's kind, so snapshots need nothing new to keep it. A receiver-last `send`
whose `with` list holds `...e` builds its arguments as one list and ends in
`send-spread`, `send-spread-wait` or `join-send-spread`, which check the name
against the list's length as `send-named` does.

Tests reconstruct every grammar sketch, Corpus source and stdlib Library,
and pin the first errors in `tools/grammar/broken.talk`. The Disassembly Cases
match byte for byte, including pools, slots, positions,
Unwind Tables and Event Tables; together they emit every declared opcode.
Stdlib sources are generated into Go unchanged and execute as ordinary Libraries.
The shared `stdlib/template-migration` regression checks `${…}` placeholders,
`$$`, literal braces, text keys, value conversion and date widths in `format`,
`formatDate` and `parseDate`, including error fields, caller positions and costs.
All load-diagnostic Trace Cases replay through public `Load`, including
`initialiser failed` at the raising instruction's source-map position.

`it` is a body local. In a Constant or Script Variable initialiser or a
parameter default, each unbound `it` reports `unknown name`, alongside
`not constant` at only the first disallowed token. Handler, function and
Lambda bodies retain their own `it`, including Lambdas created at load.

Raw Text Literals preserve backslashes and placeholders. Backticks decode
escapes and accept nested multiline Interpolation Holes. Both forms support
exact closing margins and physical newline normalization; hole-free forms also
work in literal-only Text positions. Holes retain Constant and Guard
restrictions and lower to ordinary concatenation instructions, with generated
joins mapped to `${`. Invalid closing margins identify the first non-whitespace
source scalar; paired Corpus cases also pin interpolation Fuel and allocation
faults and Segment rollback.

Implicit Script Variable initializers allocate Nothing slots without emitting
stores. Explicit `= nothing` emits its constant and store, as chapter 8 requires.
This keeps canonical code positions aligned with the existing Corpus.

Handler call-graph analysis rejects plain calls to may-suspend Handlers and
function-style calls that could suspend. Grant-aware loading checks Operation
names, modes, argument counts and literal Shapes, including `say`. Decisions
also check `veto` and `pass` reachability before suspension. Imported Handlers
carry their suspension requirement into the caller. Library restrictions reject
Script state and message facilities, including unresolved commands that would
climb a Message Path. Library `wait for`, including Joins, is rejected.
Host Object property Shapes are checked at runtime. Load and Reload use copied
property declarations to reject writes to missing or read-only properties when
the well-known binding and literal key are known. Quoted and parenthesized Text
literals count as known keys; computed keys and local aliases defer to runtime.
Parentheses around a `set` target preserve its literal or computed key and
Object receiver. A bare variable remains `not a property` at `set`, including
when parenthesized. Container paths reject Built-in properties with
`not a container` at the target's first token; quoted/computed keys and property
reads in key, index, delimiter and value expressions remain allowed.
Compilation cache keys include setter availability, so identical source checked
against one Object declaration cannot bypass another declaration’s checks.

## Libraries and Standard Library

`Core.CompileLibrary` checks stateless source with explicit imports and Operation
Declarations. `Library.Imports` and `Needs` return copies; needs include direct,
private, unused and transitive Operation references. Code identity includes source
and dependency identities; the Host version label does not affect it.
`Group.AddLibrary` requires matching dependencies first and atomically refuses
missing or mismatched imports, reused names and reserved stdlib names. Private
names and imported names are never re-exported. Imports are linked by name,
including renames, without copying bodies into callers.

Calls, Constants, defaults and Function Values execute in the calling Script's
Run. Each frame owns its code unit, constant pool and Unwind Table, while Fuel,
allocation, depth, rollback and retained state belong to the caller. Nested
Function Values in shared Library Constants and defaults bind to each caller's
Home without modifying the compiled Library. Imported Handler clauses dispatch
in source order, and waits retain Library frames across Pump calls.

Every Group holds the seven normative Standard Libraries. Their sources are
embedded by `tools/go/generate.ts`; no TS implementation is imported. Catalogue
errors from stdlib code name the nearest call in user code, while user
Library errors retain the Library location. Reviewed traces pin ordinary calls,
Function metadata, registration, faults, unwind charges and stdlib caller errors.

The trusted stdlib loader alone lowers private `map:restrictedCall` to
`call-restricted`. Its inherited frame restriction rejects live Script state,
Host effects and recovery-context access before acting, and survives catches,
cleanup, preemption and restore. Host Library compilation cannot enable it.
Snapshot format `go/7` rejects earlier formats. The `map.transform` Library export uses this boundary for callbacks; no
public pure-call API is available. See [the normative contract](../../spec/08-the-abstract-machine-and-the-cost-model.md#restricted-stdlib-callbacks)
and [the cross-Core kit](../../corpus/restricted-kit/README.md).

`map.transform` implements ordered, presence-aware Mappings from the shared
normative Library source, including wildcard/default/skip selection, complete
Shape checks, definition validation before callbacks and complete output or
ordered diagnostics. Limit Faults escape. The [contract](../../spec/07-libraries-and-the-standard-library.md#checked-mappings)
fixes definition precedence and concrete source locations; the `stdlib/mappings*`
Corpus cases cover behavior, sliced restore and resource exhaustion.

Each Library compiles once per process, after its own `use` dependencies, the
first time a Script, Library or restored save in any Group names it. A Group
holds only the Standard Libraries it has used, and each WASI instance pays only
for those. Library compilation reuses one compact syntax
tree for dependency discovery, code identity, checks, lowering and metadata,
without retaining the tooling token tape. The cold-compilation benchmark is
`go test . -run '^$' -bench BenchmarkColdStandardLibraries -benchmem`.

Library calls to immediate, suspending and fire-and-forget Operations use the
caller's named Grant, Host binding and charge/settlement path. Loading and Reload
recheck every original Library call against the caller's modes, arity and literal
Shapes, including private, unused and transitive uses. Missing Operations report
one `missing grant` per distinct Operation at each `use` line; messages name the
first original site in direct source order followed by import order. Shared
diamond call sites are checked once per `use` line. `GrantsAsUsed` retains all
Library needs. Revocation, cancellation cleanup and late answers belong to the
caller Run, and a rejected Reload preserves pending calls.

Library frames, closures and imported constants survive full Group snapshots.
`ReplaceLibrary` recompiles transitive dependents and reloads affected Scripts
only after every dependent validates and all old effects clean up successfully.
Library Constants are shared fixed overhead, outside Script Persistent State.

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

## Machine execution

`machine.Initialize` evaluates initializers without Run charges.
`InitializeBound` supplies Home identity before creating Function Values.
`StartDelivery` tries arity-compatible Handler Clauses in source order; local
Handler calls use the same clause-failure rules. `Run.Execute` returns between
instructions on preemption, keeping frames, locals, stacks and unwind state as
plain data. It uses no saved Go callback or goroutine continuation.

Standalone execution covers chapter 3/4 arithmetic, Quantities and dates,
conversions, folded structural comparison, containers and writes, snapshot
iteration, branches, loops, catch/finally, binary construction/destructuring,
Text Patterns and replacement, and non-suspending local Function Values with
captures and named defaults. The Built-ins include number functions, IEEE float
codecs, pinned case mapping, date fields and fixed-offset conversion, and Function
Value metadata, plus `objectKind`, `isDisposed` and Core-held Object ids.

The `items` Built-in property returns a list unchanged, splits text, and
materializes integer ranges. Unsupported subjects raise `wrong kind` with
`expected` `"list"`. The `text-model/items-property` Trace Case protects the
results, error fields and costs in ordinary and save/restore replay; its first
human blessing remains pending (#565).

Generated Cost Model 0 charges precede committed instruction changes. Fuel,
allocation, depth and dynamic Pattern Size faults leave the faulting instruction
uncharged and restore Script Variables to the Segment's starting snapshot. Range
materialization and padding have budget preflights before construction.
Persistent State counts variables, mailboxes and retained Run frames; a final
return checks the state that will remain. Cancellation runs finally cleanup
under its separate Cleanup Budget. Execution tests cover each chapter area and
pin the text-model fixtures' Fuel, allocation, positions and final variables.

Standalone sends and foreign Function Value calls without a Group adapter,
unlinked imported calls and standalone Object property calls without a Host
adapter stop at a
`Blocked` implementation boundary with the instruction and operands
untouched and no charge for that instruction. The pending Run remains visible
and a Request remains unsettled. A Decision remains open if it has not sealed
before that boundary. Group cancellation and Stop Script are supported as described
below. Segment-bound lifecycle is supported through participant hooks.
Snapshots retain preempted and suspended Runs, including their rollback bases.

## Save, restore and code updates

Public Run accounting is returned by Pump, Reload, Library replacement and Restore.
Dispatch/discard events precede cumulative Fuel and causal queue counts; observation
charges, detached sends and error Handlers are included without adding Trace records.

`Group.Save` returns opaque `go/5` bytes for a Quiescent Group. It retains the
Clock, sources and extensions, heap Values and closures, frames and rollback
bases, dispatch contexts and activations, owner identities, pending transfers,
cleanup progress and attempt counters, budgets and slice debt, ordered work and input queues, pending replies,
Decisions and Broadcasts, causal ancestry and accounting order, Objects and Grant state. It never starts work, drains
inputs or calls Host cleanup. Live scopes or participants, including unresolved
external effect state, refuse Save with `effects pending`.

`Core.Restore` rebuilds code and checks the saved Group Fingerprint against
current language/cost versions, Library identities, Grant declarations and
limits. Saves are specific to the Go Core family and format; corrupt or
unreadable bytes return `invalid save`. Formats `go/1` to `go/4` are no longer readable. Format `go/5` keeps stale
Function Values' names, arities and Declaration Documentation, and requires
causal accounting state as well as transfer references to belong to surviving dispatch contexts,
including after cancellation. Restore validates retained and active code/body/PC
references, shared owner-local layouts, phases, action arguments, cleanup tables
and acyclic ownership before rebuilding aliases. Native Object bindings, Host functions,
lifecycle hooks and Host futures are supplied again rather than serialized.
Missing Grant bindings become revoked; unresolved Objects become disposed.

A full restore returns pending Capability calls by Script, Run and call order.
Before its first accepted Pump, `Group.Settle` selects exactly one of `Answer`,
`Fail`, `Reissue` or `Adopt` for each id. Reissue calls the rebound Host
implementation with the original id and arguments, charges only additional Host
Fuel, and keeps the original deadline. Adopt returns a new Call into the restored
Group. Unsettled calls fail as `call lost` before due Timers on that first Pump.
Old Calls and Request/Decision futures still belong to the original Group.

`VariablesOnly` handles a readable mismatched save by carrying Script Variables
by name from the prospective rollback view. It preserves counters, Objects,
limits and revoked/disabled Grants, while discarding Runs, messages, Broadcasts
and slice debt without `finally`. It lists discarded work and abandoned calls;
open Decisions report `undecided` on the first Pump. Carried Function Values from
the replaced Script code are stale.

`Script.Extend` validates a new Entry against existing names and unrevoked
Grants. It appends new code, definitions and initialized variables atomically,
checking the Persistent State cap first. Existing frames, queues, Function
Values and code bindings remain live. Extension source order and identities
participate in the Script identity and Group Fingerprint. Reload and Library
replacement validate the complete replacement before stopping old work; failed
validation leaves existing execution intact.

## Text Patterns

`internal/machine/pattern.go` compiles chapter 8's normative Pike VM programs
and matches whole Characters using the pinned Unicode tables. Matching keeps
threads in priority order and charges every visited list's thread count,
including discarded empty searches. Boolean searches stop at the first
accepted match; Match Searches retain the preferred match, converted Captures
and their Character ranges. `lazily` changes only its element's own repetitions.

Composition accepts Text and Text Patterns, preserves spliced Captures and
rejects duplicate names or Captures inside repetitions. Canonical source
omits empty nested groups and separates a leading group with `< <`.
`make-pattern` uses the resulting program size for its Fuel and allocation;
loading and initializers remain uncharged. Literal size checks count every
copy of the singular class and emit no code for a zero count.

The step-2 acceptance test runs all eight reviewed `corpus/text-patterns/`
cases through the public embedding API and protects their passing-list entries.
Additional tests pin normative programs, composition errors, conversions,
absent Captures and compilation charges. Three new regression cases for empty
literals, counted program sizes and wrong-kind splices agree on both Cores;
their first blessings were approved on 2026-10-07 ([approval record](../../docs/reviews/milestone-one-blessings/README.md)).

`matching-fuel-exhaustion` and `pattern-size-made-at-run-time` pass with exact
exhaustion instructions, uncharged failing work and Segment rollback. A separate
step-4 gate protects the Text Pattern limits alongside all limit and cancellation
cases.
`pattern-size-literal-limit` also passes through Reload and snapshot replay.

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

**Metering support:** the [incremental metering contract](../../spec/embedding/metered-operations.md) is specified but not implemented here. Callback-time `Charge` remains the available interface; queued charge requests, metering declaration validation, the new Trace records and metered-call Save restrictions are unsupported. SQLite factories that exist here still use up-front `max × perRow` charging. The [Zig Core](../zig/README.md#the-machine) implements the staged contract with Zig-only acceptance tests; the shared executable catalogues remain staged. See [#472](https://github.com/odogono/odgn-talk/issues/472).

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

`Core.SqliteCapability(SqliteImpl, Costs, perRow)` supplies the optional
`sqlite` Operations (ADR 0070): immediate `query sql, params [, max]` and
Segment-bound `change`, plus `begin`, `commit` and `rollback`, which open and
close the `transaction` scope. Each binding must be a `SqliteBinding`; the
factory maps it to `impl.Coordinator(database)` when the Grant is created, so
every Grant on one database shares a participant. A binding of another type, or
with `MaxRows` outside 0 to 2^53−1, is refused there. After the Shape checks,
uncharged argument checks give `out of range` for a `max` that isn't a whole
number up to `MaxRows`, and `wrong kind` for `params` that isn't a list or map
or holds a value outside nothing, number, text, bytes and boolean. The call then
charges `max × perRow`, saturating at 2^53−1, before calling the Host with
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
binding holds the failed message before Guard tests and survives clause skips,
local calls and preemption. An unmatched internal error never reports `unhandled`,
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
go run ./cmd/corpus --list
go run ./cmd/corpus
go run ./cmd/corpus text-model/chunk-write-padding
go run ./cmd/corpus --check-passing
```

`--check-passing` runs the complete Corpus and fails on any case that does not
pass, listed or not, and on a listed case that no longer exists. Each failure
ends with a `reproduce:` command. The list contains 307 cases, including all text-model, load-diagnostic,
Disassembly and Value Encoding acceptance cases, plus reviewed scheduling,
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
