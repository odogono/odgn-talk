# Layers are a tooling view over one language

The language has two layers, the Beginner Surface and the Advanced Constructs, but the Cores see neither. Every Core accepts the whole language. A layer never changes what loads, what the Conformance Corpus covers or how a Script runs, and a beginner's Script can import any Library. An Advanced Construct is a grammar construct or Built-in property tagged `advanced` in `grammar.toml`. The tag passes a two-part test: a Beginner Surface form does the same ordinary job, and a beginner reading the construct couldn't guess what it means. The promise of the Beginner Surface is that a beginner never needs an Advanced Construct to do something ordinary. Layers are enforced only as advice: a Lint in the `beginner` Lint Profile flags an Advanced Construct, and Lints are tooling, outside the Cores and outside parity. We chose this because an enforced layer would be a second language under parity. Checker diagnostics are normative (ADR 0019), so a layer that rejects code would need a second acceptance mode in both Cores and its own diagnostic corpus cases. Every reclassification would then be a language change. A tooling view still gives most of what enforced teaching subsets such as Racket's HtDP levels and Hedy exist for. A beginner who strays into an Advanced Construct, or falls into a trap such as a pattern name that shadows a Script Variable, gets a warning worded for a beginner. The Playground, completion and docs can show the Beginner Surface first. And because a tag needs the test and a named replacement, every new construct must either read well to a beginner or say why it doesn't. What we give up is the guarantee: a beginner Playground can't refuse advanced code.

## Considered Options

