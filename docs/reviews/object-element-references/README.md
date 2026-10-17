# Object element reference approval

On 2026-10-17, the maintainer approved the first blessing of the object
element reference cases in the issue-1143 conversation: “yes i am happy with
the unblessed cases”.

- [`disassembly/object-elements`](../../../corpus/disassembly/object-elements/case.toml)
  pins `get-element` and `count-elements` at their first tokens, through `set`
  property targets and ordinals.
- [`objects/element-references`](../../../corpus/objects/element-references/case.trace)
  pins selection, Nothing results, counts and Core-raised errors, each
  charging the base rate once.
- [`objects/element-host-failures`](../../../corpus/objects/element-host-failures/case.trace)
  pins Host callback failures.
- [`load-diagnostics/element-references`](../../../corpus/load-diagnostics/element-references/case.trace)
  pins load diagnostics for Guards, initializers and container targets.
- [`cancellation/element-crossings`](../../../corpus/cancellation/element-crossings/case.trace)
  pins control landing at collection crossings.
- [`restricted-kit/object-element`](../../../corpus/restricted-kit/object-element.trace)
  and [`object-element-count`](../../../corpus/restricted-kit/object-element-count.trace)
  pin restricted-callback refusal.

TS, Go and Zig reproduce every case, Traces in ordinary and Save/Restore
replay. The first-blessing workflow is defined in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
