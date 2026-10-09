# Decomposed Trace source review

Evidence for #456 on 2026-10-09, in the implementation change on
`chore/issue-456` based on `29f33b0`. Current support is described in the
[Go Session guide](../../../impl/go/README.md#repl-and-session-transcripts).
The contract is chapter 11's
[source-bearing Host Inputs](../../../spec/11-the-trace-and-conformance.md#host-inputs):
source display text preserves its exact scalar sequence, since Code identity
hashes source as given. Ordinary Script Text Values still normalize to NFC.

## Approved first expectations

- [reload/decomposed-source/case.trace](../../../corpus/reload/decomposed-source/case.trace)
- [sessions/decomposed-source/session.transcript](../../../corpus/sessions/decomposed-source/session.transcript)
- [sessions/decomposed-source/case.trace](../../../corpus/sessions/decomposed-source/case.trace)

On 2026-10-09, the maintainer explicitly approved all three expectation files
above in the issue-456 Codex conversation: “Approve all three expectations”.
Their `Unblessed` markers are removed. This approval changes only comments;
source scalars, Host Inputs, output records, Code identities, Fuel, allocation
and Transcript output remain unchanged.

`bun run corpus:bless sessions/decomposed-source reload/decomposed-source`
writes expectations only after both Cores agree in ordinary and Save/Restore
replay. This execution agreement does not replace the
[human first-blessing review](../../../corpus/README.md#checking).
No existing expectation file changes.

## Coverage and figures

The source literals contain U+0065 U+0301, preserved in the canonical Trace.
Their evaluated Text Values are U+00E9.

The Session case reproduces the original `:inspect "é"` scenario, stores the
same decomposed literal in a Script Variable named `source`, saves and restores,
then inspects it again. Both inspections report normalized Text and size 1.
The first extension identity is
`3eb426219249e8659827878a1b4603880fe3a0881311785be2785820148f214d`;
the three Runs consume 7, 10 and 7 Fuel with zero allocation, and Persistent
State becomes 18 after storing the Text. The native regression records a fresh
standalone Transcript and Trace and compares both independent replay modes.
Before the fix, that regression fails on the first extension: NFC changes its
identity to `11823061baba94a0bc86523a34cbecbd177bce7372aed915c39e6057f5f1a591`.

The Trace case extends a Script with a decomposed Text literal, reloads it with
that literal, then replaces an imported Library with a Function returning it.
The three Runs return `["é", "plain"]`, `["é", "plain"]` and `["é", "é"]`.
Each consumes 23 Fuel, with allocations 71, 71 and 68 respectively; Persistent
State remains 18. Canonical records pin the exact source and identities at
each transition, including restoration between Pumps.

Native field-reader tests cover all three inputs, both quoted decomposed text
and a combining mark supplied by `fromCodePoint(769)`. They also reject
non-text source fields and keep NFC for ordinary answer/Stub Text and a Script
Variable named `source`. The fix uses the existing scalar-preserving
display-text reader for these source fields; the ordinary Value decoder still
uses the Text constructor.

## Verification

- The focused native regressions pass after reproducing the identity mismatch
  before the fix.
- `go -C impl/go test -race ./...` and `go -C impl/go vet ./...` pass.
- `bun run check` passes, including grammar, lowering, Corpus format, pinned
  Unicode and generated-source checks.
- `bun run corpus:run` and
  `go -C impl/go run ./cmd/corpus --check-passing` pass the complete Corpus,
  including both new cases in ordinary and Save/Restore replay.
- The deterministic dual-Core fuzz smoke (`--seed 1`) completes 64 scenarios
  with zero findings.
- Go formatting, `git diff --check` and changelog rendering pass.
- After recording approval and removing the three markers, Corpus format
  checks and both cases pass again on TS and Go in both replay modes.

First-blessing approval for these three files is recorded above, separately
from execution agreement. No acceptance work remains for #456.
