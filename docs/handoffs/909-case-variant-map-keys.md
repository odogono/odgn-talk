# Case-variant map keys: coverage handoff for #909

Design interview for [#909](https://github.com/odogono/odgn-talk/issues/909).
Q1–Q5 are agreed. The author confirmed complete shared understanding in Q5;
the design interview is complete. The corpus additions are implemented in
PR [#1548](https://github.com/odogono/odgn-talk/pull/1548); verification and
first-blessing approval are recorded in the
[review package](../reviews/folded-map-keys/README.md).

## Agreed scope

Q1: extend TS+Zig Conformance Corpus coverage under the existing language
semantics. Track any newly discovered Core divergence separately. The historical
Go Core divergence is no longer applicable after [ADR 0117](../adr/0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md).

The interview resolved coverage and delivery choices under existing semantics.
No new glossary definition or ADR is needed; the map comparison semantics
already have authoritative documentation.

## Existing authority and coverage

- [Equality](../../spec/03-values.md#equality), [Text](../../spec/03-values.md#text)
  and [Maps](../../spec/03-values.md#lists-and-maps) define exact NFC map-key
  identity, order-independent map equality and simple case folding.
- [ADR 0011](../adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)
  records the rationale for exact keys and explicit case folding.
- [Chapter 8 rates](../../spec/08-the-abstract-machine-and-the-cost-model.md#rates)
  define comparison visit charges.
- At the interview checkout, the [Trace Case](../../corpus/text-model/folded-comparisons/case.toml)
  exercised folded nested values, but its map probes retained identical keys
  on both sides.

Static inspection at `7317e70d` found exact map-key lookup in both Cores and an
existing Zig unit regression for the original case-variant-key example. No
execution was performed during the interview.

## Agreed coverage

Q2: require these executing probes, exposing their results in the final Script
Variables inspected by the Trace:

- Same exact key with differently cased text values compares equal with
  `ignoring case`, and unequal without it.
- `{A: "X"}` versus `{a: "x"}` compares unequal with or without folding;
  folded inequality succeeds.
- `{A: "X", a: "Y"}` versus `{a: "y", A: "x"}` compares equal with folding
  and unequal without it. Both case-variant keys coexist, their values remain
  attached to exact keys, and reversed insertion order does not affect equality.
- Swapping the values between exact keys compares unequal under folding. Include
  a separate mismatch only at the second visited entry.
- Removing one case-variant entry compares unequal. `{A: nothing}` compares
  unequal to both `{a: nothing}` and `{}`.
- Nest the collision-preserving positive example through map → list → map.
  It compares equal with folding; changing only an inner key's case makes it
  unequal.

Q3: also require coexisting `Σ`, `σ`, and `ς` keys with distinguishable values,
a control comparing canonically equivalent key spellings after NFC, and list
membership probes that distinguish matching exact map keys from case-mismatched
keys. Canonically equivalent spellings denote the same key after normalization;
they are not another pair of distinct coexisting keys.

Q4: explicitly cover comparison Fuel for a missing exact key at the first
visited entry and a missing key reached after a long fold-equal value. Choose
text lengths that cross a charging boundary. Derive expected scan counts from
chapter 8 before reviewing generated expectations: with a 32-Character ASCII
value, the early missing-key comparison scans 1 map entry; the late comparison
scans the first entry, its 32 Character pairs, and the missing second entry,
for 34 scans. Use equal-size maps and the left operand's insertion order to
isolate early termination. The remaining instructions' costs contribute to
the Segment total and must also be accounted for.

## Agreed delivery

Q5: extend the existing `text-model/folded-comparisons` Trace Case with dedicated
map-key behavior and cost Handlers. Deliver and pump each Handler explicitly in
`case.trace`; expose their results through the existing `log` Script Variable
and final `> vars`. Retain the existing coverage and language/Cost Model versions.

Document the expected booleans and derive the affected Fuel totals from the Spec
so human review can assess correctness independently of agreement between Cores.
The existing [Script](../../corpus/text-model/folded-comparisons/s.talk) and
[Trace](../../corpus/text-model/folded-comparisons/case.trace) are the execution
files to extend; update [case.toml](../../corpus/text-model/folded-comparisons/case.toml)
commentary if needed to describe the added coverage.

Require TS and Zig agreement in ordinary and automatic save/restore replays,
using the agreement-gated `bun run corpus:bless text-model/folded-comparisons`.
Follow the repository's fresh-worktree setup before running checks and the
[TS](../../impl/ts/NAVIGATION.md) and [Zig](../../impl/zig/NAVIGATION.md) task maps
for relevant verification. Generated expectations still require human review;
the interview's design approval does not approve a future Trace diff.

Correct the `text-model/folded-comparisons` case-navigation paragraph in the
[Corpus README](../../corpus/README.md#case-navigation): replace its obsolete
Go reconciliation description with the actual TS+Zig coverage and distinguish
the earlier approved blessing from the new expectations awaiting review. Keep
that paragraph consistent with implementation and review status.

## Implementation handoff

- **Implemented in:** design PR [#1547](https://github.com/odogono/odgn-talk/pull/1547);
  implementation PR [#1548](https://github.com/odogono/odgn-talk/pull/1548),
  with corpus additions and documentation cleanup implementing Q2–Q5 at
  `88d4a6d8`. The review package records independently derived expected booleans
  and Fuel, plus the maintainer's first-blessing approval on 2026-10-23.
  The implementation is not yet merged.
- **Remaining work:** merge the implementation. TS+Zig agreement passed in both
  replay modes, as did
  the full Go corpus gate and both full Zig corpus passes. Reconcile
  #909's handoff when implementation and review land.
- **Required base:** `main` containing design PR #1547; implementation starts
  from `6a32bc56`. Use the Spec sections linked above.
- **Approval still needed:** none. The maintainer approved the additions to
  `corpus/text-model/folded-comparisons/case.trace` on 2026-10-23; the
  [review package](../reviews/folded-map-keys/README.md) preserves the approval
  and exact pre-header-removal inventory.

The confirmed design landed in #1547. Follow-up implementation must use a
revision containing this handoff. The approved expectation records remain
unchanged when their Unblessed header is removed.
