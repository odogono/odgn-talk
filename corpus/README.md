# The Conformance Corpus

The cases both Cores must pass, bit for bit ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). Their formats are in [chapter 11](../spec/11-the-trace-and-conformance.md) of the Spec.

| Directory | What its cases pin |
| --- | --- |
| [`examples/`](examples/) | worked examples of the format |
| [`save-restore/`](save-restore/) | save and restore: mid-Segment preemption, pending-call settlements, cross-Script `send … and wait` pairs, variables-only restores, Grants and Libraries the Host no longer has, and overdue `wait`s after a restore ([chapter 10](../spec/10-save-and-restore.md)) |
| [`limits/`](limits/) | exhaustion points, at dispatch too, Segment rollback, virtual-Clock deadlines, and each counted limit at its conformance minimum ([chapter 6](../spec/06-errors-and-limits.md)) |
| [`text-patterns/`](text-patterns/) | successive searches past empty matches, leftmost-first `or`, greedy defaults, matching Fuel, pattern size and repetition limits, and the canonical source of a pattern that starts with a group ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs)) |
| [`bytes/`](bytes/) | building and matching Bytes with Binary Patterns, Bytes chunks and searches, build errors, and the Value Encoding of Bytes ([chapter 4](../spec/04-expressions-and-statements.md#binary-patterns)) |
| [`quantities/`](quantities/) | arithmetic and `as` through Base Units, `incompatible units`, and the Value Encoding of Quantities and ranges ([chapter 3](../spec/03-values.md#quantities)) |
| [`text-model/`](text-model/) | whole-Character boundaries, NFC at join seams and at the Host's text constructor, `word` and `word break` on punctuation, chunk padding on writes, and out-of-range reads ([chapter 3](../spec/03-values.md)) |
| [`errors/`](errors/) | whole error maps, with their keys in order ([chapter 6](../spec/06-errors-and-limits.md#errors)) |
| [`dates/`](dates/) | Civil Date and Instant arithmetic, offsets, the date Built-ins and their errors, and the Value Encoding of dates ([chapter 3](../spec/03-values.md#dates-and-times)) |
| [`libraries/`](libraries/) | calls into Libraries, their defaults, Constants, Handlers and Function Values, errors and Limit Faults in Library code, and adding Libraries to a Group ([chapter 7](../spec/07-libraries-and-the-standard-library.md#libraries)) |
| [`math/`](math/) | the correctly rounded number functions, the Float Built-ins, and their domain errors ([chapter 7](../spec/07-libraries-and-the-standard-library.md#numbers)) |
| [`decisions/`](decisions/) | Decisions and their Verdicts ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)) |
| [`disassembly/`](disassembly/) | Disassembly Cases: the lowering of expressions, Containers, Destructuring, control flow and `try`, calls and Lambdas, and messages and waiting, which between them emit every instruction ([chapter 8](../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering)) |

## Unblessed seed cases

The seed cases were written before any Core existed. Until a case is blessed, its `case.trace` has its `>` Host Input lines and its Core output lines written by hand, and says so in its header:

```text
# Unblessed: the output lines are written by hand, not by bless.
```

- **What a case pins** (its records, their order, its ids, values, error codes, instructions and source positions) is worked out from the Spec, and is what a Core is checked against.
- **Fuel, allocation and Persistent State figures** are estimates, except where a case says in a comment that it pins one and shows how it is worked out from Cost Model 0.
- **Code identities** are left out of `load` and `add-library` lines, which an author may do, and bless fills them in.
- **Instruction indices** in `at=` come from `bun tools/machine/check.ts --dis <file>`, which isn't normative. Blessing checks them against a Core.

A human reviews each case's diff when it is first blessed, and a case whose hand-written lines turn out to be wrong is fixed then, with a Spec fix if the Spec was unclear.

The Trace Cases in [`text-model/`](text-model/), [`quantities/`](quantities/), [`bytes/`](bytes/), [`dates/`](dates/), [`math/`](math/) and [`libraries/`](libraries/) are blessed by the TS Core, the only Core available, so their Fuel, allocation and Persistent State figures are Cost Model 0's. So are twelve more: `alloc-exhaustion-point`, `call-depth-minimum`, `fault-at-dispatch`, `fuel-exhaustion-point` and `pattern-size-minimum` in [`limits/`](limits/), and `empty-match-skipped-after-match`, `empty-matches-step-one-character`, `greedy-by-default`, `lazily-prefers-fewer`, `lazily-stays-on-its-element`, `or-is-leftmost-first` and `pattern-size-made-at-run-time` in [`text-patterns/`](text-patterns/). The Go Core must agree before they count as blessed by both.

## The Disassembly Cases

The cases under [`disassembly/`](disassembly/) were written with the TS Core's lowering, and their expected `.dis` files were written by `bun run corpus:run --bless`, with the TS Core the only Core available ([chapter 11](../spec/11-the-trace-and-conformance.md#bless)). They await their first human review, as every case does, and the Go Core must agree before they count as blessed by both.

## Checking

```sh
bun run corpus:check          # what CI runs: every case reads as chapter 11 says
bun run grammar:check         # every .talk file here parses
bun run machine:check         # and lowers
bun run corpus:run            # the TS Core runs the case kinds it implements, and blessed Trace Cases
bun run corpus:run text-model/chunk-write-padding   # replays a named case, blessed or not
```

[`tools/corpus/check.ts`](../tools/corpus/check.ts) reads each `case.toml` and `case.trace` against [`corpus.toml`](../spec/data/corpus.toml) and the display form. It doesn't run anything, so a case that passes it can still be wrong ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
