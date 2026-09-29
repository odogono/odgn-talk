# Text Patterns run on our own linear-time matcher, with no backreferences or lookaround

Text Patterns compile to our own IR and run on one linear-time matcher (a Pike VM with RE2-style semantics) in every core, never on the Host's regex engine. As a result, the language has no backreferences and no general lookaround (`preceded by`, `followed by`). Only zero-width anchors (`word break`, `line start`/`line end`, `text start`/`text end`) remain. There is no raw-regex escape hatch. Quantifiers are greedy by default, and `or` is leftmost-first. This breaks with SenseTalk's Pattern Language, which relies on backreferences, lookbehind and lazy-by-default quantifiers on ICU's backtracking engine. We chose this because of the sandbox bar. Neither Go `regexp` nor JS `RegExp` can be fuel-metered, and a backtracking matcher's cost can grow exponentially with the shape of the pattern. A linear-time matcher keeps matching Fuel bounded by pattern size × input length, and it charges that Fuel identically on both cores under the Cost Model (ADR 0006). Greedy-by-default is there because in SenseTalk, `the occurrence of <"$", digits> in "$895"` gives `"$8"`, which is a beginner trap.

## Considered Options

- **A fuel-metered backtracking matcher for an advanced layer:** this would mean two engines in each core, and Fuel costs a Script author can't predict. Rejected.
- **Linear-time lookaround over fixed-length literals:** possible, but most real uses are better written as a Capture. It's left out of v1 and can be added later without breaking Scripts.
- **A raw-regex escape hatch (an RE2 subset):** this adds a second surface syntax to specify and keep equal across cores, and it pulls users away from the readable form. Left out of v1.
- **SenseTalk's lazy-by-default quantifiers:** they make whole-value matches come out the same either way, but search results surprise people. `lazily` is available in the advanced layer instead.

## Consequences

- A Capture inside a repetition is a load-time error, because the matcher keeps one slot per Capture. Scripts use `every match` instead.
- Typed Elements and `as <kind>` convert after the match, and the matcher never goes back to try another split. `as` is therefore allowed only where the conversion can be proven to succeed at load time.
- Adding lookaround or an escape hatch later is backwards compatible. Adding a backtracking engine would not be.
- Narrowed by ADR 0027: `lazily` is an Advanced Construct, tagged in `grammar.toml`. It loads and runs like any other construct, and a `beginner` Lint Profile flags it.
- Settled by #61: inside `<…>` the anchors are two-word phrases (`text start`, `text end`, `line start`, `line end`, `word break`), decided on two tokens. `end` on its own means nothing there, even though it is a Reserved Word elsewhere.
