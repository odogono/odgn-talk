# Nothing defaults: staged acceptance for #719

This is a draft integration handoff, based on `e98c4870` with design #718
(`77301a6e`) already merged. The implementation is committed on
`fix/issue-719` as `48f89987`; `git diff e98c4870 48f89987 --stat` gives its
changed-file inventory.

`main.talk` and `main.dis` stage a Disassembly case outside the shared Corpus.
`case.toml` marks it Unblessed. TS reproduces it; a focused test also compares
all instruction operands with the reference compiler and the three new
instructions' positions. Existing reference store/Guard positions have separate
conventions, so that comparison does not claim whole-file source-map parity.

The candidate expectation is `impl/testdata/nothing-defaults/main.dis`.
No first-blessing review link exists and no human approval is claimed.
Do not remove the Unblessed header based on this test.

## Implemented

The shared contract now declares `otherwise`, optional map-key reads and the
three instructions, including `branch-not-nothing`'s 1/1/1 stack effects.
The TS implementation covers the design's value rules, lazy evaluation,
computed-key evaluation/validation order, literal keys, chaining, Guards,
initializer/default eligibility, Host prohibition, source positions and Fuel.
Formatter, completion, highlighting, syntax display, lint and debugger
consumers accept the new forms. Chapters 1, 2, 4, 6, 7 and 8, generated tables,
Core guides, migration guidance and a breaking feature fragment are updated.

Focused evidence is in `impl/ts/tests/nothing-defaults.test.ts`, the added
verifier case in `impl/ts/tests/lowering.test.ts`, and the formatter, LSP and
debugger tests under `tooling/stack/tests/`.

## Integration remains blocked

- [Go #720](https://github.com/odogono/odgn-talk/issues/720) and
  [Zig #721](https://github.com/odogono/odgn-talk/issues/721) must implement the
  shared contract. Their generated tables are updated, not their execution.
- Move this candidate into `corpus/disassembly/nothing-defaults/` and stage
  runtime/diagnostic Trace cases for all acceptance groups only when every
  consumer can pass. The existing TS and Go shared-opcode coverage checks
  deliberately remain unchanged and currently fail for the three new opcodes.
- [Release/parity #722](https://github.com/odogono/odgn-talk/issues/722) owns
  language 1.0-rc.3 activation, version regeneration, Trace headers and Group
  Fingerprints, cross-Core values/errors/Fuel/Trace agreement in ordinary and
  restored execution, and human first blessing. Version declarations remain
  unchanged here; this draft must not be released with the old version.
- Runtime Trace expectations have not been generated or blessed. The native
  tests are evidence of TS behavior, not cross-Core parity or blessing.

## Known failing gates

Until #720 and #721 land, the TS and Go shared-opcode coverage checks fail for
the three new opcodes, and Zig cannot compile its exhaustive runtime switch
over the new Opcode enum values. Run results for this draft belong in the PR.

See the [TS support guide](../../ts/README.md#nothing-defaults-and-optional-map-reads)
and [migration guide](../../../docs/migrations/nothing-defaults.md).
