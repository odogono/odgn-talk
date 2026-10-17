# Object element references: specification handoff for #1143

## Required base and delivery boundary

- **Specification revision:** [#1152](https://github.com/odogono/odgn-talk/pull/1152)
  on `feat/issue-1143`, based on `97981bd9c5687f39787c945d364ed824d5ff9a5c`.
- **Required base:** the merged commit of #1152; the whole
  [contract](../../spec/embedding/object-elements.md) is required. The existing
  [Spec change-impact guide](../agents/spec-changes.md) governs activation.
- **Implemented in:** this delivery specifies the contract and
  [ADR 0100](../adr/0100-object-element-references-use-a-fixed-spelling-and-a-host-collection.md).
  It implements no parser, runtime, Host callback, corpus expectation or Folio
  behavior. The current checkout already contains the Tetris Example Project.
- **Remaining work:** all executable activation and acceptance below, then
  Folio integration and removal of Tetris's startup handle cache. No blocker
  on a Grid Element is introduced.
- **Approval still needed:** no new expectation files exist and none have
  been blessed. Future Trace, Disassembly and Session expectations need first
  blessing through the [corpus workflow](../../corpus/README.md#checking).
  Cross-Core agreement is separate from that approval.

The originating [issue #1143](https://github.com/odogono/odgn-talk/issues/1143)
is an open design proposal discovered while building
[#1109](https://github.com/odogono/odgn-talk/issues/1109). Its open questions
are resolved by ADR 0100. No tracker issue is
closed by this design delivery.

## Delivery sequence

1. **Specification delivery (this work).** Land prose, glossary, rationale,
   support notices and this handoff. Keep the executable Data Files, checked
   public APIs and generated syntax/machine catalogues unchanged. The new
   contract is the single normative target while those files are staged.
2. **Coordinated Core and tooling activation.** Update the reference parser
   and lowering, TS, Go and Zig parsers/checkers/lowering/machines, native and
   C APIs, declaration validation and manifests. Activate grammar, instructions,
   costs, diagnostics, Trace and setup together with their consumers and cases.
   Include replay, Session Hosts, Message Layer and WASI
   embedding adapters. Preserve full opcode coverage and passing API comparisons.
   Do not add coverage exemptions for the new instructions.
3. **Folio integration.** Declare Page collections in both the Play Host and
   authoring Manifest, maintain the name index, test lifecycle and Message Box
   behavior, then simplify Tetris. Ship after the Core activation it requires;
   Folio cannot carry a private parser or temporary source rewrite.

If implementation must lead on one Core, obtain an explicit revised delivery
decision and record its isolated acceptance before activating shared files.
This handoff does not authorize claiming full parity from one Core's tests.

## Deferred executable changes

- `spec/data/grammar.ebnf` and `grammar.toml`: add the dedicated Object Element,
  ordinal and count forms and contextual decisions. They are not ordinary
  text/list chunk kinds: don't accidentally enable range writes or Whose
  heads by adding them to shared chunk tables. Add parser sketches and broken
  sources only when all consuming parsers support them.
- `spec/data/machine.toml` and `costs.toml`: add `get-element` and
  `count-elements`, their stack effects, restricted-callback refusal and
  the contract's exact rates. Reconcile chapter 8's operand/lowering text
  and cost history when activating. Cost Model remains 0 during this
  pre-release addition; no language version bump is selected.
- `spec/data/diagnostics.toml`: extend `not in a guard`, `not constant`,
  `not a container` and `not a property` descriptions/positions as required.
  `grammar.toml`'s syntax-diagnostic descriptions must agree. No new Advanced
  tag or Error Code is needed. Reconcile `errors.toml`'s `out of domain`
  description with the new receiver failure and its specified fields.
- `spec/embedding/talk.ts`, `talk.go`, `impl/zig/include/talk.h` and matching
  implementations: activate the target declarations in the contract, including
  C ownership/error rules. Update TS exports and WASI constructors, Go's Zig
  backend and Elixir's Object Kind declarations. Rebuild C Hosts against the
  changed struct layout.
- `spec/data/corpus.toml`, its schema and chapter 11: extend the `prop`
  record's `op` words and add its optional `selector` field; add Object Kind
  collection metadata and object membership setup. Update all runners, setup
  loaders, writers, validators, replay consumers, debugger views and Session
  recording for the new `op` values.
- Save formats are unchanged; collection declarations are not saved or
  matched, like property declarations.
- Message Layer: add `object-elements-v1`, declaration metadata and the `op`
  and `selector` fields on the existing `prop` need. Update native sidecar,
  WASI reactor and embedding adapters together.
- LSP, formatter and syntax tooling: preserve the dedicated nodes and source
  positions; provide completion/hover from the Manifest's collection Shape.
  Do not require a Folio-specific knowledge of `rectangle` to understand a
  reference. Do not infer a definite member kind through the returned value
  beyond the checker's existing literal/binding inference policy.

Regenerate with `bun run spec:gen`, `bun run syntax:generate`,
`bun run go:generate` and `bun run zig:generate` during activation. Regenerate
Lints if changed syntax metadata affects them. Generated files have no
manual edits in this design delivery.

## Acceptance

- **Parsing and compatibility:** all three issue examples; computed selector
  parentheses; singular/plural scalar spellings; first/tenth/last; nested
  references and property reads; `element`, `elements` and `number` as names;
  `element(x)` versus `element (x) of p`; ordinary `the number of x`; invalid
  ranges, Whose heads, delimiters and final non-key `set` targets. Pin exact
  load/syntax diagnostics and source positions. Existing sources keep their
  parse except newly occupied contextual reference spellings.
- **Selection and evaluation:** evaluate selector and receiver exactly once
  in that order, including a receiver failure after an invalid selector;
  exact case and NFC names, numeric text, missing/empty names; 1, last, -1,
  -count, 0, both out-of-range directions and huge integer magnitudes;
  empty collection, fractional numbers, ranges and every non-selector kind.
  Check non-object, live undeclared and disposed receivers and failure
  precedence. Assert that positive/name/count queries never enumerate members.
- **Declarations and Host results:** missing callbacks/costs, invalid costs,
  allowed heterogeneous Object Shapes, rejected non-object Shapes;
  non-number/fractional/negative/oversized count; wrong-kind, disposed and
  cross-Group returned members; thrown Script errors and malformed failures;
  no callbacks during export or rejected precharge.
- **Purity and property targets:** both forms rejected in Guards even with
  dynamic receivers, and in initializers/defaults; permitted ordinary
  Lambda/Whose conditions; restricted callback refusal through direct and
  nested calls before Host work; property `set` through a reference rooted
  in a name, `me`, `it` and `the target`; no `put`, arithmetic or `delete`
  through references. No mutation of implicit bindings or `it` by a read.
- **Charging and Trace:** base rate and rounded text term; exactly one find/at/count
  callback, including a signed `at` for negative positions; exact budget,
  one-short base/callback/result allocation; malformed results and Script
  failures, no synthetic call id or Segment. Assert public counters and
  Pump FuelUsed, not only identical Trace text.
- **Control and replay:** Stop, cancellation, rewind and receiver disposal
  at a crossing; cancellation cleanup uses its normal budget; at most one
  execution and record per callback. Run fixture-backed and live-answer replay,
  normal and save/restore modes, all Cores; negative queries replay one signed
  `at` crossing. Check shared Disassembly covers both new instructions.
- **Persistence and transports:** returned handle identity and disposed
  identity survive saves; snapshot format and Fingerprint unchanged; native
  membership restored by the Host, with no serialized native data. Exercise native APIs,
  C, sidecar, WASI and TS WASI wrappers, Go backend and Elixir registration;
  opt-in rejection, a `prop` need without `op` unchanged, and the existing
  property crossing cases repeated for each collection `op`.
- **Folio:** heterogeneous and hidden members in z-order, empty Page, another
  Page not showing, Project/Element receiver rejection; create/clone/delete,
  delete/reuse identity, reorder and retained handles; Stop restores authored
  content. Match authoring Manifest and Play declarations. Message Box in
  Browse and Edit, undo of a successful Edit write and no authored change
  after failure. Keep existing Grant `find`'s missing-name error.
- **Tetris:** remove `findCells` and its 216-handle startup cache, run the
  existing deterministic game tests and browser suite. Measure startup and
  representative paint/move/hard-drop Pumps before and after on the same Core,
  checking Fuel and wall time; direct references eliminate the cache but are
  not assumed faster than cached handles. Retain the cache if measurement
  shows direct lookup harms gameplay, and record that outcome in the issue.

Implementation verification starts with the navigation maps for
[TS/tooling](../../impl/ts/NAVIGATION.md), [Go](../../impl/go/NAVIGATION.md),
[Zig](../../impl/zig/NAVIGATION.md), [Elixir](../../impl/elixir/NAVIGATION.md)
and [Folio](../../tooling/creative/NAVIGATION.md). Run `bun run check`,
`bun run go:check`, `bun run zig:check`, relevant typechecks, native/API and
transport tests, and the new cases on all three Cores. Capture exact commits
and case paths before requesting first blessing. Reconcile support notices
and this handoff as work merges; update #1143 and the relevant parent-map
progress together when publishing implementation progress.

## Specification validation

Verified locally on 2026-10-17 against the base named above:

- `bun install --frozen-lockfile` and `bun run unicode:check` completed before
  verification; `bun run spec:gen` regenerated only the glossary appendix.
- `bun run check` passes, including 158 tooling tests, generated Spec/syntax
  checks, predictive grammar/lowering checks, 438 corpus case validations,
  Unicode/Lint checks and tracked Markdown links.
- `bun run go:check`, `bun run zig:check` and `git diff --check` pass.
- All relative links and heading targets in the four new Markdown files
  were checked separately, since the repository checker lists tracked files.

The future source examples are deliberately fenced as text so active grammar
checks do not treat staged syntax as executable acceptance. These checks
verify the specification delivery, not runtime implementation or expectation
approval.
