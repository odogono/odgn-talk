# Restricted callback test kit

**Unblessed:** the 38 `.trace` files and `map.dis` await human first-blessing
review for [#696](https://github.com/odogono/odgn-talk/issues/696).
[Review inventory and evidence](../../docs/reviews/restricted-callbacks/README.md).
Agreement between Cores does not approve the expectations.

This language-neutral kit exercises the private stdlib intrinsic specified in
[chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md#restricted-stdlib-callbacks).
It is not an ordinary Trace Case: the corpus runners skip it because no public
Script or Host API exposes `map:restrictedCall`. Each Core's internal test Host
constructs a Function Value pointing at the actual trusted normative Library
body, passes it as `invoke` to `go`, and executes ordinary Script callbacks.
There is no alternate test lowering or production trust switch.

`cases.json` supplies each Script, expected return display (or `fault`), optional
resource limits, and optional Host object/Capability/foreign-function setup.
Objects have Kind `item`, id `o1`, and a `label` getter/setter. The `restrictedApi`
Capability has immediate `read` and fire-and-forget `write`, each costing 11 Fuel.
Every getter, setter and Operation fails the test if invoked. A disposed object
is disposed before delivery. A foreign callback belongs to Script `other`.

Each Core compares uninterrupted execution with the exact shared Trace,
including errors, positions, accounting, messages and final Script Variables.
A second run preempts with a 1-Fuel Slice, saves/restores before every subsequent
instruction, and compares the next Pump and inspection against the original.
`map.dis` pins the complete normative Library, including the private instruction.
Separate access tests compile identical Host source without granting trust;
the reference lowering has its own trusted/untrusted test.

Run from the repository root:

```sh
bun tools/corpus/restricted-kit.ts
```

`--update` writes candidate expectations with TS, checks Go and Zig, and restores
all previous expectation bytes if a check fails. It retains the Unblessed
markers. Use that wrapper, not the internal `UPDATE_RESTRICTED_KIT` environment
switch. Human approval is recorded separately under the
[corpus review policy](../README.md#seed-blessing).

The kit covers captured snapshots, local Value Semantics, Constants/defaults,
data-dependent success, inherited helper/nested boundaries, caught fallbacks,
failed-call cleanup, ordinary errors and eligibility, object identity before
and after disposal, forbidden live state and Host access, caller recovery
observation/escape, and Fuel/allocation/call-depth exhaustion.
