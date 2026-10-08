# Object inspection and crossing replay review

Evidence for #439 on 2026-10-08, on branch `fix/issue-439`. Runtime support is described beside the [TS Session Host](../../../impl/ts/README.md#the-session-host) and [Go Session Host](../../../impl/go/README.md#repl-and-session-transcripts). The normative contracts are [Session observation](../../../spec/session-observation.md) and its [reader source](../../../spec/session/inspect-reader.talk).

## Proposed first expectations

- [sessions/object-inspection/session.transcript](../../../corpus/sessions/object-inspection/session.transcript)
- [sessions/object-inspection/case.trace](../../../corpus/sessions/object-inspection/case.trace)

**Approval is pending.** Both headers remain `Unblessed`. TS and Go execute the same standalone Transcript, then independently replay its canonical Trace with and without eligible between-Pump restores. Agreement verifies execution; it does not replace the [required human first-blessing review](../../../corpus/README.md#checking). No existing corpus expectation changed.

The case records an actual Kind and initial Object binding, nested Function setter arguments, a dynamically returned Object, a Shape-invalid getter result and a getter that queues a Delivery before failing. It also records a synchronous parent-cycle refusal, a Host Function call, successful parent changes, disposal and successful/unsuccessful Restore resolver outcomes. Ordinary `%notice`/`%output` console lines are escaped. Map insertion order and an ordinary `$sessionFunction` map key survive transport. The native TS test supplies the live getters; neither replay invokes them.

The canonical reader extends use the exact normative template with one shared hygienic suffix. The first reader is `entry4:to:`, with Fuel 612 and allocation 3669. The child reader is `entry6:to:`, with Fuel 49 and allocation 196. Later rows keep ordinary getter failures and disposed-object errors. The Function display identifies its Home/declaration, while its extension remains part of code identity.

## Additional regression evidence

TS `tests/session-inspect.test.ts` and Go Session/driver tests cover passive scalar/map/Function rows, grapheme/byte counts, refusal of non-expressions and trailing input, multiline collection, reader hygiene and exclusion from source, cancellation before dispatch, disposal between expression and reader, retained output before a Limit Fault, Host panic/error replay and no invented crossing before a callback. Malformed metadata tests cover duplicate/extra fields, counter encoding, paths, reply alternatives and forbidden worker actions. Playback tests reject unknown Function handles, missing ends and unmatched crossings even when the Core catches a callback exception.

After rebasing onto #451, describe shares these passive rows, including actual Object metadata, without getters. Native tests verify its single snapshot and Function exposures in standalone and both Trace replay modes.

Native tests in both independent Trace backends preserve an external Function call admitted before Save, including its restored queue and new Function exposures. Contexts retain the exact supplied Function identity; equal displays do not resolve a newer declaration. Exposure/crossing counters do not rewind, and successful Restore clears old Group handles.

Two cross-Core corrections needed by these recordings are tracked separately: Go named extension displays and deferred Store startup in [#454](https://github.com/odogono/odgn-talk/issues/454), and TS property Host-failure reports/declared Function ending payloads in [#455](https://github.com/odogono/odgn-talk/issues/455). Core source identities, costs and canonical Trace records are otherwise unchanged.

Known adjacent limitations are tracked in the affected guides: Go independent Trace source-byte preservation ([#456](https://github.com/odogono/odgn-talk/issues/456)) and TS validation of queued parent changes at drain ([#457](https://github.com/odogono/odgn-talk/issues/457)). The proposed case uses composed source text and drains its successful parent changes before Save. These limitations are not silently represented as approved coverage.

## Verification

- After rebasing onto #451/#453, the full Go suite and all 5,269 TS/tooling tests pass; the Go corpus passing gate includes the new case.
- Both Session corpus backends pass the existing cases and `object-inspection`, including both independent replay modes.
- Workspace typecheck, lint, formatting and generated-source checks pass.
- Build and CLI Node runtime checks pass after the rebase; the browser smoke test passed at the implementation checkpoint. Go vet and focused Session/driver/corpus race tests pass.

First-blessing review is the remaining approval step for the two proposed files above. No approval has been inferred from these checks.

## Diagnostic and Lambda correction (#493)

On 2026-10-08, #493 corrects the proposed expectations from #485: `:inspect given x: x` now executes a real Lambda and records its Function exposure, `name: nothing`, arity and empty documentation. A separate `:inspect given x => x` pins `! unexpected token at 1:9` at the expression's position. The added execution advances subsequent Entry and Run numbers in the canonical Trace.

Both Session Hosts preserve parse diagnostics and distinguish trailing input after a complete Entry, which still gives `! bad arguments`. Native regressions cover multiline positions, lexical and incomplete-expression errors, statement/declaration/trailing-input refusal, and no source or execution effects for rejected syntax. Both also pin the anonymous Lambda rows.

`bun run corpus:bless sessions/object-inspection` passes with TS and Go agreement, including standalone Transcript replay and both independent Trace replay modes. The two existing `Unblessed` headers remain; first-blessing approval is still pending for the exact expectation files listed above.