- **A syntax subset the parser enforces** (Racket's HtDP teaching languages, Hedy): a beginner's typo that happens to form advanced syntax is caught as an error, in terms the beginner knows. But the layer becomes a second acceptance mode in both Cores, pinned by the corpus, and a layer change becomes a language change.
- **A per-Script opt-in** (a `use advanced` declaration or a Host load option, like Haskell's `LANGUAGE` extensions, Rust editions or Perl's `use strict`): the same cost as an enforced subset, plus a switch, and a declaration the Cores must parse.
- **Docs only:** nothing checks anything, and a construct's layer is whatever the last page said.
- **Graded levels** (three or more, as HtDP and Hedy have): they suit a curriculum, and a curriculum belongs in the docs. The design discipline needs one binary boundary that ADRs can point to.
- **No layers, only lint groups** (Clippy's `pedantic` and `restriction`): it loses the promise that a beginner never needs an Advanced Construct, and with it the test new constructs must pass.
- **Clippy-style groups, with a Lint in several named groups:** more flexible, but two Lint Profiles are all this needs. Groups can be added later without breaking any Lint id.
- **Normative Lints, emitted by both Cores and pinned by the corpus:** a Lint never changes behaviour, so parity has nothing to protect, and every new Lint would be a language change.
- **Tagging functions (Built-in or Library) as advanced:** a function is guessable from its name, and ADR 0021 keeps the stdlib neutral.
- **Advanced by one test alone:** "a Beginner Surface form substitutes" would tag every readable shorthand, such as `, queued`. "A beginner can't guess it" would tag constructs with no beginner alternative, which breaks the promise.
- **A Lint engine in each Core:** every tool would get Lints, but they would be written twice and drift, with no parity to catch it.
- **An in-source profile directive:** a language-shaped line that both Cores would have to parse and ignore.

## Consequences

- **Mechanism:**
  - Every Core accepts every construct, whatever the Host or profile. The corpus has no layer dimension and no new case kind.
  - A Library written with Advanced Constructs can be imported by any Script. The layer is a property of source text, not of a Script, Library or Host.
  - "Explicit" in the audience goal (#1) is met by a published tag on each Advanced Construct, not by enforcement.
- **The test:**
  - A construct is Advanced only if a Beginner Surface form does the same ordinary job, even wordily or slowly, **and** a beginner reading it couldn't guess what it means.
  - An ADR that tags a construct Advanced names the Beginner Surface form that replaces it.
- **Where tags live:** narrows ADR 0019.
  - `grammar.toml` carries an `advanced` tag on grammar constructs and Built-in property names, and nothing else can be tagged.
  - The tags are published with the language version but aren't covered by parity. Moving a construct between layers changes only `grammar.toml`, never the Cores or the corpus.
- **Lints and profiles:** narrows ADR 0019.
  - A Lint is advice from tooling about a Script that loads. It never rejects code. Checker diagnostics reject and are normative; Lints advise and are not.
  - Each Lint has a stable kebab-case id and a level per Lint Profile: `off`, `hint` or `warning`. There is no `error` level.
  - There are two Lint Profiles, `beginner` and `standard`. The Host sets the default, e.g. a beginner Playground, and a user may override it in their editor settings.
  - `-- lint: ignore <id>` on the line before suppresses one Lint there. It is a tooling convention, not syntax.
  - The catalogue lives in a tooling `lints.toml`, with a wording template per Lint. It is published but not normative, and adding, removing or re-levelling a Lint is never a language change.
  - There is one Lint engine, in the TS tooling, built on the TS Core's parser and checker and used by the LSP, the Playground and the TS REPL. The Go REPL has no Lints.
- **The first classification:**

  | Construct | Beginner Surface form | Layer |
  |---|---|---|
  | The pin, `{order: ^orderId}` | `{order: o} where o = orderId` | Advanced |
  | A pinned outer variable as a Binary Pattern size | a Guard on the length the pattern read | Advanced |
  | The `code point` chunk and the `code points` property | Characters | Advanced |
  | `lazily` on a Text Pattern element | a narrower element | Advanced |
  | Per-element `"x" ignoring case` inside `<…>` | — (it reads as what it does) | Beginner |
  | Splicing a Pattern value, `<"ID-", (idPat)>` | — (the same `( … )` rule as `the (k) of m`) | Beginner |
  | Destructuring Lambda parameters, `given {wind: w}: w > 10` | — (the Destructuring of Handler Clauses) | Beginner |
  | The Match Search, `every match of <p> in s` | — | Beginner |

  - Nothing else is tagged. Lambdas, Joins, Queueing Policies, Binary Patterns, `f(x) and wait`, and `...rest` and spread are all Beginner Surface.
  - `codePoint(c)` and `fromCodePoint(n)` are functions, so they are untagged.
  - Capture `ranges` is a field of a match result, not a construct, and only the docs cover it.
- **The first Lint catalogue:** levels are given as `beginner` / `standard`. A likely bug is a warning in both, a trap only beginners fall into is a warning and then a hint, and a style suggestion is a hint in both.

  | Id | What it flags | Source | Levels |
  |---|---|---|---|
  | `advanced-construct` | an Advanced Construct | this ADR | warning / off |
  | `suggest-ignoring-case` | a text comparison that probably wants `ignoring case` | ADR 0011 | hint / off |
  | `unreachable-clause` | a Handler Clause that an earlier clause always wins over | #4 | warning / warning |
  | `pin-trap` | a pattern name that shadows a Script Variable, and so binds rather than compares | syntax sketch | warning / hint |
  | `is-empty-on-missing-key` | `is empty` on a key the map may lack | syntax sketch | warning / hint |
  | `whole-value-when` | a whole-value `when <"WARN">` probably meant as `when contains` | syntax sketch | warning / hint |
  | `try-write-before-fail` | a Script Variable written inside `try` before a statement that can fail, since a caught Error rolls nothing back | ADR 0017 | warning / warning |
  | `inline-block-lambda` | a block Lambda written inline as an argument, rather than named first | #54 | hint / hint |
  | `long-join-body` | a Join body whose head scrolls out of view | ADR 0026 | hint / hint |
  | `plain-send-in-join` | a plain `send` inside a Join, probably a forgotten `and wait` | ADR 0026 | warning / warning |
  | `conditional-join-member` | a Join Member inside an `if`, which makes the length of `it` depend on the data | ADR 0026 | warning / hint |
  | `serialised-self-join` | a Join that sends to `me` for a message whose clauses all opt out of concurrency | ADR 0026 | warning / warning |
  | `key-shadows-property` | a map literal key that shadows a built-in property | ADR 0019 | warning / warning |

- **Narrows:**
  - ADR 0011: the per-element `ignoring case` in Text Patterns is Beginner Surface, not advanced.
  - ADR 0019: Lints are not checker diagnostics and are not normative, and `grammar.toml` carries the `advanced` tags.
  - ADR 0021: its Layering line is resolved. Layering applies through tags and Lints, and the stdlib still takes no position.
  - ADR 0025: Destructuring Lambda parameters are Beginner Surface.
- **Left for later:**
  - The spelling of a pinned outer variable as a Binary Pattern size (ADR 0013).
  - Whether `with` over tagged results and a `throw "code"` shorthand exist at all (ADR 0017). Being Advanced can't justify adding a construct.
  - Each Lint's wording and the `long-join-body` threshold, written with the tooling.
  - The LSP, formatter and debugger design, in #1's tooling fog.
- Narrowed by ADR 0028: a fourteenth Lint, `unknown-message` (hint / hint), flags a Handler for a message the Host Manifest doesn't declare. The Lint engine is part of the one TS tooling stack.
