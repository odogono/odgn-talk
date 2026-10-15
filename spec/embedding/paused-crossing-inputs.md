# Host Inputs during paused Message Layer crossings

Contract for [#884](https://github.com/odogono/odgn-talk/issues/884), designed in
[#958](https://github.com/odogono/odgn-talk/pull/958), specification commit
`463f78dbcd687a24da5219bd24629c0764423fe2`, and accepted for implementation by the
maintainer on 2026-10-15. This extends
[chapter 9](../09-embedding.md#the-message-layer); the implementation guides
state each transport's supported embedding messages. It does not authorize Go
Core retirement or approve performance limits.

## Purpose and boundary

Make the Message Layer capable of preserving queued calls made inside a native
Host callback. In particular, a Go Operation that queues Stop and returns a
value must be able to do the same through the Zig reactor, rolling back the
current Segment rather than committing it before Stop arrives. The
[investigation](../../docs/research/go-zig-binding.md#first-gate-stop-inside-a-host-callback)
demonstrates why an outbox drained after the Pump is insufficient.

Keep Host-initiated exchanges, serialized frames and matching result messages.
No WASM import calls back into Go, and no additional Script execution happens
while the callback remains outstanding. This design does not authorize a
production Go binding, alternative ABI, performance limits or Go Core retirement.

## Exchange rules

An interim `op`, `prop`, `effect` or `release` keeps its enclosing worker exchange
open until its matching result arrives. The Session retains the worker's Group,
ref, need kind and continuation throughout the pause, including pauses during
Reload or library replacement. The embedding reentry guard remains active even
when the WASM export has returned to the Host.

Before answering that need, the Host may send the following ordinary messages
to the **same Group**, each under a ref distinct from the enclosing worker ref:

- Queued calls: `deliver`, `request`, `broadcast`, `decide`, `call`, `set-parent`,
  `dispose`, `stop`, `cancel-run`, `rewind-run`, `revoke`, `answer`, `fail`,
  `cancel-delivery`, `request-charge` and `settle`.
- `object`, which makes or finds a Group-owned handle immediately under the
  existing Object rules. This is not a queued Host Input.

The list describes the target interface. It does not claim every Core already
implements every message, notably Metered Operations in Go. `settle` retains
its existing before-first-Pump restriction: permitting dispatch does not make
it legal after that boundary. A callback cannot reset that restriction.

Each admitted message receives its own ordinary final `ok` or `err` reply.
Successful enqueue assigns ids and reserves mailbox capacity immediately, as
the native API does. Validate values, ownership, targets, limits, call eligibility
and any other admission facts at receipt; do not report enqueue success for a
message merely held as raw JSON for later validation. Enqueue success does not
mean that input has executed. Refusal preserves the outstanding need and does
not consume an id or capacity that the ordinary refused call would not consume.

Only the matching result kind under the enclosing worker ref resumes the
continuation. Other result kinds, a result under another ref, use of the reserved
worker ref for a new input, a different Group, and messages outside the allowlist
are protocol errors which leave the exchange intact. A well-formed worker call
addressed to the paused Group is instead Host Error `reentrant call`, matching
the native API; it executes nothing. Core definition/registration changes and
work on another Group remain excluded while a Session has an exchange open.
They require another Session. A `resolve` need during Restore still accepts
only its matching `resolve-result`; no restored Group is exposed midway through
resolution. These rules preserve one active worker exchange per Session.

Keep protocol version 1: existing Hosts that immediately answer every need keep
their existing conversation. Extend `hello`'s reply with optional `features`, an
array of text names. Advertise `paused-inputs-v1` only when the implementation
supports this admission and continuation contract for its supported messages.
An absent name means unsupported; a binding must check it before relying on
paused admission. The marker does not promise implementation of other missing
embedding features. The version-matched artifact remains independently required.

Frames remain serialized: a binding must use one conversation owner and arrange
callback and concurrent goroutine inputs in a single receipt order. A mutex
around individual exports alone cannot enforce a complete conversation. A
callback must not wait for a queued future that needs this or a later Pump to
finish. Transport ref values and Core-assigned delivery/call/request ids remain
distinct.

## Admission, Trace and landing

Preserve [the input queue rules](../09-embedding.md#threads-and-the-input-queue).
The active Pump retains its original Clock, input batch, Fuel Slice and cap;
resuming it neither takes a second Clock nor emits a second `pump` record.

`stop`, `cancel-run` and `rewind-run` received during a paused Pump join its
crossing-control queue in receipt order. On the matching result they land at
that crossing under the existing control rules. Ordinary inputs retain their
own receipt order for the next Pump. A later Stop may land before an earlier
ordinary Delivery is drained; this is the existing queue distinction, not
permission to run the Delivery during the callback. In particular:

- `dispose` waits for the next Pump; stopping its owner's Runs happens when
  disposal drains, with reason `owner disposed`.
- `cancel-delivery` waits for the next Pump, including cancellation through a
  Request/Decide/Call context. It is distinct from `cancel-run` landing at a
  crossing.
- `answer`, `fail` and `request-charge` enqueue only. They cannot resume another
  Run, authorize work or return charge outcomes inside the paused callback.
- Inputs made during Reload or library replacement remain queued for a later
  Pump, including Stop/cancel/rewind. Lifecycle finalization is not a Pump.

The callback's `call` or `prop` record precedes control and refusal records
produced by that callback. Hold these records until the callback result is
recorded; do not flush them into intervening enqueue replies. Inputs normally
recorded on the next Pump stay there. Admission replies carry only records
that the ordinary call can publish at that boundary. The enclosing worker
reply carries its remaining records, reports and accounting after all needs are
answered. Joining its Trace with intervening replies in receipt order must
reproduce native Trace order without duplicates. Abandoned-call notification
has the opt-in timing below.

### Abandonment before a subsequent callback

A native Host's Call context is cancelled when the Core abandons the Call,
before a later Host callback observes it. Final-reply-only notification cannot
preserve that observation when an intervening Operation, property, cleanup hook
or Grant release runs first. A callback which waits for abandoned work to stop
must receive its cancellation signal before it is invoked.

Advertise `abandoned-before-needs-v1` in `hello.features` when supported. A Host
opts in by sending `hello` with `features: ["abandoned-before-needs-v1"]` and
checking that the reply advertises it. This enables the timing for the Session's
remaining lifetime; a later `hello` without the field does not disable it.
`features` in a request must be an array of supported feature names; malformed
or unsupported entries are protocol errors and enable none of that request's
features. `paused-inputs-v1` may also be requested, with its existing behavior.
All feature validation precedes activation.

After opt-in, an interim worker reply carries `abandoned` at its outer level,
alongside `ref` and `need`, before the Host services that need:

```json
{"ref": 8, "need": {"m": "release", "script": "s", "grant": "api", "reason": "stop", "now": "2026-10-15T12:00:00Z"}, "abandoned": ["s/r1.c1"]}
```

This applies to `op`, `prop`, `effect` and `release` needs from Pump, Reload and
Library replacement. It lists actual Core abandonments in Call order, once
across the worker's replies. Final success replies retain `ok.abandoned` for
notices not already emitted; final worker errors carry them at the outer level.
The Host processes notices before invoking a callback or completing the worker.
A refused or malformed result preserves the open need and does not repeat a
notice already emitted.

Attach notices to the reply actually sent: if Grant releases precede a held
need or final reply, the first release receives the outstanding notices. Building
a held reply must not consume them. Do not infer cancellation at input admission,
resume execution, or publish unfinished Trace or Reports to send a notice.

Hosts which do not opt in keep the existing final-success-reply timing and need
shapes. Their final `ok.abandoned` still lists every unreported abandonment.
This preserves protocol 1 Hosts which immediately answer needs and only process
abandonment from final replies. A public Go adapter requiring native callback
cancellation ordering must opt in as well as check the version-matched artifact.

## Result and lifecycle order

Admitting an interrupt never discards the outstanding need or completes its
worker early. The Host must still return the callback result. This preserves
the callback's recorded outcome and the
[acquisition/closure acknowledgement rules](scoped-effects.md#scope-ownership-and-calls).
Apply lifecycle success acknowledgements before observing queued controls,
including a successful opener whose returned value is invalid.

Distinguish malformed transport from a bad Host return. Malformed JSON, a wrong
result ref or a wrong result kind is a recoverable protocol error with the need
still outstanding. A matching callback return with a well-formed envelope but
an invalid result/failure is classified under the existing Host-result rules.
Record the callback outcome, land queued controls, then perform declaration
validation, result conversion and failure reporting only if the Run was not
interrupted. Do not let a wrong Shape, invalid failure data, Host failure or
property failure bypass landing. Operations executed during cancellation's
`finally` cleanup still convert and report failures under the existing rules.
Preserve the existing latched Charge-refusal behavior and accepted Fuel prefix;
this design creates no new Stop-versus-Limit precedence.

During `effect`, automatic abandonment `op`, and `release` needs, admit the same
queued inputs while preserving their existing finalization boundary. A Stop or
cancellation queued by successful commit cannot interrupt that commit midway.
Continue acquisition/closure, abandonment, rollback and release exchanges in
their prescribed order, returning final reports only when cleanup completes.
Malformed lifecycle returns retain the existing failure/unknown semantics;
they are not interchangeable with retryable JSON/ref/kind errors. Fatal effect
uncertainty still stops the Group and prevents code replacement.

A release hook must remain a logical callback boundary. If a reactor buffers
release notifications, it must yield them before any continuation that native
callback inputs could affect, and retain that continuation until `release-result`.
Returning buffered notifications only after later Script execution has already
occurred cannot satisfy this contract.

## Starting a suspending Call

A suspending `op` exposes its Call id before receiving `op-result: started`.
Native Go `Start` may queue `Call.Answer` or `Call.Fail` before returning, and a
Metered Operation may queue `RequestCharge` during its starting callback.
Preserve the issued id, declaration, Group ownership and metering eligibility
across the pause so these calls receive native-equivalent admission outcomes.
Retain only Go/transport-owned copies of reply buffers after subsequent exports.

Do not mark the Call as durably pending or process its queued settlement merely
to admit those inputs. `started` establishes the pending call through the normal
callback-return path. A Stop that then abandons it must publish abandonment
exactly once; a queued answer/failure later receives ordinary late-answer
handling. A charge request for an issued eligible call that has ended receives
`inactive` on a later Pump. Restore's reissued Operations obey the same rules,
including the already-closed settlement gate once the first Pump has started.

## Acceptance and delivery

Chapter 9 references this exception to its exclusive callback exchange. No new grammar,
instruction, Host error code or Trace record is proposed. Keep Data Files and
expectations unchanged until implementation and any required first blessing.

Implement Zig reactor support and the applicable Go native sidecar support
together or as explicitly linked stages. Keep TS/native Go as comparison
backends. Native Zig result-landing changes require their own tracked acceptance
if discovered during this work; opening the transport dispatcher alone is
insufficient. Do not claim absent Metered Operation support in Go is supplied by
this change.

Required tests compare state, exact Trace, Reports, Fuel/allocation, accounting
and abandoned calls where applicable:

1. Replace the probe's Stop-blocker characterization with passing native-Go vs
   embedded-Zig parity: callback Stop leaves `n=0`, not `8`, without a smaller
   Fuel Slice. Cover immediate and suspending Operations, property get and set,
   and matching returns with valid values, wrong Shapes and Host failures.
2. Cover CancelRun, first-Segment RewindRun and non-rewindable Runs; cancellation
   cleanup still executes/converts normally. Check Stop reason/order and Run
   accounting, Decision settlement, rollback and exact pending-call abandonment.
3. Interleave multiple admitted inputs and refusals. Check immediate mailbox
   admission/id allocation; ordinary Deliver/Answer/Dispose/cancel-delivery wait
   until the next Pump, while crossing controls land at the current boundary.
4. Queue Answer/Fail and eligible RequestCharge during Start, before `started`.
   Check normal settlement, Stop followed by late answer, charge eligibility,
   overlap refusal and later `inactive`; repeat through restored-call Reissue.
5. Queue inputs in begin/commit/rollback, successful/failed scope opener/closer,
   automatic abandonment and release, including Reload/library replacement.
   Check success acknowledgement before interruption, indivisible commit,
   malformed lifecycle failure and fatal uncertainty without duplicate cleanup.
6. Reject worker reentry, wrong Group/ref/kind and malformed frames, then accept
   the correct result and reuse the Session. Confirm a second Session progresses
   independently. Race-check serialized concurrent Go producers and retained
   reply ownership across guest memory growth.

Rebuild the embedded artifact from a committed runtime revision, retain its
manifest, and rerun probe checks with `CGO_ENABLED=0` plus race checks. Historical
measurements remain tied to the old artifact; do not silently reuse them for
the new one. A passing crossing gate permits evaluating #884's later compatibility
criteria. Platform execution, full binding/API/corpus compatibility and explicit
performance acceptance remain separate gates.

## Implementation handoff

- **Implemented in:** design #958 and crossing implementation #964/#966 are
  merged; #971 merged as `e9b8aa570a6587018c7e79ac9875c7e579f1a4e8` and adds
  the focused callback parity gate plus four-platform embedded-probe execution.
  #972's opt-in abandonment timing merged in #973 (`ee6240d4`). #977
  (`12c56beb`) adds the initial public data/Request adapter. #978 adds the public
  Capability bridge and the Operation Trace observation extension below; its
  Zig corrections are separately tracked in #979 and #980.
- **Required base:** #977 merge or a descendant, chapter 9 input queue/Message
  Layer rules and chapter 6 cancellation/Stop. Rebuild the probe from the
  committed implementation source revision recorded in its manifest.
- **Remaining work:** review/accept #978's additive Operation observation
  contract and public Capability adapter. #884 retains full binding/API/Corpus,
  facilities, arbitrary Trace-sink timing, non-yielding admission and performance
  gates. Focused probe execution
  passed on Linux/macOS amd64/arm64 in #971; this does not establish full public
  Go API or application compatibility.
- **Approval still needed:** #978's Operation Trace observation and settlement
  notification contract needs review with its implementation. No expectation
  files await first blessing. Full Go retirement requires separately accepted
  numerical limits and evidence.

## Operation Trace observation at a paused crossing

The optional `crossing-trace-v1` feature adds an acknowledgement boundary for
Hosts whose Trace sink queues inputs in response to an Operation's `call`
record. A Host opts in through `hello.features` and checks the advertised name.
Without opt-in, the existing protocol-1 reply shapes and timing remain intact.

For a traced Group, Operation needs carry an outer `trace` array containing
records already produced before that callback. After a matching `op-result`,
the worker records the outcome, installs any started Call, and yields
`{"ref": n, "need": {"m": "trace"}, "trace": [ ... ]}` before landing
crossing controls or converting the result. The Host invokes its Trace sink
in array order, then replies `{"m": "trace-result", "ref": n}`. The same
paused-input allowlist and reserved worker ref rules apply. Wrong results keep
the observation open. The continuation retains the original Clock, Fuel,
operands and callback outcome; acknowledgement must never invoke the Operation
again or duplicate a `call` record. Pending abandonment notices still precede
Host code. Inputs generated by the sink land at the same crossing as inputs
generated by the Operation callback.

Refusal records made inside the callback follow its `call` record. With opt-in,
ordinary Host-error and Load-error replies carry their available Trace in an
outer `trace` array, so the Host can publish the error's records before returning
the error. Each record is consumed once across outer arrays and final
`ok.trace`; pending held callback records are never drained by an admission
reply. `answer` also accepts optional `fuel`, a nonnegative safe integer, for
`AnswerWithCost`; omission means zero. It charges on resumption with conversion.

This extension covers ordinary immediate and suspending Operations. It does
not advertise per-record suspension during arbitrary Script execution, property
or lifecycle observation, or input admission while a WASM export has not yielded.
A sink reacting to other records can still observe a later transport boundary;
full Trace-sink and non-yielding concurrent-input compatibility remain #884
gates. The contract and its implementation require review together in #978;
there are no changed Data Files or expectation blessings.

The public-adapter comparisons also track Zig corrections in #979: settlement
Fuel already specified by chapter 9, Capability definition identity in typed
`CallFailed`, and cancellation when a queued settlement's Run is discarded
before resumption. Admission of Answer/Fail alone does not end the Host's
cancellation observation; normal consumption does. A discarded already-settled
Call needs cancellation without a second `abandon` Trace record.

For `crossing-trace-v1` Hosts, the same success/need/error envelopes that carry
`abandoned` also carry `settled`: started Calls whose queued settlement has
actually been consumed by their Run, listed once. The Host may then drop its
cancellation registry entry without cancelling the public Context. Admission of
Answer/Fail, or a Pump that leaves the ready Run sliced, is insufficient. If that
Run is discarded first, its id appears in `abandoned` instead. Process both lists
before invoking any following callback. This keeps cancellation correct across
Fuel-cap preemption without retaining every completed Call for the Group's life.
