# Script Shapes and Mappings

Implementation follow-up: Shape checks landed in #852 (`fd2f13be`), and the
restricted-call prerequisite landed in #853 (`44c09f0f`), both across all three
Cores. Their first blessings were approved on 2026-10-14; see the
[restricted-callback approval record](../reviews/restricted-callbacks/README.md).
Checked Mappings are implemented by the normative `map` Library source under
[#697](https://github.com/odogono/odgn-talk/issues/697), with the finalized
[chapter 7 contract](../../spec/07-libraries-and-the-standard-library.md#checked-mappings).
The original design narrative below records the agreed requirements; current
contracts and support are in the Spec and Core guides.


Design for [#579](https://github.com/odogono/odgn-talk/issues/579), agreed in the design interview on 2026-10-12. **This is a proposed behavior contract and implementation handoff, not a description of shipped APIs.** Revision 1 records the combined design, including the later JSONPointer-inspired Mapping decisions. Its base is `aaf120c19dacd4bc4b9ec61f80681f33214127b6`; the documentation is delivered from branch `docs/grill-issue-579`. See [Implementation handoff](#implementation-handoff) for the required design revision and remaining work.

[ADR 0080](../adr/0080-scripts-check-shapes-through-built-ins.md) records the choice of Shape Built-ins; [ADR 0081](../adr/0081-mappings-compose-shapes-with-restricted-transformations.md) records Mapping composition and restricted callbacks. The [glossary](../../GLOSSARY.md) distinguishes a Shape, a Mapping, a Selection Path and a concrete Value Path. New glossary vocabulary does not imply runtime availability.

## Current support and motivation

The Core already checks Capability arguments and results against [Shapes](../../spec/09-embedding.md#shapes). The Host Manifest describes message Shapes for tooling; the Core does not read that Manifest or automatically validate Deliveries against it. Scripts currently inspect values through ordinary language operations. The proposed explicit checks apply equally to Deliveries, decoded JSON, Store results and values from other Scripts.

Shape spelling comes from the Host Manifest data model described in [chapter 9](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint). Existing Host constructors and tooling decoders do not agree on all malformed definitions, so exposing Script-supplied data needs its own specified validation contract. It must not inherit a decoder's permissive wrapper precedence or incidental depth limit.

[Object Shape work (#198)](https://github.com/odogono/odgn-talk/issues/198) is already implemented; it is not a new dependency. [The load-time Validate hook (#471)](https://github.com/odogono/odgn-talk/issues/471) was explored in [a separate research note](load-time-validate-hook.md). Its literal Capability argument checks are distinct from checking computed values during execution. Automatic Delivery checks and Handler parameter declarations are also outside this proposal.

### Inspiration from JSONPointer

[JSONPointer](https://github.com/odogono/elixir-jsonpointer) contributes ordered projection: each rule reads from the original source, writes to a new result and may convert the selected value. Its [weather example](https://github.com/odogono/elixir-jsonpointer/blob/master/test/json_pointer_test.exs#L635) selects, renames and converts fields. Its equality-at-a-pointer `test` and presence checks are different operations from Shape conformance.

NorthTalk keeps structured paths instead of adopting slash-delimited JSON Pointer strings. Its list positions are 1-based. Mappings make missing-value handling explicit, preserve the distinction between absence and Nothing, and never silently omit a failed wildcard branch unless the rule selects `skip`. The existing JSONPointer implementation can skip failed wildcard reads, and a missing source can raise from `transform`; those are not the proposed Mapping defaults. These observations concern the [library source](https://github.com/odogono/elixir-jsonpointer/blob/master/lib/json_pointer.ex), not requirements of RFC 6901.

## Explicit Shape checks

The proposed public operations are ordinary, shadowable Built-in function names, not new keywords:

- `conforms(value, shape)` returns true or false for a valid Shape.
- `check(value, shape)` returns the unchanged value on success and raises the first mismatch on failure.
- `explain(value, shape)` returns an ordered list of diagnostics, empty on success.

All three have ordinary Built-in Guard eligibility. All three validate the entire Shape before inspecting the value for conformance, including unused `oneOf` alternatives. Invalid definitions raise `invalid shape`; they do not become false or ordinary value diagnostics. Resource exhaustion remains a Limit Fault.

### Definition data and acceptance

Accept all fourteen scalar Kind names, plus `any` and `value`. Wrapper forms are `{quantity: unit}`, `{unitKind: kind}`, `{object: kind}`, `{list: shape}`, `{oneOf: [shape, …]}` and `{optional: shape}`. Maps use `{map: [{key: text, shape: shape, optional: boolean}, …], open: boolean}`. Both boolean flags may be omitted and default to false; explicit false is valid.

Reject multiple recognized wrapper keys, duplicate map-field names, empty unions, and missing or invalid recognized fields. Unknown keys on wrappers and field declarations are ignored metadata, and their values are not interpreted as Shapes. This deliberately means a misspelling such as `opne` does not open a map. Metadata must not change acceptance or diagnostic order; reading/storing supplied data does not become exempt from ordinary resource accounting.

Parse and normalize Quantity Units with the Unit Catalogue, then retain exact normalized Unit matching rather than convertibility. Validate Unit Kind names against the catalogue. Object Kind names are text labels matched without querying a Host registry; defining a Shape does not require a corresponding Host Object to exist.

Acceptance is the existing Capability Shape acceptance, including its less obvious cases:

- `any` recursively rejects Function Values; `value` accepts them. Explicit `function` Shapes accept Function Values.
- Open-map undeclared fields still obey the existing data-only check, including rejection of contained Function Values.
- Missing required map fields fail even if their inner Shape is Optional. A field's `optional` flag permits absence; `{optional: shape}` permits a present Nothing.
- Quantity Units match exactly after normalization: `m` and `cm` remain different. Unit Kind matching retains the existing single Unit slot at exponent 1 rule, rather than general dimensional equivalence.
- Object Shapes compare Object Kind names, including for disposed handles, without reading Host properties.
- `oneOf` succeeds if an alternative succeeds. A failed union's first-failure diagnostic remains at the union root.

### Shape diagnostics and ordering

Preserve `wrong kind` with `expected`, `got`, `value` and the existing optional `path` convention. Preserve `not encodable` with `kind` and `path`, including an empty path at the root. Paths are relative to the checked value: no Capability/Operation identity, argument number or argument-index prefix is invented. Raised errors receive normal error metadata at the caller; records returned by `explain` omit `message` and `at`.

Traverse list items in index order. Traverse declared map fields in declaration order, followed by extra fields in the value's insertion order. A missing required field is a failure; a closed-map extra field retains the existing expected `nothing` diagnostic. For comprehensive checks, continue through independently checkable siblings, but stop descending a node whose container Kind is wrong. Requiring a list and finding text gives one failure, not imaginary missing-item failures.

For a failed union, `explain` returns one union-root diagnostic with `alternatives`, an ordered list of per-alternative diagnostic lists. Those nested paths remain relative to the original checked value. A successful union contributes no failure, even if earlier alternatives failed. `check` retains the existing union-root failure without comprehensive alternative detail. Optional wrappers retain existing diagnostic behavior, including adding ` or nothing` only to a root mismatch.

`invalid shape` reports the first definition error using a Shape-relative `path`, stable machine-readable `reason`, and offending `value`. Definition traversal follows recognized Shape structure, field declaration order and alternative order, independent of ignored metadata. The final error catalogue must fix the reason vocabulary and precedence of simultaneous local definition errors before implementation; no current decoder's accidental order is authoritative.

## Mappings

`transform(value, mapping)` is an export of the existing `map` Library. It runs outside Guards and does not change the meaning of the Shape Built-ins. It returns either `{ok: true, value: output}` or `{ok: false, errors: diagnostics}`. The output is always a fresh map. No partial output accompanies failure.

A Mapping is plain data with an ordered `rules` list. Each rule has:

- `from`: a Selection Path; an empty list selects the whole input.
- `to`: a nonempty destination Value Path containing only text map keys.
- Optional `input` and `output` Shapes, applied to each selected/defaulted value before and after transformation respectively.
- Optional `transform`: one unary Function Value receiving the selected/defaulted value. Without it, that value passes through unchanged.
- Optional `missing`: `error` (the default), `skip`, or `default`. A `default` field is required only for the `default` policy; it may itself hold Nothing.

Validate the complete Mapping and embedded Shapes before any callback executes, including rules that would select nothing. Malformed definitions raise `invalid mapping`, with definition locations rather than input locations; an invalid embedded Shape must retain its diagnostic details. Duplicate destination paths and ancestor/descendant destination overlaps are definition errors, even if one of the rules would later skip. The final catalogue must settle the exact Mapping-definition error fields and precedence alongside `invalid shape`.

### Construction and selection

Process rules in declaration order. Every read uses the original input, never an earlier rule's output. Create missing intermediate destination maps as needed. Unmapped source fields do not appear in the output. Each written value may have any Kind, including a complete list; destination paths themselves do not construct individual list positions. A rule with no wildcard writes its single result directly; a wildcard rule writes a flat list of results.

Selection Path steps are text keys, nonzero integer list positions, or the exact wildcard token `{each: true}`. Positive positions are 1-based; negative positions count from the end. Zero is an invalid definition. Resolve actual selected list items to positive indices in diagnostic Value Paths. Text `"*"` is an ordinary map key, not a wildcard. A negative position outside the list is a missing source, not an invalid definition.

A text step requires a map; an integer step requires a list. A wildcard accepts maps and lists, visiting map values in insertion order and list values in index order. Traversal is depth-first, so nested wildcards flatten in deterministic encounter order. Reaching an incompatible container, including a scalar before traversal is complete, gives a source-stage diagnostic rather than becoming an absent value. Host Objects are not traversed through properties.

Use presence-aware traversal. The existing [`lookup`](../../spec/07-libraries-and-the-standard-library.md) alone is unsuitable because it conflates missing values and explicit Nothing. A present Nothing at the end of a path reaches the input check/callback normally; attempting to traverse further through it is a container mismatch.

Missing keys and out-of-range indices apply the rule's missing policy to that branch: emit a diagnostic, skip it, or use one defaulted value. A default is the selected value for that failed branch; traversal does not resume inside it. A default undergoes the same input check, callback and output check as a present value. Missing components before a wildcard apply the policy once to that branch. An existing empty wildcard container is present and contributes no items, producing an empty list if the whole rule selects none. Skipping a non-wildcard rule omits its destination; skipping all branches of a wildcard rule yields an empty list.

### Execution, results and diagnostics

For each selected/defaulted value, check its input Shape comprehensively if supplied. If it fails, collect those diagnostics and do not call that item's function. Otherwise call the function, if present, under the restriction below, and then check the output Shape comprehensively if supplied. Continue through other items and rules after ordinary failures. Output Shapes apply to individual transformed items, not the wildcard rule's final collection.

An uncaught callback error is one transform-stage failure. This deliberately qualifies the current [stdlib callback-error convention](../../spec/07-libraries-and-the-standard-library.md), which propagates callback errors unchanged. Preserve the original callback error inside its diagnostic wrapper, including its own error details; do not relabel it as a Shape mismatch. Limit Faults remain uncatchable and abort execution rather than becoming report entries.

Each Mapping diagnostic identifies the 1-based rule number, `stage` (`source`, `input`, `transform`, or `output`), `sourcePath`, `destinationPath`, and the underlying error or Shape diagnostic. Wildcard diagnostics also identify the encountered branch/match position separately from the destination path; skipped branches must not make a failure's identity ambiguous. A Shape diagnostic's inner path stays relative to the checked item. For a missing source, distinguish the successfully resolved prefix and failed selection step: never invent a concrete positive item position for an out-of-range negative index. Exact wrapper fields for these selection details are part of the remaining catalogue work.

Diagnostic order is rule order, then selection traversal order, then Shape traversal order. Failed items do not supply output values. If any failures occur, discard the prospective output and return only the diagnostic result. With no failures, return the complete output. An empty rules list produces an empty map.

### Example

The following is declaration data for the proposed API, not an executable conformance case. Assume `toNumber` is a unary Function Value that explicitly converts its argument to a number:

```text
{
  rules: [
    {
      from: ["customer", "contact", "email"],
      to: ["email"],
      input: "text"
    },
    {
      from: ["orders", {each: true}, "total"],
      to: ["totals"],
      input: "text",
      transform: toNumber,
      output: "number",
      missing: "error"
    }
  ]
}
```

For an email and two orders with totals `"12"` and `"7"`, success contains `{email: …, totals: [12, 7]}`. If order 2 has a numeric total instead of text, its input check fails before conversion; the wrapper identifies rule 2, stage `input`, source `["orders", 2, "total"]` and destination `["totals"]`. The result contains diagnostics and no partial map. If `orders` is `[]`, `totals` is `[]`; if `orders` is missing, its policy gives a source-stage failure.

## Restricted callback execution

Ordinary non-suspending function calls are not pure: they can access Script Variables or perform effects. Static Capability checking is not purity analysis. A private Library function that merely calls another function cannot enforce this design.

Introduce a documented stdlib-only intrinsic lowered to a normative restricted-call instruction. This is explicit compiler/machine support, not an unrecorded privilege in `map` source. No public pure-call API is added. Built-ins continue not to invoke Script code; the Mapping orchestration lives in Library source and the new instruction establishes the callback boundary.

The restriction is dynamically scoped through every nested synchronous call and remains active during catches, `finally` and unwinding. It must be associated with machine frames/boundaries, not a host-language boolean that can be lost across preemption. Existing ordinary synchronous-call eligibility, including rejection of a foreign Home Script or a suspending function, still applies.

Permit the argument, captured local values, Constants, local computations and local mutations under Value Semantics. Allow immutable Core-held Host Object identity metadata such as id and Object Kind. A Script may copy needed state into a local before constructing a captured Function Value.

Block live Script Variable reads and writes, Host property getters/setters, disposal-state observation, Capability calls, sends, suspension, and other external effects. Block observation of the caller's recovery context and transfers that escape through it, including using a recovery offer to mutate outer locals or leave the restricted boundary. Helpers and nested Mapping calls cannot relax an inherited restriction.

Reject a prohibited operation before it acts with an ordinary catchable error. A callback may catch the error and return a valid fallback, but the restriction persists. An uncaught restriction error becomes that rule's transform-stage diagnostic. Limit Faults do not become catchable. The final specification must name the restriction error and enumerate affected instructions/Built-ins so no state-observing operation silently bypasses the boundary.

## Resource contract

Shape checks must meter definition validation and matching, including invalid definitions, failed alternatives and work preceding a raised error. Do not reuse the uncharged Host-boundary validation path. Specify deterministic measures for Shape visits, attempted value/Shape pairs, map/key work and relevant text/Unit work. Meter ignored metadata handling where it actually incurs work, without treating it as more Shape structure.

Mapping orchestration uses ordinary Library instruction Fuel. The restricted-call instruction also needs normative accounting; callbacks retain their ordinary instruction charges. Charge construction of full reports, including nested union details and repeated offending values by logical size even if storage is shared. Successful `check` returns its original value without allocating a copy.

Use existing Fuel and Allocation Budgets and stack-safe traversal, with bounded work between resource checks. No fixed Shape nesting limit, error-count option or silent report truncation is introduced. A comprehensive operation returns a complete result or raises a Limit Fault. Native traversal depth must not be confused with Script call depth.

Exact counters, numeric rates, refusal/charging boundaries and the new instruction's operand/stack format remain a focused specification and calibration step. Preemption and save/restore of an active callback must preserve its restriction; the machine-state representation and compatibility consequences must be settled with that instruction. These are prerequisites to runtime implementation acceptance, not implemented guarantees in this documentation change.

## Acceptance scenarios

These are requirements for later executable cases, not claims that new tests pass today.

- **Shape coverage:** every scalar and wrapper; `any` versus `value` with nested functions; exact versus convertible Units; Unit Kind restrictions; matching/mismatching and disposed Object Kinds; Optional versus absent fields; open and closed maps.
- **Definitions:** malformed unused union alternatives fail before value checking; ambiguous wrappers, duplicate fields and empty unions fail; explicit false flags work; unknown metadata is ignored; invalid Units and Unit Kinds fail without Host access. First definition error and path agree across Cores.
- **Reports:** first mismatch follows established order; comprehensive reports continue through siblings, stop at wrong containers, and group failed unions. Successful alternatives suppress union failures. Paths are value-relative, callback metadata is preserved where raised, and returned Shape records omit `message`/`at`.
- **Construction:** projection, renaming, pass-through and conversion; nested map destinations; unmapped fields omitted; overlapping destinations rejected before callbacks; all reads observe the original input; empty rules yield an empty map.
- **Absence:** missing versus explicit Nothing; error/skip/default; default Nothing; defaults checked and transformed; required Optional fields still required; skipped single destinations omitted; empty wildcard results remain present lists.
- **Selection:** positive and negative indices, invalid zero, out-of-range positions; literal `*` keys; map insertion order; nested wildcard flattening; empty containers; missing before and after a wildcard; explicit per-branch skip/default; incompatible containers produce diagnostics without Host property reads.
- **Rule execution:** failed input prevents its callback; output failure follows a successful callback; ordinary callback failures are collected without partial output; independent rules still run; callback errors and Shape failures retain distinct stages and deterministic ordering.
- **Restrictions:** direct and helper-mediated effects/live reads rejected before execution; local calculations/captures and immutable identity permitted; catches can recover but cannot remove the restriction; cleanup, nested calls, recovery escape attempts, preemption and restore preserve it. Foreign/suspending functions cannot bypass synchronous-call restrictions.
- **Limits and parity:** deep definitions and data avoid native stack failures; failed work is charged; broad unions and large reports exhaust the existing budgets predictably; no truncated report appears; Limit Faults escape Mapping diagnostics; result fields/order and Fuel agree across the implementing Cores.

## Implementation handoff

- **Implemented in:** Shape Built-ins in merged #852 (`fd2f13be`), restricted callbacks in merged #853 (`44c09f0f`), across TS, Go and Zig. Both first blessings are approved on 2026-10-14. Checked Mappings are implemented in the shared normative Library source and merged in #874 (#697); the exact 11-file expectation inventory received first-blessing approval on 2026-10-14 in the #697 implementation thread, recorded in [the Mapping review](../reviews/mappings/README.md).
- **Required base:** a descendant containing the design `7ef52421`, Shape checks `fd2f13be` and restricted callbacks `44c09f0f`. `main` contains all three, and the callback prerequisite approval is recorded in [its review inventory](../reviews/restricted-callbacks/README.md).
- **Specification:** chapter 7 now fixes Mapping unknown-key rejection, complete ordered definition validation, exact diagnostic fields/precedence, selection failure prefixes and wildcard terminal branch ordinals. Shape checker and restricted-call rates are already normative; Mapping orchestration uses ordinary Library Fuel and allocation. Library declarations and errors are in `spec/data/stdlib.toml` and `spec/data/errors.toml`; `spec/stdlib/map.talk` fixes execution and charging order. No new instruction, Built-in or snapshot format is introduced by #697.
- **Remaining work:** none for #579; #695, #696 and #697 are merged. The existing Zig Value-depth guard is tracked in #871 and documented in the Zig guide.
- **Approval still needed:** none for the exact #697 expectation inventory, approved separately from the earlier #696 inventory on 2026-10-14. Later expectation changes need their own approval. Follow the [corpus guide](../../corpus/README.md#checking) and the [Spec change-impact guide](../agents/spec-changes.md).
