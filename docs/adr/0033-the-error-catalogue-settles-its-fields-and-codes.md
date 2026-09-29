# The error catalogue settles its fields and codes

Every catalogue field has one meaning. `at` is always the source position the Core adds (ADR 0017). A position inside the input is a separate field: `offset`, a 1-based Character index into text, or `path`, a list of keys and 1-based indices into a value. A code has one base set of fields wherever it is raised, and a raise that knows more adds optional fields next to them. So `wrong kind` is always `{expected, got, value}`, and a Capability argument that breaks its Shape also carries `capability`, `operation`, `argument` and `path`. An uncaught `host error` ends the Run as `errored`, like any other error, so there is no `host error` Run outcome. The Core raises a Standard Capability's codes when it can check the condition itself. Otherwise the Host fails with a code that the fixed Operation Declaration lists, and the Core checks it. Each error an ADR left without a code now has one. We chose this because the ADRs disagreed about `at`, about the fields of `wrong kind` and `can't convert`, and about who may raise the Standard Capability codes, and chapter 6 has to state one catalogue (#90). One meaning per field means that `throw e` still rethrows with its original position, and that one `catch {code: "wrong kind", expected: e}` works for an operator and a Capability alike. Parity covers the catalogue fields exactly (ADR 0017), so each field needs one definition that both Cores can meet. Settled in #99.

## Considered Options

- **`at` for the input position, with another name for the source position on those codes:** these errors would lose the source position that every other error has, and `at` would stop being one reserved key with one meaning.
- **`wrong kind` for a Shape with its own field list (`{operation, argument, expected}`):** a Script would need two `catch` heads for one mistake.
- **A display form for Shapes, so that `expected` could name a whole Shape:** new spec surface that both Cores would have to match byte for byte. The first node that doesn't match already says what went wrong.
- **Naming arguments in `wrong kind`:** Operations take positional arguments (`Args []Shape`), so there are no names to give.
- **A separate `host error` Run outcome:** it would add a `send failed` reason and an exception to the rule that `on error` fires only for `errored`. A Host already learns of its own fault from the error map's `code` and the `call failed` report.
- **Standard Capability codes outside the catalogue, raised freely by the Host:** parity would then cover their fields only by convention.
- **Typed Host results, such as `calendar` returning `ZoneUnknown`:** new API surface in both Cores, when `Fail` with a declared code does the same job.
- **Declared error codes kept only for tooling:** a `catch` completion would then list codes the Host could ignore, and the Standard Capability rule would have no check behind it.
- **`wrong kind` for ordering a text against a number:** neither operand is wrong on its own, only the pair, so `expected` and `got` don't fit.
- **Kind names in `can't compare`:** a date-only value and a date-time are both Civil Dates, so both names would read `civil date`.
- **`send failed` with a new reason for a partner outside the restored set:** it's the same situation as a restored Host call that nobody settled, and `send failed`'s reasons stay about receivers that ran.

## Consequences

- **Positions:** narrows ADRs 0017, 0021, 0023 and 0024.
  - `at` is always the Handler and source position, added by the Core only when it is missing.
  - `can't decode` carries `{format, offset}`, and `not encodable` carries `{kind, path}`.
  - A `parseDate` or `parseNumber` mismatch carries `offset`, the 1-based Character position where the match failed (ADR 0011).
  - `offset` and `path` aren't reserved, so a Host `Fail` may use them.
- **`wrong kind`:** narrows ADRs 0015 and 0030.
  - The fields are always `{expected, got, value}`. `expected` and `got` are kind names.
  - For a Capability argument that breaks its Shape, the fields describe the first node that doesn't match, searched depth-first in argument order. `argument` is the argument's 1-based position, and `path` locates the node when it isn't the argument itself. The Core adds `capability` and `operation` as it does for every Capability error.
  - A `OneOf` expects its kind names joined with `" or "`. For a missing key, `got` is `"nothing"`. For an extra key in a closed map, `expected` is `"nothing"`.
  - `"007" + 1`, a number plus a Quantity and `if 0` (ADR 0003) raise it. `if 0` expects `"boolean"`.
  - ADR 0021's line that JSON encoding raises `wrong kind` is superseded, as ADR 0021 itself says. It raises `not encodable`.
