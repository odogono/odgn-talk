# Object element references

This is the normative contract for [#1143](https://github.com/odogono/odgn-talk/issues/1143).
The grammar, machine, embedding declarations and Trace catalogues include it;
the [implementation handoff](../../docs/handoffs/1143-object-elements.md)
tracks each Core's support. [ADR 0100](../../docs/adr/0100-object-element-references-use-a-fixed-spelling-and-a-host-collection.md)
records the choices.

## Scope and authority

An Object Collection is an ordered, named collection of Host Objects exposed
by another Host Object. Its Object Kind may declare one collection, reached
through the fixed language spelling `element`. The Host supplies membership,
order and names. The Core supplies parsing, selector validation, charging, errors and recording of every Host crossing.

This is independent of the Core-held Message Path. Declaring a collection
does not set parents, grant access to other objects, or enumerate objects in
the Group. Holding the receiver authorizes its collection reads, as holding
it authorizes its property reads. A Host must expose only members that a
Script holding the receiver may reach. No named Capability Grant is needed;
revoking an unrelated Grant does not revoke these reads.

There is one grammar on every Host. Hosts cannot introduce chunk words,
alternate spellings, executable parser extensions or collection methods
callable by Script. Object Kind names remain independent of `element`:
Folio's `rectangle`, `text` and other kinds need no common superclass.

The first version selects one member or counts members. Ranges, enumeration,
`every element`, `whose` heads over elements, and collection writes are
outside this contract. An Object Element Reference belongs to the chunk
expression family but is not a text/list chunk with all of its operations.
Existing text/list/Bytes chunks retain their rules.

## Source and selection

The source forms are:

```talk
set the fill of element ("cell_" & r & "_" & c) of thisPage to "red"
set the fill of element 3 of thisPage to "red"
put the number of elements of thisPage into n
put the last element of thisPage into frontmost
put element wanted of anotherPage otherwise nothing into found
```

Both `element` and `elements` accept one selector. It is evaluated once,
before the receiver, which is also evaluated once. An ordinal supplies its
integer selector before evaluating the receiver. The count evaluates only
its receiver. Neither form changes `it` by itself or suspends.

- A text selector is an exact, case-sensitive name after the language's
  ordinary NFC normalization. It is not an id, property key, label or
  Script binding. Empty text is permitted; it finds nothing unless the Host
  actually exposes that name. Numeric text such as `"3"` is a name.
- A number selector must be an integer. Positive positions start at 1;
  negative positions count from the end, so -1 is the last member. Zero
  selects nothing. The ordinary ordinals first through tenth and last work
  with singular `element`.
- A missing name or position gives Nothing. In particular, a receiver with
  an empty collection gives Nothing for any otherwise valid selector and
  its count is 0. A subsequent property write through Nothing raises the
  existing `wrong kind`, with `expected: "object"`.
- A fractional number raises `wrong kind`, with `expected: "integer"`.
  Any selector other than a number or text, including an integer range,
  raises `wrong kind`, with `expected: "number or text"` and the ordinary
  value kind as `got`.
- Receiver and selector expressions both finish before these checks. Check
  selector kind/integrality first, then receiver kind, disposal and collection
  support, in that order. A non-object receiver raises `wrong kind`, with
  `expected: "object"`. A disposed receiver raises `object gone`, even for
  selector 0. A live receiver with no collection raises `out of domain`, with
  `function` `"element"` for a reference or `"number of elements"` for a count,
  and `value` the receiver. It is not an empty collection. A count applies
  the same receiver checks without a selector.

Every `wrong kind` above includes the ordinary `expected`, `got` and `value`
fields; `value` is the offending selector or receiver. Core-raised selection
errors have no Capability or Operation fields. Host callback failures do.

The collection's count is an integer from 0 through 9,007,199,254,740,991.
Positions of greater magnitude cannot select a member and return Nothing
without a Host callback, after the checks above. This bound lets every
embedding pass an exact positional index. It does not limit Script numbers.

For a nonzero selector in that bound, call `At` once with the signed
selector, without calling `Count`; the Host resolves a negative index from
the end. For 0 call nothing. For text call `Find` once, without calling
`Count` or reading any member's properties.
Counting calls `Count` once. Never materialize the whole collection for a
scalar lookup or count.

Membership, order and names must be stable throughout one reference or count,
including its multiple callbacks. The Host must serialize collection edits
with the Group worker; it cannot change the collection from another thread
or a callback in the middle of a read. Ordinary queued control inputs still
land at Host crossings. A Stop, cancellation or receiver disposal that
terminates execution prevents any remaining callback of that reference.
Separate references observe the Host state at their own execution points;
a numeric position is not a stable member identity.

## Grammar, restrictions and property targets

Dedicated productions sit alongside the existing operands and `The` forms
([chapter 2](../02-grammar.md#operands) has them in context):

```ebnf
ObjectElement ::= ( 'element' | 'elements' ) Range 'of' Postfix
ElementOrdinal ::= 'the' Ordinal 'element' 'of' Postfix
ElementCount  ::= 'the' 'number' 'of' 'elements' 'of' Postfix
```

`Range` here has its existing expression precedence; a value that is actually
a range fails selector validation. `element` and `elements` are contextual:
the existing chunk-word index-start/FOLLOW decision chooses an Object Element
Reference. Thus a variable named `element`, `elements` or `number` remains
usable, and `element(x)` with no space remains a function call. The ordinal
decision also recognizes singular `element`. After `the number of`, recognize
the count form only for `elements of`; otherwise preserve the ordinary key
read `the number of x`. No general `the number of words` form is added.

These words are not Reserved Words. Both lookup and count are Beginner
Surface forms; no Advanced tag is added. The reference binds like existing
chunk `of`; the count is an operand like a Built-in property. Parentheses
around a concatenated selector are required as in the first example.
`delimited by` never applies to an Object Element Reference; a chain still
needs an ordinary `item` level for the existing delimiter rule.

There is the same contextual-name compatibility cost as for existing chunk
words: `put element - 1 into n`, previously a subtraction using a variable,
now starts a reference and needs `put (element) - 1 into n`. The same applies
to `elements`. Preserve bare-name and no-space function-call uses; document
this narrow migration when activating the grammar. It is an additive
pre-release grammar change with no language-version bump in this delivery.

An Object Element Reference is a read, not a replaceable Container. `put`,
arithmetic updates and `delete` cannot write through it, including through
keys beyond the reference: report `not a container` at the target's first
token. `set` may traverse a reference to reach a Host Object property,
including through `me`, `it` and `the target`, under the existing root/path
rules. Its final step must remain a key. So `set the fill of element 3 of
thisPage to "red"` works, while `set element 3 of thisPage to x` is `not a
property` at `set`. A count cannot be a Container or a property-target path.
There is no implicit create, delete, rename, reorder or replacement callback.

Lookup and count are always the load diagnostic `not in a guard` in a Guard,
even when the receiver's kind is unknown: unlike ordinary chunks they can
only read Host state. They are `not constant` in initializers and defaults,
at `element`/`elements` or the leading `the`. They are permitted in ordinary
functions, Lambdas and a Whose Clause's condition, where Host property reads
are already permitted. They do not introduce an element Whose head:
`every element of p whose ...` and `the first element of p whose ...` are
syntax errors at `element` and `whose`, respectively.

## Embedding declarations

`ObjectKindDef` has an optional `elements` / `Elements`. Omission preserves
existing behavior.

```ts
export interface ObjectElements<N> {
  shape: Shape;
  count(o: HostObject<N>): Value;
  at(o: HostObject<N>, index: number): Value;
  find(o: HostObject<N>, name: string): Value;
  countCost: Cost;
  atCost: Cost;
  findCost: Cost;
}
// ObjectKindDef<N> gains: elements?: ObjectElements<N>
```

```go
type ObjectElements struct {
    Shape     Shape
    Count     func(o *Object) (Value, error)
    At        func(o *Object, index int64) (Value, error)
    Find      func(o *Object, name string) (Value, error)
    CountCost Cost
    AtCost    Cost
    FindCost  Cost
}
// ObjectKindDef gains: Elements *ObjectElements
```

`shape` is a required non-optional Object Shape, or a nonempty `OneOf` of
Object Shapes with distinct Object Kind names. The Core wraps it in Optional
when checking `At` and `Find` results. It does not accept arbitrary values,
lists, maps, functions, an unconstrained `value` Shape or nested optionals.
This keeps the interface a collection of objects. A heterogeneous collection
such as Folio's declares its supported Object Kinds in that choice.

All three callbacks and costs are required. Validate costs as ordinary
declared costs: whole Fuel/allocation components in the existing valid range,
allocation defaulting to 0. A missing callback, invalid cost or invalid Shape
is Host Error `invalid value` at definition. Copy declaration metadata as
with property declarations; later mutation of the definition cannot change
it. `Count` returns a number Value in the count bound above. `At` receives
only an exact nonzero index in that bound: positive from the front, negative
from the end, with -1 the last member. It gives Nothing when the index
selects no member; otherwise it gives that member. `Find` returns the unique member by name, or
Nothing. Exposed names must be unique under exact normalized comparison.

Callbacks are synchronous, read-only and non-reentrant, like property getters.
They cannot suspend, acquire a Scope, enroll a Segment participant, or obtain
a `Call` for extra charging. A Host with work that cannot be covered by its
declared bounded callback cost must offer a Capability Operation instead.
Returning a Promise, a malformed count, a value outside the result Shape,
a disposed member, or an object belonging to another Group is `host error`.
Validate Group ownership and liveness even inside an allowed Object Shape;
the receiver may only expose live handles in its own Group. The Host must
ensure `Count`, `At` and `Find` describe the same membership and order.

Returned/thrown Script errors follow property getter failure rules, with
`capability` the receiver's Object Kind and `operation` respectively
`"elements.count"`, `"elements.at"` or `"elements.find"`. A malformed Host
failure uses the existing `host error` and Host-only `call failed` detail.
These callback names are not Script-visible properties and cannot collide
with actual property names.

The C target follows property getter ownership and error conventions:

```c
typedef talk_call_end (*talk_element_count_fn)(void *context, talk_object *o,
    talk_value **result, talk_script_error *error);
typedef talk_call_end (*talk_element_at_fn)(void *context, talk_object *o,
    int64_t index, talk_value **result, talk_script_error *error);
typedef talk_call_end (*talk_element_find_fn)(void *context, talk_object *o,
    const char *name, size_t name_len,
    talk_value **result, talk_script_error *error);
typedef struct talk_object_elements {
    const talk_shape *shape;
    talk_element_count_fn count;
    talk_element_at_fn at;
    talk_element_find_fn find;
    void *context;
    talk_cost count_cost;
    talk_cost at_cost;
    talk_cost find_cost;
} talk_object_elements;
/* Append to talk_object_kind_def:
   const talk_object_elements *elements; // NULL: no collection */
```

Each successful callback returns `TALK_CALL_ANSWERED` and an owned result
reference, including for Nothing. Script errors use `TALK_CALL_FAILED` and
the error output, as immediate Operations do. `TALK_CALL_STARTED`,
`TALK_CALL_LIMITED` and `TALK_CALL_BROKEN` are Host errors.
The find name is borrowed UTF-8 for that callback, with its explicit byte
length. Copy declaration metadata at registration, retaining callback/context
pointers under the same lifetime rules as properties. Adding a field changes
the C struct layout: rebuild embedding Hosts against the activated header.

## Lowering, charging and interruption

Two instructions are sufficient:

- `get-element`: pop the receiver, then its selector, and push the selected
  object or Nothing. Evaluate selector before receiver. An ordinal lowers to
  its integer selector followed by the receiver and this instruction.
- `count-elements`: pop the receiver and push its count.

Both are positioned at the reference's first token, including the leading
`the` of an ordinal or count. Every error, Limit Fault and callback source
position belongs there; a following `set-property` retains its own position.
They can raise the errors above and ordinary property-callback errors.
Do not extend `chunk-set`, `chunk-delete` or `test-chunk` to objects.

Both instructions are forbidden in restricted callbacks, including when
hidden in a locally called function. Apply the existing restricted-execution
gate before their base or Host charges: raise `restricted operation` with
`instruction` `"get-element"` or `"count-elements"`, pay only the existing
`restricted-refusal` rate, and invoke no Host callback. These reads cannot
be made pure by selecting 0 or an empty collection.

The base rate for `get-element` is `3 + scalars(input) / 8` Fuel,
allocation 0, with `input` the selector; numeric selectors contribute zero
scalars. The base rate for `count-elements` is 3 Fuel, allocation 0.
Divided terms round up and
charging order uses the existing Cost Model. After expression evaluation,
pay the base rate before selector/receiver validation. There is no `scanned`
charge for objects and no ordinary `chunk-get` charge on top.

Before each callback, pay that callback's declared Fuel and allocation cost.
If payment fails, do not call it and do not record a crossing. Each
reference or count makes at most one callback. After each callback, convert and charge its returned
Value (or failure Data) exactly as for a property getter, with the additional
count/member validation above. Account it once, without a separate allocation
for pushing a returned handle or Nothing. A subsequent error or Limit Fault
retains already spent Fuel. Receiver/selector validation failures invoke no
Host callback. Control interruption follows the property-crossing rules,
including cancellation cleanup; no synthetic Call id, Run, Segment or
Suspension Point is introduced.

## Manifest, persistence, Trace and transport

Object Kind declarations gain optional `elements` data with ordered fields
`shape`, `countCost`, `atCost`, `findCost`; executable callbacks are excluded.
The same metadata appears in the Host Manifest; absence stays omitted so
existing Manifest output is preserved. Like property declarations, collection
declarations are neither saved nor matched on restore, and are not part of the
[Group Fingerprint](../09-embedding.md#the-pump-and-the-group-fingerprint).
The restoring Host supplies them, as it supplies property declarations.
Matching whole Object Kind declarations on restore is a separate change for
properties and collections together. Cross-Core comparisons must use the same
declarations as well as matching recorded Host answers. Membership, order,
names and callback identities are Host state.

Saves contain returned handles as usual and no copies of Host collections.
The restoring Host must restore its native collection state, supply matching
declarations and bind members to the restored Group's handles. A disposed
selected handle can still survive as a value and subsequently raises
`object gone` under the ordinary rules. Runtime collection reads finish
synchronously; no in-flight lookup can be saved or adopted. The snapshot
format does not change.

Each callback is recorded as an existing
[`prop`](../11-the-trace-and-conformance.md#the-trace) record. Its `op` word gains `count`, `at` and
`find` beside `get` and `set`, and it gains an optional `selector` field after
`op`. For a collection crossing, `object` is the receiver, `name` is the fixed
id `elements`, and `selector` is absent for count, the nonzero integer for at
and the text for find. `value` and `error` follow the `get` conventions,
including Nothing. Record one crossing per callback, not per expression. Base
validation and payment refusals have only the normal error or fault records.
Every existing `prop` rule then applies unchanged: landing placement,
interrupted-crossing failures, and replay, which also checks `op` and
`selector`, answers from the record and redoes Core conversion and charges.
Never encode the selector in `name`, or record a Grant `call`.

For corpus setup, `[objectKinds]` gains the declaration metadata and
`[objects]` gains optional `elements`, an ordered list of `{name, object}`
entries in display-form Values. Resolve entries after all setup handles have
been made; reject duplicate names, unknown/cross-Group/disposed members and
Shape mismatches. An absent member list on a collection receiver is empty.
Kinds without a declaration cannot supply a member list. Static fixtures and
recorded Host answers are enough for shared selection/parity cases; live
membership edits also need native Host and Folio tests.

The Message Layer opts in with `object-elements-v1`. `define-object-kind`
accepts the same optional declaration. A callback is the existing interim
[`prop` need](../09-embedding.md#messages) with `prop` `elements`, plus an `op`
(`count`, `at` or `find`) and an optional Value-encoded `selector`; the need
without `op` keeps its existing get/set meaning. The Host answers with the
existing `prop-result` `value`, `fail` or `hostError` alternatives. Without
opt-in, reject a collection declaration with a protocol error rather than
silently stripping it. An absent declaration remains backward compatible.
The existing property crossing rules then apply unchanged, including queued
inputs, control landing, deferred replies, Session observation and replay.
Add a matching C callback interface and
registration declaration, and adapt the TS WASI, Go backend and Elixir
bindings; numeric counts and positions stay exact across every transport.

## Folio policy

Folio's Page collection, z-order, costs and name index are Host policy,
specified in [Folio's guide](../../tooling/creative/README.md#element-references).
