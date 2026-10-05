# Go step-4 first-blessing approval

On 2026-10-05, after [PR #340](https://github.com/odogono/odgn-talk/pull/340)
merged, the maintainer explicitly approved the first blessings listed below
in the issue-135 Codex conversation: “ok i approve of the blessings - go ahead
and close”. The approval follows the identified closure gate of seven
limits/cancellation regressions and 22 Segment-bound effect cases.

Only comment headers change. Host Inputs, Core output records, code identities,
resource counters and rollback states remain byte for byte unchanged. This
records human approval of existing expectations; it does not generate new
expectations or assert Go save/restore conformance.

## Approved cases

- `cancellation/policy-clause-selection`
- `cancellation/policy-dispatch-limits`
- `capabilities/effect-abandon-failed`
- `capabilities/effect-begin-failed`
- `capabilities/effect-begin-unknown`
- `capabilities/effect-cancellation`
- `capabilities/effect-cancellation-commit-failed`
- `capabilities/effect-cancellation-error`
- `capabilities/effect-cancellation-limit`
- `capabilities/effect-close-conversion`
- `capabilities/effect-commit-failed`
- `capabilities/effect-commit-unknown`
- `capabilities/effect-completion`
- `capabilities/effect-decision-failed`
- `capabilities/effect-decision-ok`
- `capabilities/effect-operation-error`
- `capabilities/effect-ordinary-error`
- `capabilities/effect-participant-conflict`
- `capabilities/effect-pass`
- `capabilities/effect-reload-carry`
- `capabilities/effect-rollback-failed`
- `capabilities/effect-segment-roundtrip`
- `capabilities/effect-suspension-commit-failed`
- `capabilities/effect-unrelated-abandon-failed`
- `limits/fenced-text-concat`
- `limits/join-retention`
- `limits/script-join-width`
- `limits/self-send-persistent`
- `limits/send-wait-retention`

## Evidence and boundaries

PR #340 passed the 233-case Go gate, including all 32 step-4 limits,
cancellation and Text Pattern acceptance cases and the 22 effect cases.
Selected TS execution passed 65 cases with identical expectations, including
TS save/restore replay. Go build, vet and the full race suite and the spec/tooling
checks passed; independent review approved the final implementation.

After updating the approval headers, all 29 approved cases were executed again
on Go and TS and passed unchanged. `bun run corpus:check` accepted all 270 cases.

Go Save/Restore is not implemented. Go replay with Save/Restore between Pumps
remains [#136](https://github.com/odogono/odgn-talk/issues/136), as do these four
whole-case effect transcripts expressly deferred by #326:

- `capabilities/effect-close-preemption-fault`: explicit Save refusal with live Host effects.
- `capabilities/effect-reload-fatal`: explicit Save refusal after fatal effect uncertainty.
- `capabilities/effect-replace-library`: Library replacement.
- `capabilities/effect-replace-fatal`: fatal rollback during Library replacement.

Native tests independently cover explicit close followed by preemption and a
Limit Fault, fatal Reload, and owner disposal. Approval does not extend to the
four deferred effect cases, other scope cases, Session Transcripts or unrelated
regressions still carrying pending-review headers.

The limits acceptance follows [chapter 6](../../../spec/06-errors-and-limits.md)
and [Cost Model 0](../../../spec/08-the-abstract-machine-and-the-cost-model.md).
Effect lifecycle ordering follows the
[Segment participant contract](../../../spec/embedding/scoped-effects.md#segment-participant).
The first-blessing procedure is specified in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
