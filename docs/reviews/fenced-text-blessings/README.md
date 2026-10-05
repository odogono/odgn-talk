# Fenced-text expectation approval

On 2026-10-05, the maintainer explicitly approved the four cases below in the
issue-275 Codex conversation: “i have reviewed and am happy with the four cases”.
This follows the closure review identifying the remaining first-blessing and
corrected Transcript expectations.

## Approved cases

- `load-diagnostics/invalid-text-closing-margin`
- `load-diagnostics/invalid-raw-text-closing-margin`
- `stdlib/template-migration`
- `sessions/fenced-text`, including `session.transcript` and `case.trace`

Only comment headers change in these expectations. Host Inputs, Core output
records, source positions, code identities, Fuel, allocation and Transcript
output remain byte for byte unchanged. Removing their `Unblessed` markers
includes these cases in the TS runner's default selection.

## Evidence and boundaries

The implementation and acceptance coverage were merged in
[PR #280](https://github.com/odogono/odgn-talk/pull/280),
[PR #285](https://github.com/odogono/odgn-talk/pull/285) and
[PR #298](https://github.com/odogono/odgn-talk/pull/298).
The issue-275 audit passed all 2,700 TS Core tests, all Go tests, the Go passing
gate, Spec/prototype/generated checks and workspace typechecking.

After recording approval, the three ordinary Trace Cases pass on both Cores,
including Save/Restore replay. The Session Transcript passes on TS, including
ordinary and Save/Restore Trace replay. Corpus format checks also pass.

At the approval recorded here, Go Session execution was separate work under
[#137](https://github.com/odogono/odgn-talk/issues/137); this approval did not
assert Go Session conformance. For current support, see the
[Go Session guide](../../../impl/go/README.md#repl-and-session-transcripts). The already-approved `limits/fenced-text-concat`
case retains its issue-135 approval record. Unrelated pending-review cases are
outside this approval.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
