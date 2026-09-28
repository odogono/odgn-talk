# One predictive grammar with a small reserved core, contextual keywords and per-construct modifiers

The grammar is written once, in a normative notation. The parts most likely to drift live in a machine-readable spec file, `grammar.toml`, which the spec generator (ADR 0010) emits into both Cores: reserved words, operators and precedence, trailing modifiers and where each attaches, the built-in property names, and the rules for Unit suffixes. Each Core hand-writes its own recursive-descent/Pratt parser against it, and the Conformance Corpus holds them to parity. Parsing is predictive, with a fixed lookahead of two tokens and no backtracking. The lexer is modal, and the parser drives it: the parser always knows whether it expects an operand or an operator. Only a small core of structure words is reserved. Every other language word (chunk kinds, Units, Typed Elements, modifiers, pattern keywords) is contextual, and has its meaning only in the positions that give it one. Neither Hosts (ADR 0012) nor Scripts can add syntax. We chose this because parse results must match bit for bit: the lowering is normative (ADR 0010), and load-time diagnostics are covered by parity (ADR 0009). A predictive parser makes "the first token that can't continue" a well-defined error position, which a PEG's farthest-failure heuristic does not. Hand-written parsers are how HyperTalk-family languages get good diagnostics and editor recovery, and a shared table keeps the lists that drift (keywords, precedence) in one place, following ADR 0009's "shared data, not shared logic". Contextual keywords let `put 5 into line` and `line 3 of report` coexist, which a beginner-facing English surface needs.

## Considered Options

