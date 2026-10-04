# Join source-position reconciliation

[Issue #286](https://github.com/odogono/odgn-talk/issues/286) corrects the source
map for `join-end`. Chapter 6 raises member failures at the Join's closing
`end`; chapter 8 identifies `join-end` as that closing instruction. Both Cores
now use the closing token, with or without the optional `wait` suffix. The
instruction PC, member-start positions, `join-start` and following `store 0`
positions remain unchanged.

The implementation base includes the merged Script-only Go Join slice from
[PR #288](https://github.com/odogono/odgn-talk/pull/288), commit
`55b7a80` on `main`.

The following expectations were produced separately on Go and TS and compared
byte for byte before updating them. The Trace Cases also agree with TS
save/restore replay; Go save/restore remains outside its implemented subset.

| Case | Correction or coverage |
| --- | --- |
| `disassembly/messages-and-waiting` | `join-end` PC 104 moves from `43:3` to `49:3`; every other line is unchanged. |
| `suspension/script-joins` | Failure PC 16 moves from `5:3` to `9:3`, including the retained Error map. |
| `limits/join-retention` | Persistent State fault PC 6 moves from `2:2` to `4:2`. |
| `suspension/join-closing-position` | New failed-reply and timeout regression at bare `end` and `end wait`, including a local Handler; the receiver's own Error map remains attributed to its throw. |

The existing case diffs change only source positions. Their call ids, record
ordering, member indices, Fuel, allocation, Persistent State and result Values
are unchanged apart from the corrected `at.line`. The maintainer reviewed the
new case's first blessing in #286. Earlier pending human-review markers are
preserved.

Native lowering and execution tables additionally cover both ending spellings
inside block Lambdas in both Cores. Their failed replies and timeouts use the
closing token's line and column, and failed replies preserve receiver positions.
A fuller Lambda Trace probe does not establish complete parity: Go reports the
Lambda body name in `at.handler` (for example `lambda:27:7`), whereas TS uses the
enclosing Handler (`lambda`), as chapter 6 requires. A captured Lambda also
exposes different allocation/Persistent State figures. These differences precede
this source-map fix and are tracked in
[#289](https://github.com/odogono/odgn-talk/issues/289). No Lambda Trace
expectation was blessed on disagreement, and this change does not alter their
charges.

## Approved mixed-Capability expectation correction

Go refuses `suspension/joins` because Capability Operations are outside its
implemented subset. TS ordinary and save/restore execution agree on all 61
records. The approved expectation correction changes the failed
Capability reply and timeout at PC 16 from `7:5` to the closing `12:5`, and
changes their retained `at.line` fields from 7 to 12. All other fields, records,
resource figures and Values are identical.

The maintainer explicitly approved this limited exception to chapter 11's
[agreement rule](../../../spec/11-the-trace-and-conformance.md#bless) in #286.
The authoritative expectation now contains the approved output, with its header
recording the exception. This does not establish Go Capability parity;
remaining Capability execution belongs to #134.

## Verification

- Before the fix, native lowering and execution regressions reproduced the
  head-position bug in both Cores. After the fix, all ending/context tables pass.
- TS: 2,640 tests pass; focused lowering/Join verification passes 331 tests.
- Go: `go test -race ./...`, `go vet ./...`, `go build ./...` and the 125-case
  passing gate pass.
- Workspace typechecks, TS browser-target build, changed-file lint/format checks,
  Spec/grammar/machine/generated-data checks and the 262-case corpus format check
  pass. The proposed Conventional Commit title matches the changelog fragment.
- Independent review found no blocking implementation findings.
- After the maintainer's approval, all 237 default TS corpus cases pass,
  including the new regression and corrected mixed-Capability Join case.