- **`can't convert`:** narrows ADRs 0017, 0023 and 0024.
  - The fields are always `{value, to}`. `to` is the target kind, e.g. `"number"` or `"civil date"`.
  - A parse adds `offset`, and `parseDate` adds its template as `format`. So `parseNumber` gives `{value, to: "number", offset}`.
  - A bad `as` target raises it (ADR 0022).
- **`out of domain`:** always `{function, value}`. `function` is the function's name, and `value` is the offending argument: for `format`, the missing key, and for `sortBy` or `sortWith`, the direction text.
- **`send failed`:** narrows ADR 0017. `reason` says why no answer came. It is one of `errored`, `limit fault`, `cancelled`, `unhandled`, `dropped`, `stopped` or `function gone`, and the last comes only from the Host's `Call`. A stale call from inside a Script still raises `function gone` itself (ADR 0025).
- **`host error`:** narrows ADR 0015.
  - An uncaught `host error` ends the Run as `errored`, with its error map, and `on error` fires as for any error.
  - The embedding interface drops the `HostErrored` / `"host error"` outcome. The Host-side detail still goes in the `call failed` report.
- **`object gone`:** narrows ADR 0016. Reading or setting a property of a disposed Host Object raises it with `{object}`, before the Host's `Get` or `Set` runs.
- **Reserved keys and declared codes:** narrows ADRs 0017 and 0026, and the embedding interface from #72.
  - A Host `Fail`'s `Data` may not use `code`, `message`, `at`, `capability`, `operation`, `index` or `during`. `errors.toml` lists them once.
  - An Operation Declaration's error codes are enforced when it lists them, as ADR 0017 says. A `Fail` with any other code becomes `host error`. The `ErrorDecl` comment from #72, which said the Core doesn't check, is corrected.
- **Standard Capability codes:** narrows ADRs 0017, 0023 and 0024.
  - The Core checks a locale tag's BCP 47 well-formedness before the Host function runs, and raises `bad locale` itself.
  - The fixed `calendar` declarations list `unknown zone` and `ambiguous time`. A `Fail` with a catalogue code that its Operation declares is allowed through. The Core checks its fields against the catalogue, and a mismatch becomes `host error`.
  - The Host's answer is a Host Input, so parity still holds.
- **New codes:** narrows ADRs 0002, 0003, 0022 and 0023.
  - `division by zero`, with no fields.
  - `overflow`, with `{operator}`, the operator or function whose result's exponent left the decimal range.
  - `can't compare`, with `{left, right}`, the two operands. It is raised by `<` or a sort outside comparable kinds, including a date-only value against a date-time, or an Instant against a Civil Date.
  - `incompatible units`, with `{left, right}`, the two Units' display forms. It is raised for a dimension mismatch, `1 month + 1 day`, and a date-only value plus an exact duration that isn't a whole number of days.
- **Widened codes:** narrows ADRs 0008, 0011, 0013 and 0023.
  - `out of range` is a value outside the range its position allows, with `{field, value}`. It now also covers a `character` or `word` write past the end, at index 0 or over a reversed range (`field` is the chunk word, and `value` is the index or `[from, to]`). It also covers a Binary Pattern build value too large for its segment (`field` is the segment type, e.g. `"uint16"`). A non-integer or a Quantity there is `wrong kind`.
  - `call lost` is a restored wait that can't be kept. It now also covers a `send … and wait` whose partner is outside the restored set.
- **The catalogue:** each entry in `errors.toml` lists the fields every raise carries and, separately, the optional ones. Chapter 6 writes the template messages.