- **Parsers generated for both Cores from one grammar file:** the strongest parity, but English-like contextual keywords and good error recovery are hard to get from a generated parser.
- **Prose and EBNF only, with no shared table:** each Core transcribes the keyword and precedence lists by hand, and they drift.
- **PEG with ordered choice:** easy to write, but ordered choice quietly hides ambiguities, and the error position depends on a heuristic.
- **GLR or Earley parsing:** it accepts ambiguity and resolves it afterwards, so it has no single first-error position, and parity of the resolution is hard to specify.
- **Reserving every language word** (HyperTalk in effect): beginners can't name a variable `line` or `s`.
- **Reserving nothing:** some sentences get two parses, e.g. `end` or `then` as variables.
- **Script-defined English-shaped commands:** the grammar would depend on what else is loaded, much like the Host-defined syntax ADR 0012 rejects.
- **A separate delimiter for Text Patterns:** `<…>` reads well, and the operand/operator split already separates it from less-than.
- **Unit suffixes on any expression** (`n kg`): `n kg` could be two operands side by side. Variables convert with `n as kg`.
- **One general postfix rule for all trailing modifiers:** `add part as number to sum` and `x is y ignoring case` want different attachment points.
- **A continuation character** (HyperTalk's `¬`): brackets and trailing operators already show that a line goes on.
- **Keys that shadow built-in properties:** `the length of m` would change meaning according to the data.
- **Splicing a Pattern value by bare name inside `<…>`:** a keyword added in a later language version would break Scripts that spliced a variable with that name.
- **`script variable x starts at 0`:** wordier, and `=` in a declaration can't be read as a test.
- **A lint or LSP hint for Suspension Points instead of syntax:** the source alone would still not show where other Runs can interleave.
- **Filter and map as functions with lambdas** (`filter(xs, r => …)`): not a beginner surface.
- **`sort … by the wind of each`:** a second implicit name next to `it`.
- **An expression-form `replace` under a different name:** two spellings for one operation.
- **Splicing by default in `put ys after xs`:** a list is one value, so appending it as one element is the consistent reading.

## Consequences

- **Grammar artefacts:**
  - The normative notation carries the productions. `grammar.toml` carries the reserved words, operators and precedence, modifier attachment, built-in property names and Unit-suffix rules, and the generator checks it.
  - The generator rejects a Unit catalogue entry that is a reserved word. Inches are `inch`/`inches`, never `in`.
- **Lexing:**
  - In operand position `<` opens a Text Pattern and `<<` opens a Binary Pattern. In operator position `<` is less-than, and `<<` is a syntax error, since there are no shift operators (ADR 0013).
  - Strings, `<…>`, `<<…>>` and `{…}` are lexer modes. Pattern keywords (`word`, `digits`) exist only inside `<…>`. Inside `<<…>>`, `n bytes` is a field size and `value as type` is a construction field.
  - Tokens are the longest match, so `...` is never `..` followed by `.`. `..` is the binary range operator, and `...` in operand position is spread or rest.
- **Names and keywords:**
  - The reserved core is the structure words, e.g. `on`, `end`, `if`, `then`, `else`, `repeat`, `put`, `into`, `let`, `be`, `send`, `ask`, `tell`, `to`, `match`, `when`, `try`, `catch`, `finally`, `return`. The full list is published in `grammar.toml`.
  - A statement that starts with a non-reserved word is a command call to a Handler (`greet "Ann"`), and `name(args)` is a function call.
  - Handler and message names are one word (`addUp`). A Host maps multi-word events onto one-word names (`beforeClose`).
  - After `ask X to` or `tell X to`, the next word is always an Operation name (ADR 0012).
- **Units:** a numeric literal immediately followed by a catalogue Unit name is a Quantity (`5 s`, `2.50 GBP`). Only literals take suffixes. So `put 5 s into s` works, and `s` can't be used as a variable directly after a number.
- **Trailing modifiers**, each attached to its own construct:
  - `ignoring case` belongs to the comparison or match operator (`a is b ignoring case`).
  - `delimited by` belongs to the chunk expression (`the items of l delimited by ";"`).
  - `as` is a postfix conversion that binds tighter than every binary operator and looser than chunk `of` and `'s`. So `item 2 of line 3 of r as number * 2` means `((item 2 of line 3 of r) as number) * 2`.
- **Keys and parentheses:**
  - `the <word> of m` accesses a key, unless the word is a built-in property (`length`, `keys`, `items`, …) listed in `grammar.toml`.
  - `the "any-key" of m` always accesses a key. A lint flags a map literal with a key that shadows a built-in name.
  - `( … )` in a contextual position means "an expression goes here": `the (k) of m` computes a key, and `<"ID-", (idPat)>` splices a Pattern value. A bare word inside `<…>` is always a pattern keyword or a Capture. A word followed by `:` is always a Capture, so `first:` and `last:` are fine there.
- **Lines:**
  - A newline ends a statement. A line continues while a bracket is open, or when it ends with a binary operator, `&` or a comma. There is no continuation character.
  - The single-line forms are `if … then stmt [else stmt]`. Comments run from `--` to the end of the line.
- **Declarations:** `script variable x = 0` is the initialiser form. `=` means "starts as" only in a declaration and is equality everywhere else.
- **Suspension Points are visible:** narrows ADR 0012.
  - A call to a suspending Operation is written `ask X to op args and wait`, mirroring `send … and wait`.
  - The loader checks the form against the Operation Declaration both ways. `and wait` on an immediate Operation, or its absence on a suspending one, is a load-time error.
  - So a Host that changes an Operation's mode breaks the Scripts that depend on it loudly, at load.
- **Collections:**
  - Filter is `every r in xs [where g]`.
  - Map is `expr for every r in xs [where g]`. `for every` has the lowest precedence, so the whole expression to its left is the projection.
  - Sort is a `sorted by k [ascending | descending]` clause on either form (`every r in clean sorted by the wind of r descending`). It is stable (ADR 0009).
  - The name binds explicitly, so there is no implicit `each`. `every match of <p> in s` belongs to the same family.
  - `put ys after xs` appends `ys` as one element. `put ...ys after xs` splices it in, and so does `[...xs, ...ys]`.
- **`replace`:**
  - At the start of a statement, `replace <p> in c with e` rewrites the Container `c`.
  - In operand position the same words return the new text, and `c` can be any expression (`put replace <p> in names with e into flipped`). `into` ends the expression, because it isn't an operator.
  - Every match is replaced by default, and `replace first <p> …` replaces only the first.
- **Sessions:** narrows ADR 0014.
  - `say x` is sugar for `tell console to write x`, and it is a load-time error without a `console` Grant.
  - At the prompt, an Entry that doesn't parse as a statement but does parse as an expression echoes its value.
  - A lone word is a command if the Session Script has a Handler by that name, and an expression otherwise. The loader knows every Handler, so this is deterministic.
- **Diagnostics and conformance:**
  - Only the first syntax error (its code and position) is normative. Recovery after it is a Core and tooling freedom, for the LSP and formatter.
  - When parsing succeeds, every checker diagnostic is normative, in source order.
  - The corpus needs no new case kind (ADR 0018). Disassembly Cases pin how accepted programs parse, since a different parse lowers differently, and diagnostic Trace Cases pin rejected ones.
- **Left for later:**
  - The productions themselves, the notation's exact syntax and the full reserved list, written with the final spec.
  - A throwaway parser prototype to check the two-token lookahead claim against the syntax sketch.
  - A naming guide for Operations (`ask inbox to ask` reads badly), which belongs with the Host embedding API.
  - Other built-in operations are functions (`the f of x`, `f(x, y)`) unless an ADR adds syntax.
