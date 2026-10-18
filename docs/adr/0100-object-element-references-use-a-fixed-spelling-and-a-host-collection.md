# Object element references use a fixed spelling and a Host collection

Folio's collection policy is extended by [ADR 0103](0103-folio-groups-are-nested-elements-with-page-wide-names.md):
Group Elements expose immediate members, and Page collections include groups
and descendants in postorder. The Core reference mechanism is unchanged.

For [#1143](https://github.com/odogono/odgn-talk/issues/1143), add the fixed
Core spelling `element selector of receiver`, ordinal references and
`the number of elements of receiver`. A Host Object's Object Kind optionally
declares one ordered, named Object Collection through count, positional and
name getters. Folio exposes each Page's Elements in z-order. This lets a
computed reference be the receiver of `set the fill of ...` without an
`ask`, an intermediate `it`, or a startup cache, while the same source has
the same parse on every Host and Core. The [contract](../../spec/embedding/object-elements.md)
is the normative implementation target; its executable catalogues and checked
API declarations remain staged under the [handoff](../handoffs/1143-object-elements.md).

The lookup is synchronous and read-only. Names compare exactly; numeric
positions start at the back of Folio's z-order. Missing selections return
Nothing as list chunks do. The Core pays each declared getter cost before
calling the Host and records each callback as a `prop` crossing with a
collection `op` and `selector`, so the existing property landing, replay and
Message Layer rules apply. `At` takes a signed position, so the last element
costs one callback. Collection declarations, like property declarations, are
not saved or matched on restore. Only scalar lookups
and counting are included initially: treating a Host collection as an
immutable text/list Container would accidentally imply replacement, padding,
range allocation and iteration guarantees that this problem does not need.

## Considered options

- **Folio-only parsing or Host-defined chunk words:** convenient for spelling
  `button`, `page` or arbitrary child kinds, but would make source parsing
  depend on the Host. ADRs [0019](0019-one-predictive-grammar-with-contextual-keywords.md)
  and [0094](0094-host-commands-are-command-call-spellings-of-granted-operations.md)
  retain one grammar; fixed contextual `element` follows that choice.
- **Expose the Core's parent graph:** Message Path ancestry has no sibling
  order or names and is not an authorization policy for enumeration.
  Collections are Host-owned data, independent of parents.
- **Return all Elements through a property and use `item`:** reuses the
  existing language but allocates and converts the whole Page's collection
  for a single reference, and still needs a separate name search.
- **Continue with `elements.find`:** works today and remains compatible, but
  requires an `ask` statement and result temporary instead of a receiver
  expression. Static bindings remain preferable for fixed names.
- **A Grid Element instead:** potentially cheaper for board rendering but a
  separate authored object, persistence and input model; it does not solve
  computed names for ordinary Elements. It could reduce the cost of painting
  Tetris's 216 rectangles, but would not find a computed button or an Element
  on another Page. Measure it separately.
- **A separate `element` Trace record and Message Layer need:** explicit,
  but duplicates every rule that names `prop` and the property transport path.
- **Saving and matching collection declarations on restore:** would protect
  declared costs, but as a collection-only path while properties stay
  unmatched. Matching whole Object Kind declarations is a separate change.

## Consequences

This extends [ADR 0084](0084-creative-tool-scripts-reach-elements-through-load-time-names-properties-and-three-grants.md)'s
load-time bindings and Grants with a general Core reference mechanism.
Folio's policy lives in [its guide](../../tooling/creative/README.md#element-references).
Holding a collection receiver authorizes its member reads; lookup is not
controlled by the `elements` Grant. Hosts must choose collection membership
accordingly. No new Object Kind inheritance, message dispatch or mutation
mechanism is introduced. Range selection, enumeration and element Whose
heads require a later decision if requested.

The specification lands before runtime support. Grammar, opcodes, costs,
diagnostic catalogue changes, public declarations and Trace setup/records
activate with their consumers, including all three Cores and the Message
Layer, rather than making the existing coverage checks accept partial support.
