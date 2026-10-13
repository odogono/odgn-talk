# Staged Nothing defaults case

`main.talk` stages parser, runtime and Disassembly coverage for #719, outside
the shared Corpus until Go (#720) and Zig (#721) can consume the new syntax.
The TS test executes this source and checks all three instructions. It does
not replace or weaken the shared opcode coverage gate.

No expectation has been generated or blessed. At #722 integration, move this
source into a shared Disassembly Case, add its case.toml with the required
Unblessed header, and generate expectations through the corpus workflow.
First blessing is a separate human review after cross-Core agreement and
language 1.0-rc.3 activation. Current support is in the
[TS guide](../../../README.md) and [migration guide](../../../../../docs/migrations/nothing-defaults.md).
