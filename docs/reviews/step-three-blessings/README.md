# Step-3 first-blessing approval

On 2026-10-05 the maintainer approved the 28-Trace first-blessing review queue
in the [step-3 acceptance audit](https://github.com/odogono/odgn-talk/issues/134#issuecomment-5996660279),
audited at `752a894`: “i have reviewed the traces and am happy with them - so
go ahead and close #134” ([closure](https://github.com/odogono/odgn-talk/issues/134#issuecomment-5997650434)).
The closure did not edit repository markers. Six of the 28
(`cancellation/policy-*`, `limits/join-retention`, `limits/script-join-width`,
`limits/self-send-persistent` and `limits/send-wait-retention`) already record
their approval in the [Go step-4 record](../go-step-four-blessings/README.md).
This record covers the other 22.

Only the `Unblessed` comment line changes. Host Inputs, Core output records,
code identities, resource counters and states stay byte for byte unchanged.

## Approved at the audited revision

These 14 Traces are unchanged since `752a894`
(`git diff 752a894 -- corpus/<case>` is empty before this change).

- `capabilities/declared-allocation`
- `decisions/script-verdict-boundaries`
- `decisions/undecided-on-cancel-delivery`
- `errors/handler-backstop`
- `errors/handler-delivery`
- `load-diagnostics/missing-handler-wait`
- `load-diagnostics/object-properties`
- `objects/guard-keys`
- `suspension/join-preemption`
- `suspension/send-preemption`
- `suspension/send-wait-replacement`
- `suspension/wait-observation`
- `suspension/wait-precision`
- `suspension/wait-work-order`

## Approved, then corrected and approved again

Recovery Offers ([#411](https://github.com/odogono/odgn-talk/pull/411)) changed
these eight Traces after the audit. The maintainer approved each correction on
2026-10-07 for [#392](https://github.com/odogono/odgn-talk/issues/392); see the
[Recovery Offers approval record](../recovery-offers-integration/README.md).
Each file's SHA-256 before this change equals its entry in that record's
[manifest](../recovery-offers-integration/expectations.tsv), and no commit has
touched them since #411.

- `capabilities/ordinary-grants`
- `errors/lambda-capture-parity`
- `libraries/caller-capabilities`
- `objects/properties`
- `suspension/capability-resumption`
- `suspension/script-joins`
- `suspension/script-sends`
- `suspension/send-reply-preemption`

## Evidence

After the headers were updated at `origin/main` `196468c`, all 22 cases passed
unchanged on the TS runner (ordinary and save/restore replay) and on the Go
runner. `bun run corpus:check` accepted all 307 cases.

The other `Unblessed` cases have no recorded approval and keep their markers
until a separate first-blessing review under
[#141](https://github.com/odogono/odgn-talk/issues/141).
