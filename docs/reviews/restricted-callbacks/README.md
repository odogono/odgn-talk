# Restricted callback review (#696)

## Approval status

**Pending human first blessing.** No approval is inferred from implementation
or cross-Core agreement. All new Trace headers and the kit README remain
Unblessed. The exact expectation inventory is below.

## Contract and implementation

[Chapter 8](../../../spec/08-the-abstract-machine-and-the-cost-model.md#restricted-stdlib-callbacks)
fixes access control, stack effects, inherited frame state, refusals and pricing.
TS, Go and Zig implement it, including private snapshot format bumps (TS 7,
Go `go/7`, Zig 6); previous snapshots are rejected, with no migration.
The private helper is appended to `map` so existing instruction positions do
not move. No public export or pure-call API is added.

The [kit](../../../corpus/restricted-kit/README.md) invokes the actual normative
private body through internal test Hosts. Host effects fail the tests if reached.
Its restore run checks every instruction boundary, including retained frames,
catches, cleanup and nested recovery policies. Shared Traces pin refusal error
fields/order, zero Host charges and operation allocation, and exact Fuel.

Zig findings exposed by this coverage are tracked separately:
[#847](https://github.com/odogono/odgn-talk/issues/847) (catch/Library restore
validation) and [#848](https://github.com/odogono/odgn-talk/issues/848) (caught-error
report metadata lifetime). Their fixes are included here.

## Exact expectations awaiting review

- [allocation-exhaustion.trace](../../../corpus/restricted-kit/allocation-exhaustion.trace)
- [allowed-default.trace](../../../corpus/restricted-kit/allowed-default.trace)
- [call-depth-exhaustion.trace](../../../corpus/restricted-kit/call-depth-exhaustion.trace)
- [caller-offer-escape.trace](../../../corpus/restricted-kit/caller-offer-escape.trace)
- [caller-offer-observation.trace](../../../corpus/restricted-kit/caller-offer-observation.trace)
- [capability-ask.trace](../../../corpus/restricted-kit/capability-ask.trace)
- [capability-tell.trace](../../../corpus/restricted-kit/capability-tell.trace)
- [captures.trace](../../../corpus/restricted-kit/captures.trace)
- [caught-fallback.trace](../../../corpus/restricted-kit/caught-fallback.trace)
- [constant-helper.trace](../../../corpus/restricted-kit/constant-helper.trace)
- [data-dependent-allowed.trace](../../../corpus/restricted-kit/data-dependent-allowed.trace)
- [failure-cleanup.trace](../../../corpus/restricted-kit/failure-cleanup.trace)
- [foreign.trace](../../../corpus/restricted-kit/foreign.trace)
- [fuel-exhaustion.trace](../../../corpus/restricted-kit/fuel-exhaustion.trace)
- [helper-refusal.trace](../../../corpus/restricted-kit/helper-refusal.trace)
- [local-mutation.trace](../../../corpus/restricted-kit/local-mutation.trace)
- [nested-refusal.trace](../../../corpus/restricted-kit/nested-refusal.trace)
- [nested.trace](../../../corpus/restricted-kit/nested.trace)
- [object-computed-getter.trace](../../../corpus/restricted-kit/object-computed-getter.trace)
- [object-computed-setter.trace](../../../corpus/restricted-kit/object-computed-setter.trace)
- [object-disposed.trace](../../../corpus/restricted-kit/object-disposed.trace)
- [object-getter.trace](../../../corpus/restricted-kit/object-getter.trace)
- [object-identity-disposed.trace](../../../corpus/restricted-kit/object-identity-disposed.trace)
- [object-identity.trace](../../../corpus/restricted-kit/object-identity.trace)
- [object-send.trace](../../../corpus/restricted-kit/object-send.trace)
- [object-setter.trace](../../../corpus/restricted-kit/object-setter.trace)
- [ordinary-error.trace](../../../corpus/restricted-kit/ordinary-error.trace)
- [recovery-refusal.trace](../../../corpus/restricted-kit/recovery-refusal.trace)
- [reject-disposal.trace](../../../corpus/restricted-kit/reject-disposal.trace)
- [reject-me.trace](../../../corpus/restricted-kit/reject-me.trace)
- [reject-offers.trace](../../../corpus/restricted-kit/reject-offers.trace)
- [reject-read.trace](../../../corpus/restricted-kit/reject-read.trace)
- [reject-target.trace](../../../corpus/restricted-kit/reject-target.trace)
- [reject-write.trace](../../../corpus/restricted-kit/reject-write.trace)
- [suspending.trace](../../../corpus/restricted-kit/suspending.trace)
- [wrong-arity.trace](../../../corpus/restricted-kit/wrong-arity.trace)
- [wrong-kind.trace](../../../corpus/restricted-kit/wrong-kind.trace)
- [ordinary-call-unchanged.trace](../../../corpus/restricted-kit/ordinary-call-unchanged.trace)
- [map.dis](../../../corpus/restricted-kit/map.dis)

Two existing expectations also change only their load identity because `map`
source changed: [stdlib/calls](../../../corpus/stdlib/calls/case.trace) and
[stdlib/lookup](../../../corpus/stdlib/lookup/case.trace). Their instruction
positions, behavior and accounting are unchanged. The update command checked
TS and Go in both replay modes; Zig also passes both cases in its Corpus gate.

## Verification

Verified on 2026-10-14:

- `bun tools/corpus/restricted-kit.ts`: all 38 scenarios agree across TS, Go
  and Zig; each Core also compares restore after every instruction. The TS
  suite has 77 tests and 6,739 assertions. The wrapper includes `zig build test`.
- `bun run check`: specification generation, grammar, reference machine,
  414 Corpus formats, syntax, Unicode, lints, documentation links and tool tests.
- `bun run go:check` and `bun run zig:check`: generated consumers match.
- `bun run typecheck`, `bun run lint`, `bun run format:check`: pass.
- `bun run test`: all workspace suites pass, including ordinary Corpus replay.
- `go test ./...` from `impl/go`: all packages pass, including its Corpus gate.
- `zig build test` and `zig build corpus` from `impl/zig`:
  all tests and the Corpus gate pass.
- `git diff --check`: pass; diagnostic instrumentation has been removed.

## Rebase verification

Rebased onto `origin/main` at `edec5912` on 2026-10-14, incorporating #841–#845.
The uncommitted implementation reapplied without conflicts. Original tracked
edits and new files were checked against the backup; automatic merges in the
Corpus guide, Zig guide and machine retained both sets of changes.
The cross-Core kit (including full Zig tests), generated consumers and repository
checks pass after rebase. The new Corpus runner uses `zig build corpus`;
its removed `--check-passing` option is no longer used. All 414 cases pass.

## Implementation handoff

Implementation is on `fix/issue-696`, based on `edec5912`
(a descendant of required design commit `7ef52421b5ae46b904ce40c95eeffc4fe5357077`).
The [file manifest](files.txt) names every changed/new implementation, Spec,
generated, test and documentation file. No merged implementation is claimed.
Remaining work is human first blessing of the exact inventory above and
merge; #696 stays open until its acceptance is reconciled.
