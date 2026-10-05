# Handlers name their parameters with Argument Labels that join the Selector

A Handler may name its parameters after the first with Argument Labels: `on move piece to square`. A Command Call then writes the labels between its arguments: `move knight to "e4"`. The labels join the message name to make the message's Selector, `move:to:`, with a colon after each part. Arguments stay positional, so a Handler Clause is still chosen by Selector, argument count, patterns and Guard, and a message with no labels keeps its plain name. Any word that isn't a Reserved Word may be a label, except `with` and `from`. The Reserved Word `to` may be one too. `send` gets a target-first form for labelled messages: `send to board: move knight to "e4"`.

We chose this because a positional Command Call such as `move knight, "e4"` doesn't say which argument is which, and a map argument (`move {piece: knight, to: "e4"}`) is noisy. English-shaped call sites are the HyperTalk and AppleScript tradition the language comes from. Making the labels part of the Selector means a call is checked where it lands, even when it climbs the Message Path to a Handler the loader can't see: `move knight from x` can never reach `on move piece to square`. The parser spike on #338 found the design needs no new two-token decision and changes no valid source. It costs some error positions, which we accept.

Settled in #338.

## Considered Options

- **A closed list of label words**, drawn from Reserved Words and FOLLOW words. This would keep ADR 0019's rejection of Script-defined English-shaped commands intact. But it limits labels to prepositions the spec lists, and the open set needs no extra decision: a label always comes in operator position after a complete argument, where any word is an error today.
- **Labels as sugar over a positional message** `move`, checked at load where the callee is visible. Labels would be lost on a `send` and up the Message Path, so `move knight from x` and `move knight to x` would reach the same Handler unchecked.
- **Labels that build a map argument** (`{piece: …, to: …}`). This is close to today's idiom, but parameter names would matter at run time, and it fights Destructuring patterns in Handler heads.
- **Spelling the Selector `move to` or `moveTo`.**
  - A space-separated name loses the slot positions and is easy to mistype at the Host.
  - A camelCase join can collide with a real one-word Handler `moveTo`.
- **Allowing `from` as a label.** `wait for … from <source>` already reads `from` and an operand as the event's source, so a Selector with a `from` label couldn't be waited for in labelled form.
- **Allowing `in`, `into`, `with` or `of` as labels.** Each already continues an expression or a statement:
  - `x is in r` and `every match of p in s`;
  - `put … into`;
  - `send … with`, `begins with` and line continuation after `with`;
  - chunk `of`.
- **Labelled arguments inside `send … with … to target`.** With `to` as a label, `send move with knight to "e4" to board` can't be decided in two tokens.
- **Other `send` spellings for labelled messages.**
  - A parenthesised phrase, `send (move knight to "e4") to board`, puts the target last, after a long phrase.
  - `send move:to: with knight, "e4" to board` brings the Host's spelling into Scripts.
- **Label-first heads** (`on go to x`). With an open set, telling the label from a parameter would need a second token, and that would change how `on move piece` reads.
- **Commas inside a labelled slot** (`on move piece to x, y`). Commas would compete with clause arity and with the `, queued` suffixes.
- **Banning chunk words or Unit names as labels.** Adding a Unit to the catalogue would then break Scripts. The existing reading wins instead, and brackets avoid the trap.
- **Labelled functions** (`f(x)`). ADR 0035 already rejects named arguments at `(`, and functions keep positional parameters.
- **Label metadata in the Host Manifest.** The Selector already encodes the labels, and tooling can split it.
- **Treating the Selector as an opaque string at the Host boundary.** A malformed Selector would go unhandled and climb the Message Path instead of failing at the Host's own call.

## Consequences

- **Supersedes ADR 0019** in two places:
  - Its rejected option "Script-defined English-shaped commands" is reversed for Argument Labels. Scripts still add no other syntax.
  - "Handler and message names are one word" now applies to a Selector's parts: each part is one Name.
- **Syntax:**
  - A Handler head is one unlabelled leading Pattern, then any number of `label Pattern` pairs, then the Guard and suffixes: `on move piece to square where …, queued`.
    - A head with labels has no commas between parameters.
    - There is no label-first head.
  - A Command Call is one argument, then `label argument` pairs (`move knight to "e4" and wait`). Otherwise it is a positional list, as now.
  - A label is decided on one token: a label word in operator position after a complete parameter or argument.
  - A label at the end of a line doesn't continue the line, because operator-position words such as `times` validly end one.
- **`send`:**
  - `send to <target>: <command phrase> [and wait]` takes any Command Call phrase, labelled or positional.
  - `send to` is decided on one token, because `to` is reserved and can't name a message. So is the `:` after the target.
  - `send m with … to t` is unchanged.
- **Other positions:**
  - `pass move to` names a Selector by its words, without parameters.
  - `end move` takes the first word only, and stays optional (ADR 0042).
  - `wait for move p to sq` mirrors the head.
- **Sessions:** narrows ADR 0019's Session rule. A non-reserved word starts a Command Call if the Session Script has a Handler whose Selector starts with that word.
- **Dispatch:**
  - A message's name is its Selector everywhere a name appears today:
    - Handler Clause selection;
    - the Message Path;
    - `pass`'s load check;
    - `wait for`'s `it`, which becomes `{name: "move:to:", args}`;
    - the Trace;
    - ADR 0020's clash rule.
  - Handlers still have no defaults (ADR 0035 stands).
- **Host boundary:** narrows ADR 0030.
  - A Host delivers `{Name: "move:to:", Args: [...]}`.
  - The Core refuses a malformed Selector, or a colon count that doesn't match the argument count, at the Host's call.
  - The Host Manifest's `messages[].name` holds the Selector, and the Manifest gets no new fields.
- **Errors:** some mistakes now read as labelled calls. `log error rest` and `say total count` fail at the end of the line, not at `rest` or `count`. A Lint or the LSP may point at the likely word.
- **Traps:** the existing reading wins, and brackets avoid both traps.
  - In `move word toward x`, `word toward …` is a Chunk Expression.
  - In `scale 3 m 4`, `3 m` is a Quantity.
- **Not affected:** functions, Lambdas, Capability Operations and the old `send` form.
- **Delivery:** the spec change for this decision has to land in the same change as this ADR (ADR 0032):
  - chapters 2, 5 and 9;
  - the label word rule in `grammar.toml`;
  - a new language prerelease.

  Corpus cases, both Cores, the Manifest tooling and the LSP follow.
- **Checked by the parser spike** (#338, `tools/grammar/spike/`):
  - no new two-token decision and no relexes;
  - the sketch, every `talk` block in `docs/` and `spec/`, the stdlib and the corpus all parse unchanged with labels on.
