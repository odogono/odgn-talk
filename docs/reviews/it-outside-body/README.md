# Out-of-body `it` expectation approval

The fix for [#774](https://github.com/odogono/odgn-talk/issues/774),
TS [#779](https://github.com/odogono/odgn-talk/issues/779) and
Zig [#781](https://github.com/odogono/odgn-talk/issues/781) merged in
[PR #789](https://github.com/odogono/odgn-talk/pull/789), commit
`179bc738e26febda42c5b771ee1736a630ca2043`.
On 2026-10-13, the maintainer approved the first blessing of
[`load-diagnostics/it-outside-body/case.trace`](../../../corpus/load-diagnostics/it-outside-body/case.trace).
The approval was given in the issue-781 conversation: “yes i approve the
blessing”. Only the `Unblessed` header is removed; all Host Inputs, output
records, code identities, positions and resource figures remain byte for
byte unchanged. No implementation or Data File work remains for these issues.

## Expected diagnostics

[Chapter 4, Bodies and locals](../../../spec/04-expressions-and-statements.md#bodies-and-locals)
makes `it` a local of each Handler, function and Lambda body. An initialiser
or parameter default is outside that body, so the
[name-resolution rules](../../../spec/04-expressions-and-statements.md#resolving-a-name)
give each unbound `it` an `unknown name` diagnostic.
[Chapter 2](../../../spec/02-grammar.md#load-time-diagnostics) also requires
one `not constant` at the first disallowed token in each Constant or Script
Variable initialiser or parameter default. Diagnostics at the same position
put `unknown name` before `not constant`, in catalogue order.

The seven rejected Scripts pin these exact records:

- [constant.talk](../../../corpus/load-diagnostics/it-outside-body/constant.talk):
  `unknown name`, then `not constant`, at `1:14`.
- [script-variable.talk](../../../corpus/load-diagnostics/it-outside-body/script-variable.talk):
  `unknown name`, then `not constant`, at `1:21`.
- [parameter-default.talk](../../../corpus/load-diagnostics/it-outside-body/parameter-default.talk):
  `unknown name`, then `not constant`, at `1:16`; the function body's `it`
  remains valid.
- [constant-later.talk](../../../corpus/load-diagnostics/it-outside-body/constant-later.talk):
  `not constant` for `v` at `2:15`, then `unknown name` for both `it` tokens
  at `2:18` and `2:22`.
- [script-variable-later.talk](../../../corpus/load-diagnostics/it-outside-body/script-variable-later.talk):
  `not constant` for `v` at `2:21`, then `unknown name` at `2:33`.
- [parameter-default-later.talk](../../../corpus/load-diagnostics/it-outside-body/parameter-default-later.talk):
  `not constant` for `v` at `2:16`, then `unknown name` at `2:20`.
- [repeated-it.talk](../../../corpus/load-diagnostics/it-outside-body/repeated-it.talk):
  `unknown name`, then `not constant`, at `1:14`, followed by `unknown name`
  at `1:27`, even though `otherwise` may skip the fallback at runtime.

The final `vars` record contains only `bodylocals`, confirming the seven
refused loads installed no Scripts.

## Preserved body locals and resource figures

[body-locals.talk](../../../corpus/load-diagnostics/it-outside-body/body-locals.talk)
loads and runs on two Deliveries. The function returns its own `it` after
`echo(7)`, and its caller's `it` becomes 7. The Lambda created by the Constant
initialiser has its own initially Nothing `it`. The block Lambda returns its
own `it` after `echo(9)`. The final result is `[7, nothing, 9]`.

The trace records Fuel 85, allocation 112 and Persistent State 80 on each
Delivery. Applying [Cost Model 0](../../../spec/data/costs.toml) to the
[chapter 8 lowering](../../../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering)
gives 46 Fuel for the Handler's executed instructions, 4 for clause selection,
16 for `bodyIt` including `echo`, 3 for the initialiser Lambda and 16 for the
block Lambda including `echo`: 85 total. A capture-free closure allocates 32;
the result list occupies `16 + 8 * 3 + 16 + 8 + 16 = 80`, giving allocation
112 and final Script Variable state 80. The Constant's closure was created
at load, outside these Runs.

## Verification

At checkout `adf5b70f0d4d1ea092c92888db3ed2d017ecd380` on 2026-10-13:

- TS, Go and Zig reproduce the complete 36-line Trace in ordinary and
  automatic save/restore replay.
- Go's `TestItOutsideBody` and `TestItBodyLocal` pass; all 97 TS checker
  tests pass; `zig build test`, including checker and C API tests, passes.
- The shared case is required by both Go and Zig passing gates.
- The Go, TS and Zig implementation guides already describe the supported
  diagnostics and body-local behavior.

Reproduce from the repository root after the Cores' documented prerequisites:

```sh
bun run corpus:run load-diagnostics/it-outside-body
go -C impl/go run ./cmd/corpus load-diagnostics/it-outside-body
(cd impl/zig && zig build corpus -- load-diagnostics/it-outside-body)
go -C impl/go test ./internal/check -run 'TestIt(OutsideBody|BodyLocal)$'
bun test impl/ts/tests/checker.test.ts
(cd impl/zig && zig build test)
```

The maintainer's approval above is separate from execution agreement and
follows the [first-blessing workflow](../../../corpus/README.md#seed-blessing).
