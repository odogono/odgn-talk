# 12. Sessions and tooling

_Draws on:_ [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [#61](https://github.com/odogono/odgn-talk/issues/61), [#69](https://github.com/odogono/odgn-talk/issues/69), [#71](https://github.com/odogono/odgn-talk/issues/71), [#72](https://github.com/odogono/odgn-talk/issues/72), [ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md), [ADR 0042](../docs/adr/0042-block-ending-suffixes-are-optional-and-explicitness-is-lint-advice.md), [ADR 0045](../docs/adr/0045-the-session-host-follows-its-runs-through-the-trace.md).

A REPL or Playground session is an ordinary Host running an ordinary Script Group. The Cores have no session concept ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)). This chapter states how that Host, the **Session Host**, turns Entries and Session Commands into Host Inputs, and what it prints. Its behaviour is normative, because a Session Transcript is a Conformance Corpus case, which must replay the same on the Go REPL and the TS REPL. The rest of the tooling is one TS stack, and nothing it produces is normative ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## The session

- **One Group, one Script:** the Session Host makes a Group named `session` holding one Script, the Session Script, also named `session`. It owns no Host Object and binds no well-known objects, so `me` is Nothing, and a Script reaches it by name, as in `send ping to session`.
- **Starting:** the session starts at its first Entry, or its first Session Command other than `:grant` and `:mock`. The Session Host then loads the Session Script from empty source.
- **Grants:** `console`, with both its Operations, and whatever `:grant` and `:mock` added before the session started. They are fixed from then on, since only loading binds Grants ([chapter 10](10-save-and-restore.md#extend-script)).
- **Limits:** the default limit profile ([chapter 6](06-errors-and-limits.md#limits)). `:limits` tightens it for later Entries.
- **Libraries:** the stdlib Libraries are always registered, so `use pad from text` works at the prompt ([chapter 7](07-libraries-and-the-standard-library.md#imports)). User Libraries come in with `:library`.
- **Pumps** have no Fuel Slice and no Fuel cap, so a Segment always runs to its end within one Pump.
- **Costs:** `console`'s Operations and every mock Operation cost nothing.
- **The Clock** is real by default, and virtual under `:clock virtual`.
- **The end of the Message Path:** a message that reaches it is reported, not an error, since the Session Script's path is flat.

### The console

`console` is a Standard Capability ([chapter 7](07-libraries-and-the-standard-library.md#console)).

- **`say`:** a Command Call named `say` with one argument, and no `and wait`, is short for `tell console to write` with that argument, whatever Handlers the Script has ([ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md)). It lowers to `tell console write 1` ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#statements)). `say` with no argument, more than one, or `and wait`, is a load error. A Script without a `console` Grant can't use it, as with any `tell`.
- **Writing:** the Session Host prints the text form of the value, then ends the line. A line break inside the text starts a new line, so `say "a" & newline` prints `a` and then an empty line.
- **Reading:** the Session Host answers `read` with the next line the user types.

## Entries

An Entry is decided on its first token ([chapter 2](02-grammar.md#entries)). It is one declaration, one statement or one expression, so several make several Entries, and it is atomic: a syntax error or any load-time diagnostic rejects the whole Entry, prints each diagnostic, and changes nothing.

### The session source

The Session Host keeps the **session source**: the Session Script's declarations, in the order they were entered, with each redefinition in its place. `:export` writes it, and every Reload the Session Host makes loads it. So a session means exactly what its export means as a file ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)).

### Declarations

- **New names:** a declaration whose names the Session Script doesn't have yet extends the Script, with the Entry as its source ([chapter 10](10-save-and-restore.md#extend-script)), and is added to the end of the session source. Nothing stops.
- **Redefining** replaces the old declaration in the session source, then reloads the Script from it with its Script Variables carried over ([chapter 10](10-save-and-restore.md#reload)):
  - `on m` replaces every clause of `m`, at the first one's place. So a Handler built at the prompt has one clause, and a Library can hold more.
  - `function f` and `constant c` replace the old declaration in its place.
  - `use` takes the names it reuses out of the earlier `use` lines, dropping any line left empty, and is added at the end.
- **Discarded Runs:** the Reload discards every Run, and the Session Host prints each one ([Output](#output)).
- **A Reload that fails** leaves the session source and the Script as they were.
- **`script variable x = e`** for an `x` the Script already has sets its initialiser in the session source, then runs `put e into x` as a statement Entry, with no Reload. With no initialiser, it runs `put nothing into x`.

### Statements and expressions

A statement or an expression runs as a Run of an implicit Handler:

1. **Implicit Script Variables:** each name the Entry binds outside its Lambdas as a Container's root or with a Capture that binds, that the Script doesn't have, becomes a Script Variable, starting as Nothing. Each is added to the session source as `script variable x`, in the order the Entry first binds them. A name a pattern binds (in `let`, `repeat for each`, `match`, `catch` or `wait for`) stays a local of the Entry's Run, since a pattern binding named like a Script Variable is a `name clash`.
2. **The Handler** is named `entry<n>`, where `n` is the smallest number above the last one used, from 1, that the Script has no name for.
3. **Extending:** the Session Host extends the Script with the source made of these lines, each ended by an LF: `script variable x` for each implicit Script Variable, `on entry<n>`, the Entry's lines, and `end entry<n>`. An expression's first line has `return ` before it. The implicit Handler isn't added to the session source.
4. **Running:** the Session Host requests `entry<n>` from the Session Script, with no arguments and the `:limits` override, and pumps.

- **Positions** of the Entry's own diagnostics and errors are shown in the Entry's own lines and columns, not the extension's.
- **`it`** belongs to the Entry's Run, so each Entry starts with `it` as Nothing.
- **Rollback:** a Limit Fault rolls back the Entry's Segment, prompt state included, with no extra rule ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).

### The foreground

After it pumps, while the Entry's Run hasn't ended, the Session Host:

- **answers `console`'s `read`,** if the Run waits on it, with the line the user types, and pumps again.
- **under a real Clock,** if the Run waits only for a deadline (a `wait`, or a `wait for` or block `wait for` with no call pending), sleeps until the Pump's next deadline, and pumps again.
- **otherwise returns the prompt,** and the Run goes on in the background. Under a virtual Clock, a deadline wait returns the prompt at once.

- **Following Runs:** the Session Host learns which Run an Entry's Delivery started, which Run made each `console` call, and what the Foreground Run waits for, from the Trace's `seg` and `call` records, never from `Inspect()`, which is a Host Input ([ADR 0045](../docs/adr/0045-the-session-host-follows-its-runs-through-the-trace.md)).
- **Echo:** when an expression's Run completes, its value is printed in the display form, which tells `"5"` from `5`.
- **In the background,** the Session Host pumps whenever the next deadline comes under a real Clock, and after every Entry and Session Command that queues a Host Input.
- **Answers:** the Session Host pumps after answering a `read`, and after a built-in Capability's suspending call is answered.
- **Ctrl-C** is `:cancel` of the foreground Run. The Session Host makes Host calls only between Pumps, so a Run spinning in one Segment ends at its Fuel limit.

### Output

Everything a session prints is one of these lines. `<where>` is `<line>:<column>` in the Entry, or `<unit>:<line>:<column>` elsewhere.

| Line | Printed for |
| --- | --- |
| a value, in the display form | the result of an expression Entry |
| the text, line by line | a `console` write by the foreground Run |
| `[<run>] ` and any line in this table | the same, for a Run in the background, or one not started by an Entry |
| `! error <map> at <where>` | an uncaught error, as its map without `message` and `at` |
| `! limit fault <limit> at <where>` | a Limit Fault, with the `fault` record's limit word |
| `! cancelled` | a cancelled Run |
| `! <code> at <line>:<column>` | each syntax error or load-time diagnostic of an Entry, in its own lines |
| `! unhandled <message> <args>` | a message that reached the end of the Message Path, with its arguments as a list |
| `! discarded <run>` | each Run a Reload or a restore discarded |
| `call <call> <capability>.<operation> <args>` | each call of a mock Operation, with its arguments as a list |
| `! <reason>` | a refused Session Command or Entry: a Host error's code, or `unknown command`, `bad arguments`, `session started`, `clock is real`, `no such run`, `no such call` or `no such save` |

## Session Commands

A Session Command is a `:`-prefixed instruction to the session itself, not part of the language, which no Script can issue. The catalogue is [`session.toml`](data/session.toml):

<!-- generated: session.commands -->

| Command | Written | Does | Notes |
| --- | --- | --- | --- |
| `:grant` | `:grant <name> <capability> [<binding>]` | Grants the session a Capability the REPL or Playground Host has built in, or a mock one, under `<name>`, with a `calendar` Grant's default zone or a `locale` Grant's default tag as `<binding>` | before the session starts |
| `:mock` | `:mock <capability>.<operation> <mode>` | Defines a mock Operation, with up to eight arguments and any result, costing nothing, and grants its Capability under its own name; `<mode>` is `immediate`, `suspending` or `fire-and-forget` | before the session starts |
| `:stub` | `:stub <capability>.<operation> <value> \| :stub <capability>.<operation> fail <error>` | Queues the result of the next call of a mock immediate Operation, or an error map to fail it with |  |
| `:answer` | `:answer <call> <value>` | Answers a pending call of a mock suspending Operation |  |
| `:fail` | `:fail <call> <error>` | Fails a pending call of a mock suspending Operation with an error map |  |
| `:clock` | `:clock [real \| virtual [<instant>] \| advance <duration>]` | Shows the Clock, switches it between real and virtual, or advances a virtual Clock by an exact duration and pumps |  |
| `:limits` | `:limits [<limit> <value> \| reset]` | Shows the limits later Entries run with, tightens one of the limits a Delivery may override, or clears every override |  |
| `:cancel` | `:cancel [<run>]` | Cancels a Run, by default the latest Entry's Run if it hasn't ended |  |
| `:runs` | `:runs` | Lists every Run that hasn't ended |  |
| `:mailbox` | `:mailbox` | Lists every message waiting in the Session Script's mailbox |  |
| `:vars` | `:vars` | Lists the Session Script's Script Variables and their values |  |
| `:save` | `:save [<name>]` | Saves the session under `<name>`, or `default`, in the Host's memory |  |
| `:restore` | `:restore [<name>]` | Restores the session saved under `<name>`, or `default` |  |
| `:library` | `:library add <name> <path> \| :library replace <name> <path>` | Adds a user Library from a file, or replaces one, carrying Script Variables over |  |
| `:export` | `:export [<directory>]` | Shows the Session Script's source, or writes it and each user Library to a directory as `.talk` files |  |
| `:help` | `:help [<command>]` | Shows help | not recorded |
| `:quit` | `:quit` | Ends the session | not recorded |

<!-- end -->

- **Values** in a command, such as a Stub's value or an error map, are written in the display form ([chapter 11](11-the-trace-and-conformance.md#the-display-form)). An error map needs a text `code`.
- **Mocks:** `:mock` defines an Operation whose result has the `any` Shape, and which declares eight arguments, each an Optional `any`, so a call may give from none to eight. It declares no error codes. A call to one prints a `call` line, which names it by its Capability, whichever Grant the call goes through, and lists the arguments the call gave. An immediate one takes the next `:stub` queued for it, as a Trace Case's runner does ([chapter 11](11-the-trace-and-conformance.md#stubs)), and with none fails as `host error`. A suspending one waits for `:answer` or `:fail`, and a fire-and-forget one just succeeds.
- **Stubs in the Trace:** `:stub` writes its `stub` line into the Trace where it was entered, as a Trace Case's runner does, so a Session Transcript's `case.trace` replays as a Trace Case.
- **`:grant`** names a Capability the REPL or Playground Host has built in, or one `:mock` defined. Which Capabilities are built in is the Host's choice.
  - **`<binding>`** is the Grant's binding, which the Core reads when it checks a call ([chapter 7](07-libraries-and-the-standard-library.md#standard-capabilities)): a default IANA zone id for `calendar`, and a default BCP 47 tag for `locale`. With none, they bind `UTC` and `und`, so a Transcript replays with the binding it was recorded with. A binding for any other Capability is refused with `bad arguments`.
  - **A mock** can't take the name of a Standard Capability a REPL or Playground may build in: `clock`, `calendar` or `locale`.
- **`:clock`:**
  - `:clock` prints `real <instant>`, the last Pump's reading, or `real` alone before the first Pump, or `virtual <instant>`, the virtual Clock's instant, which the next Pump reads.
  - `:clock virtual` starts a virtual Clock at the instant given, or else at the current reading. A Transcript always records the instant. One earlier than the last Pump's reading is refused with `clock backwards`, since the Clock never goes backwards.
  - `:clock advance d` moves a virtual Clock on by the exact duration `d`, a Quantity in the display form such as `5 s`, and pumps. Under a real Clock it is refused with `clock is real`, and a negative duration, or anything but an exact duration, with `bad arguments`.
  - `:clock real` goes back to the real Clock. A real reading earlier than the last Pump's is taken as the last Pump's, so the Clock never goes backwards.
- **`:limits`:**
  - `:limits` prints each limit a Delivery may override, one per line as `<name> <value>`, by its `ts` name: `fuelPerRun`, `allocPerRun`, `maxWaitMs` and `maxJoin`.
  - `:limits <name> <value>` sets that override for every Entry requested afterwards. It can only tighten the default limit profile, and a looser value is refused as `invalid value`. Runs started by a `send` keep the Script's limits.
  - `:limits reset` clears every override.
- **`:runs`** prints one line per Run that hasn't ended, from `Inspect()` ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)): its id, its status (`ready`, `suspended`, `parked` or `preempted`) and its Handler, then, for a suspended one, the end reason it suspended at, `until <instant>` if it has a deadline, and the ids it waits for, each separated from the last by a space.
- **`:mailbox`** prints one line per message waiting: its delivery id, or the call or Run that sent it, then its name and its arguments as a list.
- **`:vars`** prints one line per Script Variable, in declaration order, as `<name> = <value>`.
- **`:save` and `:restore`** wrap the same-core save ([chapter 10](10-save-and-restore.md)). A save is kept in the Host's memory with the Session Host's own state: the session source, the next `entry<n>`, the `:limits` override, the Clock and the queued Stubs. `:save` prints `saved <name>`. `:restore` replaces the session's Group with one restored with `RejectMismatch`, adopts every pending call, and prints `restored <name>`, then `! discarded <run>` for each Run the restore discarded. The restore uses the user Libraries the session has then, so one replaced since the save makes it refuse as `save mismatch`.
- **`:library`:** `add` compiles the file and adds the Library, and `replace` replaces it, carrying Script Variables over ([chapter 7](07-libraries-and-the-standard-library.md#registering-identity-and-replacing)). A Transcript records it as `> :library add <name>` or `> :library replace <name>`, followed by the Library's source as `|` lines, instead of the path.
  - **Its source** is its lines, each ended by an LF, so a file whose last line has no line break is read as if it had one. Every user Library's version is `1`, and replacing one keeps it.
  - **Refused here:** `add` for a name the session has already added is refused as `name reused`, and `replace` for one it hasn't as `library mismatch`, without a Host Input. A Library that doesn't compile prints each of its diagnostics as `! <code> at <library>:<line>:<column>`.
- **`:export`** prints the session source, its `use` lines included. Given a directory, it writes the session source as `session.talk` and each user Library as `<name>.talk`, and prints `wrote <file>` for each, with the file's name in the directory.
- **`:help` and `:quit`** aren't recorded, and what they print is outside parity.

## Session Transcripts

A Session Transcript records a session in a form a user can read and share: its Entries and Session Commands in order, with everything the session saw from outside, and what it printed ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). A REPL writes one as the session goes, and a Playground link can carry one. In the Corpus, it is a `session.transcript` file with a blessed `case.trace` beside it ([chapter 11](11-the-trace-and-conformance.md#session-transcripts)).

<!-- generated: ebnf.transcript-lines -->

```ebnf
Transcript     ::= ( TranscriptLine #xA )*
TranscriptLine ::= '> ' [^#xA]+ | '| ' [^#xA]* | '|' | '< ' [^#xA]* | '<'
                 | '@ ' Instant | '~ ' Id ' ' Answer | '#' [^#xA]*
                 | "'" [^#xA]* | OutputLine
Answer         ::= Value | 'fail ' MapValue
OutputLine     ::= [^>|<@~#'#xA] [^#xA]*
                   /* an output line that is empty or starts with one of
                      these characters is written after a `'` */
```

<!-- end -->

- **`> `** starts the first line of an Entry, or a Session Command.
- **`| `** starts each further line of an Entry, or a line of the source that `:library` records. A `|` alone is an empty one.
- **`< `** starts a line the user typed for `console`'s `read`, and a `<` alone is an empty one.
- **`@ `** gives a real Clock reading, and comes before every Pump under a real Clock. The first `@` after an Entry, a Session Command, or a `<` or `~` line is the reading of the Pump that line causes. Any other `@` is a Pump the Session Host made at a deadline, and replay makes it there. A virtual Clock needs no `@` lines, since it moves only at `:clock` commands.
- **`~ `** gives the answer a built-in Capability returned for a call, as its value or as `fail` and an error map: its `code`, its `message` and its other fields, or `{}` for a failure that isn't a Script error, which the Script sees as `host error`. It comes where the answer arrived: after the line that caused an immediate call, or where a suspending call's answer came, which causes a Pump.
- **`#`** starts a comment, which a REPL never writes.
- **Every other line** is output. An output line that is empty, or that starts with `>`, `|`, `<`, `@`, `~`, `#` or `'`, is written after a `'`.

> **Example.**
>
> ```text
> > :clock virtual 2026-09-30T10:00:00Z
> > put 2.50 GBP into price
> > price * 3
> 7.50 GBP
> > "5"
> "5"
> > on greet name
> |   say "hello " & name
> | end greet
> > greet "Ann"
> hello Ann
> > 1 / 0
> ! error {code: "division by zero"} at 1:3
> ```

### Replaying

- **Replaying** gives each Entry and recorded Session Command, in order, to a fresh Session Host, with each `@` reading as that Pump's Clock reading, each `<` line as the answer to `read`, and each `~` line as the answer of its call, in place of the built-in Capability. It never writes a file: `:export` with a directory writes to a scratch one.
- **Both must match:** the printed lines must equal the Transcript's output lines, and the Group's Trace must equal `case.trace` ([chapter 11](11-the-trace-and-conformance.md#running-a-case)).
- **In the Corpus,** a Transcript grants only `console` and mock Capabilities, since which Capabilities a REPL has built in, and what they cost, is each Host's own.
- **Bless** writes `case.trace` and fills in the output lines, only when every available REPL agrees, as for a Trace Case.

## Tooling

The command is `northtalk`, the editor language ID is `northtalk`, and the language server launches as `northtalk lsp` ([ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md)).

The LSP, the formatter, the debugger and the Lint engine are one TypeScript tooling stack, under Bun or Node for editors and in a browser worker for the Playground, built on the TS Core's own parser and checker ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)). The Go REPL is the only Go tooling, and has no Lints, formatter or debugger. A Script in a Go Host is debugged by replaying its Trace on the TS Core.

### The normative line

- **Normative:** the first syntax error and every load-time diagnostic ([chapter 2](02-grammar.md#syntax-errors), [codes](02-grammar.md#load-time-diagnostics)), the display form, the source map ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#the-source-map)), the lowering, and Session Transcripts.
- **Tooling freedom:** the formatter's output, the LSP's features, Lints and the debugger. None of them adds a case kind to the Corpus, and changing one is never a language change.
- **One parser:** the TS Core's parser gives a lossless syntax tree, comments and blank lines included, and goes on after the first error. The tooling uses that tree, and the Core compiles from the same parse, so the first error the tooling reports is the Core's.

### Layers and Lints

The Beginner Surface and the Advanced Constructs are a tooling view over one language ([ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md)).

- **Every Core accepts everything,** whatever the Host or profile. A layer never changes what loads, what the Corpus covers or how a Script runs, and a beginner's Script can import any Library.
- **The tags:** an Advanced Construct is one [`grammar.toml`](data/grammar.toml) tags `advanced` ([chapter 2](02-grammar.md#advanced-constructs)). A construct is tagged only if a Beginner Surface form does the same ordinary job and a beginner reading it couldn't guess what it means, and its tag names that form. Moving a construct between layers changes only `grammar.toml`.
- **A Lint** is advice about a Script that loads, and never rejects it. Each has a stable kebab-case id, and a level in each Lint Profile: `off`, `hint` or `warning`. There is no `error` level.
- **Lint Profiles:** `beginner` and `standard`. The Host sets the default, such as a beginner Playground, and a user may override it.
- **Explicit endings:** `prefer-explicit-end` flags each bare block-ending `end` at that token, suggesting the matching `end <name>` or `end <keyword>`. It is a warning in `beginner` and off in `standard`, using the existing suppression convention. It never prevents loading or execution. Bare endings are a style choice, not Advanced Constructs; beginner examples use explicit endings.
- **Suppressing:** `-- lint: ignore <id>` on the line before suppresses one Lint there. It is a comment, not syntax.
- **The catalogue** is the tooling's `lints.toml`, with a wording template per Lint. It is published, but adding, removing or re-levelling a Lint is never a language change.

> **Note.** The first Lint catalogue, with levels as `beginner` / `standard`: a likely bug is a warning in both, a trap only beginners fall into is a warning and then a hint, and a style suggestion is a hint in both.
>
> | Id | Flags | Levels |
> | --- | --- | --- |
> | `advanced-construct` | an Advanced Construct | warning / off |
> | `prefer-explicit-end` | a bare block-ending `end`, suggesting its matching explicit ending | warning / off |
> | `suggest-ignoring-case` | a text comparison that probably wants `ignoring case` | hint / off |
> | `unreachable-clause` | a Handler Clause that an earlier clause always wins over | warning / warning |
> | `pin-trap` | a pattern name that shadows a Script Variable, and so binds rather than compares | warning / hint |
> | `is-empty-on-missing-key` | `is empty` on a key the map may lack | warning / hint |
> | `whole-value-when` | a whole-value `when <"WARN">` probably meant as `when contains` | warning / hint |
> | `try-write-before-fail` | a Script Variable written inside `try` before a statement that can fail, since a caught error rolls nothing back | warning / warning |
> | `inline-block-lambda` | a block Lambda written inline as an argument, rather than named first | hint / hint |
> | `long-join-body` | a Join body whose head scrolls out of view | hint / hint |
> | `plain-send-in-join` | a plain `send` inside a Join, probably a forgotten `and wait` | warning / warning |
> | `conditional-join-member` | a Join Member inside an `if`, which makes the length of `it` depend on the data | warning / hint |
> | `serialised-self-join` | a Join that sends to `me` for a message whose clauses all opt out of concurrency | warning / warning |
> | `key-shadows-property` | a map literal key that shadows a Built-in property | warning / warning |
> | `unknown-message` | a Handler for a message the Host Manifest doesn't declare | hint / hint |
> | `ambiguous-ignoring-case` | a trailing `ignoring case` after an `and` or `or` chain, which binds only to the nearest comparison | warning / hint |
> | `shadows-builtin` | a Script name that shadows a Built-in Constant or function | warning / hint |
> | `unconvertible-literal` | a literal text given to `as civil date` or `as instant` that can't convert | warning / warning |

### The formatter

- **No options:** one layout for every project.
- **Line breaks are never added or removed,** since a line break ends a statement. The formatter changes only indentation, 2 spaces per block, spacing within a line, and runs of blank lines, keeping at most one.
- **Comments and tokens:** it keeps every comment exactly, only re-indenting it, and never changes a token's spelling.
- **Its invariants,** held by the tooling's tests: formatting is idempotent, and it never changes a unit's canonical disassembly, apart from the source positions it shows.

### The LSP

- **Diagnostics:** the normative errors and the Lints.
- **Completion:** Operations from the Grants, `catch` patterns from declared error codes, names from imports, message names from the Host Manifest, and Units and chunk words where the grammar allows them.
- **Hover:** a Constant's value in the display form, an Operation's Declaration, and a Function Value's Home Script.
- **Navigation:** go to definition and find references across imports, and rename.
- **Suspension marks:** a mark on every Suspension Point and every Handler or Lambda that may suspend. They add to the `wait` the source must already have, including a Join's `wait for all` head, and never replace it.
- **Formatting,** through the formatter.
- Everything else, such as semantic highlighting and code actions beyond quick fixes for Lints, is the implementation's.

### The debugger

- **Two modes:** live, against the TS Core in the Playground or a Bun Host, and replay, from any Trace, including one taken on a Go Host.
- **Breakpoints** map through the source map to an instruction, and pause the whole Group at that instruction's boundary, through a tooling-only hook in the TS Core ([Appendix C](appendix-c-handed-off-open.md)).
- **A pause isn't a Host Input:** it costs no Fuel and leaves the Trace unchanged, and Fuel Slices count Fuel, not time. While paused, the Group is shown in the same form as `:runs`, `:mailbox` and `:vars`, read through the tooling hook rather than `Inspect()`, which is a Host Input. Resuming continues the same Run.
- **Stepping** in, over and out works by statement. Stepping over a Suspension Point goes on until this Run resumes past it, while other Runs execute, and a breakpoint in any of them pauses the Group. Stepping into a `send … and wait`, or a call to a Function Value in another Script, follows the message into the receiving Run. Each Run's view shows its Segment number and the Fuel it has used.
- **The Clock:** live, the debugger's Host supplies Clock readings and subtracts paused time, so deadlines don't all fire on resume. In replay, the readings come from the Trace.
- **Faults:** "break on error", caught or not, and "break on Limit Fault" pause before any rollback, so the state that caused it can be seen.
- **No edits:** the debugger never writes Script state, and changing code is a Reload.
- **Going back:** replay offers "run to Host Input *n*" and reverse steps, by replaying again from the start or from a save.
- **Replaying a live Host's Trace,** the debugger answers every Host crossing from the Trace's own records ([chapter 11](11-the-trace-and-conformance.md#stubs)), and lands each early `Stop` or `CancelRun` at the instruction its `pc` names.

### The Host Manifest

Tooling learns what a Host offers from the Host Manifest it exports for each kind of Script: its Grants and their Operation Declarations, the Libraries a Script may import, the messages it may receive with their argument Shapes, and the Host Object kinds and well-known objects ([chapter 9](09-embedding.md#the-host-manifest-format)). The Core never reads it, so a stale manifest can only mislead tooling. The Playground builds its manifest from its own Grants.

### The Playground

- **Public name:** NorthTalk Playground.
- **It ships** the LSP in a worker, the formatter, live debugging, and replay debugging of a pasted Trace.
- **Libraries** are tabs, and saving one replaces it, recorded as `:library replace`.
- **Sharing** is source only: a link carries the Session Script's source and, optionally, a Session Transcript, which replays on opening. So a bug report can arrive as a link and be debugged in replay mode.

## Outside parity

- **The tooling:** the formatter's output, the LSP's features, the debugger, the Lint catalogue and its wording, and the Advanced tags ([ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
- **The REPL's own interface:** its prompt, line editing, colours, `:help` and `:quit`, and how it is told where to write a Transcript.
- **Built-in Capabilities:** which ones a REPL or Playground offers to `:grant`, and their answers, which a Transcript records.
- **The TS Core's tooling hooks,** for pausing and for landing an early `Stop` or `CancelRun` in replay ([Appendix C](appendix-c-handed-off-open.md)).
