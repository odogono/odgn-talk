# Paused-crossing Host Input audit

Local primary-source audit for [#884](https://github.com/odogono/odgn-talk/issues/884),
2026-10-15, against `0aed90d300069ae754ba7dab010f3ef4d92141e7`.
This is evidence and a proposed compatibility contract, not an approved protocol
change or an implementation. The Go Core remains; this audit makes no retirement
or performance claim.

## Established contract and blocker

[Threads and the input queue](../../spec/09-embedding.md#threads-and-the-input-queue)
allows callback-generated queued calls, assigns admission errors synchronously,
and reserves current-Pump landing for Stop, CancelRun and RewindRun. Other queued
inputs wait for the next Pump. Both the [Go dispatcher](https://github.com/odogono/odgn-talk/blob/0aed90d300069ae754ba7dab010f3ef4d92141e7/impl/go/internal/messagelayer/session.go)
and [Zig dispatcher, `handle`](../../impl/zig/src/message.zig) instead accept only
the outstanding need's matching result while paused. This implements the
[Message Layer](../../spec/09-embedding.md#the-message-layer) instruction to answer
before sending anything else, but prevents preserving native callback behavior.
The rule needs an explicit exception for admission while a need remains open.

## Proposed exact admission boundary

The following is a design recommendation derived from the existing queued-call
list, not evidence that these frames already work while paused:

- Admit `deliver`, `request`, `broadcast`, `decide` (including its broadcast form),
  `call`, `set-parent`, `dispose`, `stop`, `cancel-run`, `rewind-run`, `revoke`,
  `answer`, `fail`, `request-charge`, `settle`, and `cancel-delivery`.
- Also permit `object`, because native `Object`/`ObjectByID` are explicitly safe
  inside a Pump and create/find the handle immediately. `ScriptNames` is another
  safe native helper, with no Host Input or Trace record; the current message
  catalogue has no equivalent. Do not accidentally replace it with worker
  inspection. These exceptions are distinct from draining queued inputs.
- Keep the initiating worker's ref reserved. Each admitted callback frame needs
  its own ref and immediate admission reply, without replacing the held worker
  ref, consuming its need, running Script code, or advancing Clock, slice or cap.
  A mismatched/stray result, malformed frame, unknown Group or forbidden worker
  call must leave the exchange recoverable. Define same-Group admission first;
  cross-Group interleaving is a separate Session policy, not needed to solve this
  blocker.
- Permit admission during ordinary `op`/`prop`, automatic abandonment `op`,
  `effect`, and `release` needs, including lifecycle work initiated by Reload or
  replacement. This follows the native callback permission in chapter 9.
  `resolve` is a restore resolver, not one of those execution/lifecycle
  callbacks: retain its exclusive handshake unless separately specified.

The [message catalogue](../../spec/09-embedding.md#messages) supplies these frame
names; the native [worker/reentry rules](../../spec/09-embedding.md#threads-and-the-input-queue)
exclude Pump, Load, Reload, Extend, AddLibrary, ReplaceLibrary, Save, Fingerprint,
Inspect, Grants and Counters. Definitions, new Groups and restore are not
automatically safe merely because they are transport messages.

`settle` retains its existing restored-call eligibility restriction. The current
Zig [C implementation, `talk_settle`](../../impl/zig/src/talk.zig), calls
`checkWorker`, although the Spec classifies Settle as queued; routing a paused
frame through that function unchanged would not establish callback parity.
The Go Message Layer also lacks several catalogue handlers, including Call,
Decide, Restore/Settle, and request-charge; [its handler table](https://github.com/odogono/odgn-talk/blob/0aed90d300069ae754ba7dab010f3ef4d92141e7/impl/go/internal/messagelayer/handlers.go)
must be treated as an implementation subset, not as the normative allowlist.
Zig currently has `requestChargeReply`; Go has no RequestCharge implementation in
this revision. That missing feature remains a distinct gate.

## Admission, ordering and the starting Call

Native [Go admission](../../impl/go/group.go) validates arguments, Group ownership,
limit overrides and mailbox reservations before appending; id/acknowledgement and
`mailbox full` cannot be delayed into an outbox until the Pump completes. The
Spec's “received means read” rule permits transport queuing but cannot preserve a
synchronous Go callback's return value if the adapter never submits its call.

Admission order and execution order differ deliberately. Native
[`landControls`](../../impl/go/group_cancel_run.go) extracts Stop, CancelRun,
RewindRun and refused-input records from the input queue in their relative order;
ordinary settlements and Deliveries remain for the next Pump. Thus an earlier
Delivery may be admitted before a Stop, while the Stop lands in the current Pump
and the Delivery drains in the following Pump. Do not drain the whole new queue
on resume. Preserve input/refusal Trace ordering after the crossing record, with
each record emitted once, even if admission acknowledgement arrives first.

There is an additional starting-Call problem, independent of dispatch admission:

- Native [`Call.Answer`/`Fail`](../../impl/go/capability.go) append settlements
  during Start, before [pending-call installation](../../impl/go/group_operation.go).
  [`TestSuspendingOperationQueuesAnAnswerDuringStart`](../../impl/go/suspending_capability_test.go)
  proves that the first Pump suspends and only the next Pump consumes that answer.
- Zig [`operation` in `machine.zig`](../../impl/zig/src/machine/machine.zig)
  registers the id and metering eligibility before entering the Host, but its
  `.deferred` branch unregisters the id, removes and destroys the suspending Call,
  and decrements the call counter before exposing the need. The instruction is
  remade on resume with the same id.
- Zig [`settleReply`](../../impl/zig/src/message.zig) locates `answer`/`fail`
  targets in `group.calls`; `requestCharge` checks `issued_calls`. Consequently,
  merely bypassing `handle`'s paused guard still rejects the currently starting
  suspending Call.

Recommendation: retain a provisional starting-call identity and its eligibility
across the transport pause. Allow Answer/Fail admission against it without
publishing suspension or processing a result. For eligible read-only suspending
Operations, RequestCharge admission must retain its eligibility and FIFO order;
the future outcome is still a later-Pump report. Local `charged` in op-result is
a separate synchronous Charge mechanism. On a failed Start, Stop, Rewind or
refusal, provisional state must be disposed once and queued settlements handled
as late/inactive according to their respective contracts. Automatic abandonment
must still reject settlements and charging. These restrictions follow the
[metering contract](../../spec/embedding/metered-operations.md) and
[automatic-abandonment contract](../../spec/embedding/scoped-effects.md#automatic-abandonment).

## Landing, results and lifecycle risks

Native [`crossHost`](../../impl/go/group_crossing.go) invokes the Host, prepares
its Trace result, records the crossing, lands controls, then classifies failures
and charges conversion. A newly interrupted Run skips classification; an
already-cancelling Run's cleanup callbacks still classify normally. Result
preparation is not the same as Script conversion. Scope acquisition/closure is
acknowledged before observing Stop/cancellation, including a successful Host
return with a malformed result ([lifecycle acknowledgement](../../spec/embedding/scoped-effects.md#scope-ownership-and-calls)).

Zig [`resumePump`/`queueLanding`](../../impl/zig/src/machine/machine.zig) require
more than a dispatcher allowlist: `pumpWith`/`resumePump` set `pumping=false` on
return to the transport, while queueLanding uses that flag to select current-Pump
landing versus next-Pump inputs. Maintain logical worker/callback state across
the pause without enabling worker reentry. Its current wrong-Shape Operation
result branch and wrong-Shape/generic broken property branches also bypass
`landedAt`; the normal Operation `.broken` branch does call it. These are concrete
parity risks to test, not a claim of an independently reproduced Zig defect.

Stop rolls back the Segment, abandons pending calls/scopes and participant, runs
no finally, and is sticky. CancelRun rolls back then runs finally on its Cleanup
Budget. Rewind rolls back without finally, retains delivery/reply/path identity,
requeues at the head and returns `rewound` immediately; it cannot rewind past a
Suspension Point. See [chapter 6](../../spec/06-errors-and-limits.md#cancellation-and-stop)
and [chapter 9](../../spec/09-embedding.md#threads-and-the-input-queue).
`dispose` and `cancel-delivery` do **not** gain crossing-time landing: native
Go's extraction excludes both, and Zig [`dispose`/`cancelDeliveryInput`](../../impl/zig/src/machine/machine.zig)
enqueue them normally. Disposal stops an owner with reason `owner disposed` in
the Pump that drains it, not at the callback's return merely because Stop would.

[Finalization](../../spec/embedding/scoped-effects.md#segment-participant) is
indivisible with respect to queued inputs: Stop from a successful commit is
observed after finalization. Admission during effect/automatic cleanup must not
interrupt or restart cleanup. Preserve abandon → rollback → Grant release →
report/execution ordering, fatal `effect state unknown`, and idempotent release.

Zig's [`releaseHook`/`holdForReleases`](../../impl/zig/src/message.zig) buffers
release notifications and holds a reply that can already contain another need.
Go's [release hook](https://github.com/odogono/odgn-talk/blob/0aed90d300069ae754ba7dab010f3ef4d92141e7/impl/go/internal/messagelayer/release.go) blocks its
worker on `release-result`. Before claiming native parity, test that a callback
input generated by release is admitted before any later relevant execution;
merely acknowledging buffered notifications after execution cannot establish
that timing. Nested cleanup needs, held replies, deferred answer Values and
provisional Calls need explicit ownership and exactly-once disposal.

## Concrete proposed parity tests

Run equivalent native-Go callbacks and serialized Message Layer exchanges; check
Trace, ordered reports, state, Fuel/allocation and number of callback executions:

1. Issue #884's Stop from immediate op, then equivalent getter/setter and
   fire-and-forget crossings: provisional `n=9` rolls back to `0`; no finally or
   result-conversion allocation. Stop reason stays first; repeated Stop is inert.
2. Native [Operation failure matrix](../../impl/go/operation_interruption_test.go)
   and [property failure matrix](../../impl/go/object_property_test.go): Stop and
   CancelRun with panic/Host error, wrong result Shape, malformed Data, reserved
   keys and undeclared codes retain call/prop records but suppress Script Host
   errors and `call failed`. Repeat inside cancellation cleanup, where ordinary
   failure/conversion applies again.
3. During suspending Start, queue AnswerWithCost and Fail **before** op-result
   `started`; verify same id, first Pump remains suspended, next Pump settles.
   Add eligible RequestCharge before started, then charge/answer and answer/charge
   order, failed Start, Stop, Rewind and cancellation races. Check late/inactive
   outcomes without duplicate ids or reissued Host work.
4. Mixed Deliver/Request/Broadcast/Decide/Call and control inputs during a need:
   admission ids, full mailbox, invalid overrides, foreign Values and refused
   input Trace order match native behavior; ordinary inputs wait for next Pump.
   Include Revoke and SetParent, then Dispose and context cancellation to prove
   their next-Pump timing and owner-disposed reason.
5. Rewind before/after first suspension preserves message/request/Decision and
   accounting; same-Pump return is `rewound`, no cleanup Script code runs, and a
   later Pump redispatches exactly once.
6. Successful scope opener/closer with Stop plus malformed result, live
   Segment-bound writes, Stop from commit/release, and failed/unknown lifecycle
   results: verify acquisition acknowledgement, one abandonment/rollback/release,
   finalization-before-control and no execution before required release.
7. While each need kind is held: admit multiple valid frames; reject wrong ref,
   wrong result kind, malformed JSON/deep Values and worker reentry; then correct
   the frame and resume once with unchanged Clock, slice/cap and pending need.
   Repeat across nested effects/releases and verify owned Values/frames survive
   memory growth and are freed once.

Validation executed: existing native Go
`TestStopAtCapabilityCrossingRollsBackAndSkipsConversion`,
`TestStopAtPropertyCrossingEndsBeforeWrite`,
`TestCancellationCleanupCrossingStillConvertsResult` and
`TestStopAtFailedHostChargeRemainsSticky` passed with `-count=1` on this checkout.
No runtime code, protocol specification or expectations were changed.
