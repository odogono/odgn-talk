# Host Inputs during paused Message Layer crossings

Proposed contract for [#884](https://github.com/odogono/odgn-talk/issues/884),
prepared against `0aed90d300069ae754ba7dab010f3ef4d92141e7` on 2026-10-15.
This is a design for review, not an approved extension or a claim of runtime
support. [Chapter 9](../09-embedding.md#the-message-layer) remains the current
contract. Commit and accept this design before downstream implementation;
record that revision in #884's implementation handoff.

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

## Proposed exchange rules

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
reply carries its remaining records, reports, accounting and abandoned-call
notifications once, after all needs are answered. Joining its Trace with any
intervening replies in receipt order must reproduce native Trace order without
duplicates or missing records.

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

First commit the accepted contract and update chapter 9's “answer before sending
anything else” and outbox wording to reference the exception. No new grammar,
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

- **Implemented in:** investigation PR #921, merged as `c49f544c`; the reactor
  switch #918, merged as `667458bc`, is separate. Metered Operations and
  `request-charge` in Zig landed in #920 (`f6477343`). None supplies this proposal.
- **Required base:** `0aed90d300069ae754ba7dab010f3ef4d92141e7` contains those
  changes. This design is proposed on branch `fix/issue-884`: target contract
  `spec/embedding/paused-crossing-inputs.md`, supporting audit
  `docs/research/paused-crossing-input-audit.md`, and discovery link/status in
  `docs/research/go-zig-binding.md`. The proposal's commit is not design
  acceptance. Record the accepted specification commit here and in #884 before
  handing implementation to another agent.
- **Remaining work:** accept/commit the design, reconcile chapter 9, implement
  applicable transports and native landing corrections, pass the cases above,
  then replace the embedded probe's blocker test. The crossing gate is still
  blocked until that evidence passes.
- **Approval still needed:** protocol design acceptance; no expectation files
  await first blessing in this change. Go retirement and numerical performance
  limits remain unapproved.
