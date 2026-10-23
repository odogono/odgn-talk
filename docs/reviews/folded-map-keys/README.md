# Case-variant map-key expectations (#909)

## Approval status

**First blessing approved on 2026-10-23.** After reviewing this package at
implementation commit `88d4a6d8a91d82176f912e25912fcd53b5442d58`, the maintainer
confirmed in the #909 implementation thread: "the package looks fine i approve".
This approves the additions to
[`text-model/folded-comparisons/case.trace`](../../../corpus/text-model/folded-comparisons/case.trace)
for [#909](https://github.com/odogono/odgn-talk/issues/909).
The earlier #903 expectations received their first blessing in
[#912](https://github.com/odogono/odgn-talk/pull/912). This approval is separate
from the earlier [design approval](../../handoffs/909-case-variant-map-keys.md).

## Expected results

The existing `log` has 18 entries after `shared`. The `mapKeys` Delivery appends
these nine lists in source order:

1. `[true, false]`: values fold under one exact key; ordinary equality is exact.
2. `[false, false, true]`: `A` and `a` are different keys, both with and without
   folding; folded inequality succeeds.
3. `[true, false]`: `A` and `a` coexist with different values; reversing their
   insertion order preserves equality of corresponding folded values.
4. `[false, false]`: swapped values fail, as does a mismatch at the second entry.
5. `[false, false, false]`: a missing entry changes equality, including when the
   left value is Nothing and the right key differs only in case or is absent.
6. `[true, false]`: the rule propagates through map/list/map nesting; `inner`
   and `Inner` remain different keys.
7. `[true, false]`: `Σ`, `σ`, and `ς` coexist as three keys even though all three
   simple foldings coincide; swapping their corresponding values fails.
8. `[true, false]`: precomposed and decomposed é denote the same NFC key;
   their differently cased values agree only with folding.
9. `[true, false, true]`: membership skips a case-mismatched key, finds a later
   exact key, and preserves the same distinction for `is not in`.

The `mapKeyEarly` and `mapKeyLate` Deliveries each append `false`, giving 29
final `log` entries. Map keys remain exact at every depth under
[Equality](../../../spec/03-values.md#equality),
[Text](../../../spec/03-values.md#text) and
[Maps](../../../spec/03-values.md#lists-and-maps).

## Fuel derivation

These totals are derived from [Cost Model 0](../../../spec/08-the-abstract-machine-and-the-cost-model.md#rates)
before generating expectations. Each divided term rounds up separately.
The reference disassembly locates executed instructions; the Spec supplies
their costs. Reproduce its inventory with:

```sh
bun tools/machine/check.ts --dis corpus/text-model/folded-comparisons/s.talk
```

`mapKeys` costs **533 Fuel**:

- 64 constants: 64.
- 51 maps: 244, summing `2 + 2 * count` for each construction.
- 16 lists: 77, summing `2 + count + ceil(count / 16)`.
- 17 equalities and one inequality: 53. Each costs 3 except the Nothing-valued
  map against an empty map, which scans zero entries and costs 2. Every other
  comparison scans between 1 and 16 pairs, including nested comparisons.
- Three membership instructions: 15. The successful probe scans two list
  entries, one missing map key and one matching map entry plus its Character,
  for `2 + (1 + 1) + (1 + 1 + 1) = 7`. Each single-miss probe costs 4.
- Negating the last membership result: 2.
- Nine temporary stores, nine Script Variable loads and nine temporary loads: 27.
- Nine appends: 27; a list result has zero text scalars.
- Nine Script Variable stores: 18.
- Handler dispatch: 4; implicit Nothing and return: 1 + 2.

Each cost Handler constructs two equal-size maps using the same two
32-Character ASCII values. Only insertion order differs:

- `mapKeyEarly`: the first exact key is missing, so `scanned = 1`, and the
  comparison costs `2 + ceil(1 / 16) = 3`.
- `mapKeyLate`: the first entry's value folds equal before the second key is
  missing, so `scanned = 1 + 32 + 1 = 34`, and the comparison costs
  `2 + ceil(34 / 16) = 5`.

Each Handler's other instructions cost 39: dispatch 4; two constant/store
pairs 4; four value loads, two maps and two stores 18; two operand loads 2;
temporary store/load and Script Variable load 3; append 3; Script Variable
store 2; implicit Nothing and return 3. Thus their Segment and Run totals are
**42** and **44 Fuel**, independently observable in separate Pumps. Key text
length adds no Character scan.

## Verification

The [SHA-256 inventory](expectations-sha256.txt) identifies the exact approved
Trace bytes before removal of the Unblessed header. The inventory was verified
against the reviewed revision before removing only that header; every Host
Input and expectation record is unchanged.

Passed on the implementation branch:

```sh
bun run corpus:bless text-model/folded-comparisons
go -C impl/go test ./internal/corpus
(cd impl/zig && zig build corpus)
(cd impl/zig && zig build corpus -- --defer-crossings)
```

The agreement-gated blessing checks TS and Zig in ordinary and automatic
save/restore replay. Full Go corpus verification uses its embedded Zig Core;
the two full native Zig corpus passes also include automatic save/restore,
with the second pass deferring eligible crossings.

An independent comparison against the expected results above verified all 29
final `log` entries and the 533/42/44 Fuel totals. The original three Segment,
Run and Pump records are unchanged; only the source identity, added Deliveries
and their records, and the final `log` change. No Core or Spec behavior changed.
The new cost Handlers each allocate 346 bytes: two maps of 165 bytes plus 16
for appending a boolean. Their final Persistent State is 1528 and 1544 bytes.
