# Checked Mapping review (#697)

## Approval status

**First blessing approved on 2026-10-14.** In the #697 implementation thread,
the maintainer explicitly confirmed: "i approve the inventory" after receiving
the exact 11-file inventory below. This approves all eight new Traces, the
Mapping additions to `map.dis`, and the two identity-only Trace changes.

[The SHA-256 inventory](expectations-sha256.txt) records the exact approved bytes
before removal of the eight Unblessed headers. Those headers alone are removed;
all expectation records and the other three files remain byte-identical.
Execution agreement and human approval are recorded separately.

The original #696 inventory was approved earlier on the same date, as recorded
[separately](../restricted-callbacks/README.md). This later approval covers the
Mapping changes that the original approval did not cover.

## Contract and evidence

[Chapter 7](../../../spec/07-libraries-and-the-standard-library.md#checked-mappings)
fixes the full data contract, unknown-key rejection, invalid-definition
precedence, presence-aware selection, resolved prefixes/failed steps and
wildcard terminal branch ordinals. The shared normative
[Library source](../../../spec/stdlib/map.talk) implements all orchestration;
TS, Go and Zig generate and execute that same source with their own compilers
and machines. No new instruction, Built-in rate or snapshot format is needed.

All definition checks finish before callbacks. Each rule reads the original
input, selects in depth-first order, checks inputs comprehensively, invokes
successful items through the restricted-call intrinsic, and checks outputs.
Ordinary errors are preserved inside ordered stage diagnostics; Limit Faults
escape. Failed reports never contain a partial output. Selection and destination
construction use explicit work stacks rather than recursive Library calls.

The cases cover projection, renaming, pass-through for complete collections and
other Kinds, conversion, the design's email/order-totals example, empty rules,
literal star and empty text keys, positive/negative indices, explicit Nothing,
missing-before-wildcard behavior, nested flattening, insertion order and
branch-specific skip/default policies. Diagnostics pin independent rules and
comprehensive Shape failures, suppressed callbacks, failed output unions,
original callback metadata, missing negative indices and defaulted item locations.
Definition cases pin every reason and precedence, including malformed Shapes
and overlapping paths in rules that would skip. Restriction cases cover captures,
uncaught/caught live reads, nested Mappings, Host-property refusal without a
`prop` record, cleanup failure, suspension refusal and boundary cleanup.

`mappings-restore` executes in 20-Fuel slices, including inside restricted
callbacks and their catches. Each runner also replays with eligible Save/Restore
between Pumps, pinning the same error events, costs and final state.
`mappings-limits` shows Fuel/allocation faults escaping both Mapping and the
Script catch: `out` remains `"unchanged"` and `caught` remains false.
`mappings-depth` follows and constructs 96-step paths under a 12-frame call-depth
limit, then checks the leaf, demonstrating that path depth is independent of
Script call depth within each Core's supported Value domain.

## Cross-Core findings

- [#869](https://github.com/odogono/odgn-talk/issues/869): Zig omitted map comparison visits and did not stop list visits at the first differing item. The minimal one-entry equality charged 21 Fuel instead of 22. The fix meters root entries/items through the first difference or shorter collection, per Cost Model 0. `collection-comparison-fuel` pins broad equal/early-mismatch lists/maps, map insertion-order independence and empty-map asymmetry.
- [#870](https://github.com/odogono/odgn-talk/issues/870): TS scanned past the shorter map's end. The minimal nonempty/empty equality charged 19 Fuel instead of the Spec/Go's 18. The same shared case pins the corrected boundary. No Go behavior change was needed.
- [#871](https://github.com/odogono/odgn-talk/issues/871): the pre-existing Zig Core-wide 128-level Value construction guard gives a Host error for deeper values. A 220-level Script value fails before Mapping runs. Removing that guard safely requires stack-safe Value operations, encodings and snapshots and is separate Core work, explicitly documented in the [Zig guide](../../../impl/zig/README.md). This change adds no Mapping depth limit and does not claim that pre-existing limitation is fixed.

## Exact approved expectations

- [collection-comparison-fuel/case.trace](../../../corpus/builtins/collection-comparison-fuel/case.trace)
- [mappings/case.trace](../../../corpus/stdlib/mappings/case.trace)
- [mappings-definitions/case.trace](../../../corpus/stdlib/mappings-definitions/case.trace)
- [mappings-depth/case.trace](../../../corpus/stdlib/mappings-depth/case.trace)
- [mappings-errors/case.trace](../../../corpus/stdlib/mappings-errors/case.trace)
- [mappings-limits/case.trace](../../../corpus/stdlib/mappings-limits/case.trace)
- [mappings-restore/case.trace](../../../corpus/stdlib/mappings-restore/case.trace)
- [mappings-restricted/case.trace](../../../corpus/stdlib/mappings-restricted/case.trace)

- [restricted-kit/map.dis](../../../corpus/restricted-kit/map.dis): existing private callback code/instruction positions remain unchanged; new Mapping constants and bodies are appended. This later approval covers the new portion separately from the original #696 approval.
- [stdlib/calls/case.trace](../../../corpus/stdlib/calls/case.trace) and [stdlib/lookup/case.trace](../../../corpus/stdlib/lookup/case.trace): only the loaded Script identity changes because the imported normative `map` source changed. All behavior, instruction positions, Fuel and allocation remain unchanged.

## Verification

Verified on 2026-10-14 in `fix/issue-697`, based on `7d79fe0b`:

- 426 Corpus cases pass on TS, Go and Zig, including ordinary/eligible restored replay. Candidate expectations were retained by `corpus:bless` only after all three Cores agreed.
- 25 focused TS Mapping tests (33 assertions) pin independent expected outputs and invalid-definition precedence. Go's acceptance test, required-case baseline and passing gate include every new case.
- Full Bun workspace tests and Go tests pass. The restricted callback kit passes all 38 scenarios across Cores, including restore after each instruction and forbidden-Host-effect assertions.
- Full Zig tests, the WASI build and `tools/wasi/zig.py` runtime/containment checks pass. Go's focused Corpus acceptance suite also passes after adding the new required cases.
- Spec/grammar/reference lowering/Corpus checks, generated consumer checks, typecheck, lint, formatting and `git diff --check` pass.

The implementation is uncommitted in
`/Users/alex/.t3/worktrees/odgn-talk/t3-c797b3c5` at preparation of this record;
[the file manifest](files.txt) lists its exact files. No merged Mapping
implementation is claimed. First blessing is approved as recorded above.
#697 and parent #579 remain open pending implementation review and delivery; the existing Zig depth follow-up
is tracked explicitly rather than silently deferred.
