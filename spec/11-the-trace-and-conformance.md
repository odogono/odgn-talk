# 11. The Trace and conformance

**Pending addition:** [Store Notification conformance](proposals/store-notifications.md#conformance) adds Core scenarios, a router kit and Session Transcripts. Notifications are ordinary `deliver` inputs, so no Trace record changes. None of these cases exists yet.

_Draws on:_ [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md), [#71](https://github.com/odogono/odgn-talk/issues/71), [#79](https://github.com/odogono/odgn-talk/issues/79), [ADR 0060](../docs/adr/0060-errors-may-transfer-to-named-recovery-offers-chosen-before-unwinding.md).

Both Cores answer to the Spec and the Conformance Corpus, bit for bit ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)). This chapter gives the display form every value is written in, the ids the Core assigns, the Trace a Group writes, and the case kinds of the Corpus and how they are run. The formats are Data Files: the records and the `case.toml` keys are in [`corpus.toml`](data/corpus.toml), and the line grammars in [`trace.ebnf`](data/trace.ebnf).

## The display form

Every value has one display form: a single line of text that names its kind as well as its value, so `"5"` and `5` differ. It is what a Trace, a Session's echo, a Host's `String()` and `toString()`, an error's `message` template and a disassembly's constants write ([chapter 3](03-values.md#the-text-form)). It round-trips: reading a value's display form gives an equal value with the same display form, and both Cores ship its reader ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)).

- **Nothing and booleans:** `nothing`, `true` and `false`.
- **A number** is its [canonical text](03-values.md#the-text-of-a-number), such as `7.50`, `-2.5` or `0.00`.
- **A Quantity** is its number, one space and its [Unit in normal form](03-values.md#printing-quantities): `2.50 GBP`, `1 day`, `3 days`, `0.5 1/s`.
- **Text** is quoted, as [below](#text).
- **Bytes** are `<<`, each byte as `0x` and two uppercase hexadecimal digits, separated by `, `, then `>>`: `<<0x0D, 0x0A>>`, and `<<>>` when empty.
- **A list** is `[`, its items separated by `, `, then `]`: `[1, "a", [nothing]]`.
- **A map** is `{`, its entries in order, separated by `, `, then `}`, as [below](#maps).
- **A range** is its two ends joined by `..`: `3..7`, `-2..-1` or `3 m/s..7 m/s`.
- **A Civil Date or an Instant** is its [ISO 8601 form](03-values.md#date-text): `2026-09-27`, `2026-09-27T14:30:00.5` or `2026-09-27T13:30:00Z`.
- **A Text Pattern** is its [canonical source](#the-canonical-source-of-a-text-pattern), such as `<"ID-", 4 digits>`.
- **A Function Value** is `<function …>`, as [below](#function-values).
- **A Host Object** is `<object`, its kind, its id as text, then `>`: `<object item "object-slot-183">`. Whether it has been disposed isn't shown.

> **Rationale.** The display form needs to read back only through a Core's reader, not as source, where `2026-09-27` would be a subtraction ([ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md)). One form for values also leaves the Corpus one decoder, rather than a tagged-JSON one beside a printer ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)).

### Text

Text literals have no escapes ([ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md)), so text is written as source joins it: pieces separated by ` & `.

- **Plain runs** of code points are written between double quotes.
- **A `"`** is `quote`, **an LF** is `newline`, and **a tab** is `tab`.
- **Hidden code points** are `fromCodePoint(n)`, with `n` in decimal: U+0000 to U+001F other than LF and tab, U+007F to U+009F, U+061C, U+200E, U+200F, U+2028 to U+202E, U+2066 to U+2069 and U+FEFF. So a Trace line never breaks, and no bidirectional control reorders it.
- **Empty text** is `""`.
- **Pieces are split at code points,** not Characters, and reading joins them the same way. Joining pieces of an NFC text gives that text back, so reading changes nothing.
- **Reading gives code points,** as written. A runner builds the value through the Host's constructors, which normalise text to NFC, as they do a Host's ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)). So a Trace Case writes its Host texts in NFC, since the Core writes each Host Input back in the display form of the value it built, and a [Value Encoding case](#value-encoding-cases) is where a text that isn't NFC is shown being normalised.

> **Example.** `"say " & quote & "hi" & quote`, `"a" & newline & "b"`, `"C:\new"` and `fromCodePoint(13) & newline`.

### Maps

- **An entry** is its key, `: ` and its value.
- **A key** that is a Word ([chapter 1](01-lexical-structure.md#tokens)), Reserved Words included, is written bare, as in `{sku: "A1", if: true}`. Any other key is written as text, as in `{"unit price": 2.50 GBP}`. So is `offer`, which source reserves as a key ([chapter 2](02-grammar.md#recovery-offers-and-choices)): `{"offer": 1}`. When such a text would start with `quote`, `newline`, `tab` or `fromCodePoint`, it starts with `"" & ` instead, so it never reads as a Word: `{"" & quote: 1}`.
- **An empty map** is `{}`.

### Function Values

A Function Value is `<function`, a space, its Home Script and where its code is, then its captures, then `>` ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)):

- **A Lambda** is placed by the code unit it is in and the line and column of its `given`: `<function weather:12:3>` in the Home Script's own source, `<function session+3:1:9>` in its third extension, and `<function orders:list:14:7>` in the Library `list`.
- **A named function** of the Script is placed by its name, `<function weather:tax>`, and an imported one by its Library and its name there, `<function weather:text:pad>`.
- **Captures** follow as a map, in the order of their capture slots ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#slots)): `<function weather:12:3 {n: 3}>`. With no captures, the map is left out.
- **Staleness** isn't shown, since it isn't part of the value ([chapter 3](03-values.md#function-values)).

### The canonical source of a Text Pattern

A Text Pattern's canonical source is its source written on one line, with its splices resolved. Two Text Patterns are equal when their canonical sources are ([chapter 3](03-values.md#equality)).

- **Its shape:** `<`, its elements separated by `, `, then `>`, and `<>` with none. Alternatives are separated by ` or `, and every other word by one space.
- **A leading group:** when the first element is a nested `<…>`, one space follows the opening `<`, as in `< <4 digits>, "x">`. So no canonical source starts with `<<`, which starts Bytes, here and in source ([chapter 1](01-lexical-structure.md#modes)).
- **Kept as written:** the elements, their grouping into nested `<…>`, singular and plural keywords, and counts. So `<digit, digit>` and `<2 digits>` are unequal, though they match the same text.
- **A text literal** is written between quotes, in NFC, when its display form is a single quoted piece. Otherwise it is written as its display form in parentheses, which splices the same text: `(quote & "x")`.
- **Keywords, classes, anchors and `a number`** are their words: `uppercase letters`, `text start`, `a number`.
- **Repetitions** are `one or more of e`, `zero or more of e`, `optional e`, and `n e` with `n` in canonical text, so `0x04 digits` is `4 digits`.
- **A Capture** is `name: e`.
- **Suffixes:** each suffix an element has, once, in the order `as number`, `ignoring case`, `lazily`.
- **Splices:** a spliced Text Pattern is its canonical source, as a nested `<…>`. Spliced text is a text literal, as above.
- **Empty groups:** a nested `<>` is left out, since it matches only where the rest would.
- **Not part of it:** a use-site `ignoring case`, which belongs to the operation, not the pattern ([chapter 4](04-expressions-and-statements.md#matching)).

> **Example.** `< "ID" ,(sep),  (tail) >`, with `sep` holding the text `"-"` and `tail` the pattern `<0x04 digits>`, has the canonical source `<"ID", "-", <4 digits>>`. `<last: word, ", ", first: word>` is already canonical. `<(tail), "x">` has the canonical source `< <4 digits>, "x">`, and `<(tail)>` has `< <4 digits>>`.

### Reading it

- **The grammar** below decides where each value ends, so a Trace needs no quoting around values, and `2.50 GBP` is one value.
- **A Unit** follows a number after one space, and is never followed by `=`, so `value=2.50 GBP fuel=9` reads a Quantity, then the key `fuel`.
- **A Text Pattern** is read with the Text Pattern grammar of [chapter 2](02-grammar.md#text-patterns), and a parenthesised piece in it as display-form text.
- **A Function Value or Host Object** is read against the Host that holds it. A Host can't build either, so each one a Trace's Host Input names is one that crossed to the Host earlier: the runner uses the latest value with that display form that it received, and a Host Object that `case.toml` declares.
- **A malformed value** in a case makes the case malformed. That is an error in the case, not a divergence between Cores.

<!-- generated: ebnf.display-form -->

```ebnf
Value          ::= 'nothing' | 'true' | 'false' | Number | Quantity | TextValue
                 | BytesValue | ListValue | MapValue | RangeValue | CivilDate
                 | Instant | PatternValue | FunctionValue | ObjectValue
Number         ::= '-'? Digits ( '.' Digits )?
                   /* canonical text: no leading zeros, and no `-` on a zero */
Digits         ::= [0-9]+
Quantity       ::= Number ' ' UnitText
UnitText       ::= [A-Za-z0-9*/^]+
                   /* a Unit in normal form; never followed by `=` */
TextValue      ::= TextPiece ( ' & ' TextPiece )*
TextPiece      ::= '"' Plain* '"' | 'quote' | 'newline' | 'tab'
                 | 'fromCodePoint(' Digits ')'
Plain          ::= [^"#x0-#x1F#x7F-#x9F#x61C#x200E#x200F#x2028-#x202E#x2066-#x2069#xFEFF]
BytesValue     ::= '<<' ( Byte ( ', ' Byte )* )? '>>'
Byte           ::= '0x' [0-9A-F] [0-9A-F]
ListValue      ::= '[' ( Value ( ', ' Value )* )? ']'
MapValue       ::= '{' ( MapEntry ( ', ' MapEntry )* )? '}'
MapEntry       ::= MapKey ': ' Value
MapKey         ::= Word | TextValue
                   /* a Word exactly when the key is one other than offer; a TextValue key
                      starts with a quoted piece, `"" & ` if need be */
Word           ::= [A-Za-z_] [A-Za-z0-9_]*
RangeValue     ::= RangeEnd '..' RangeEnd
RangeEnd       ::= Number | Quantity
CivilDate      ::= Date ( 'T' Time )?
Instant        ::= Date 'T' Time 'Z'
Date           ::= [0-9] [0-9] [0-9] [0-9] '-' [0-9] [0-9] '-' [0-9] [0-9]
Time           ::= [0-9] [0-9] ':' [0-9] [0-9] ':' [0-9] [0-9] ( '.' [0-9]+ )?
                   /* one to nine fraction digits, the last not 0 */
PatternValue   ::= '<' [^#xA]* '>'
                   /* a Text Pattern's canonical source, read with chapter 2's
                      TextPattern production; `<<` starts Bytes, never this,
                      since a leading nested group is written `< <` */
FunctionValue  ::= '<function ' Word ( '+' Digits )? ':' ( Word ':' )?
                   ( Digits ':' Digits | Word ) ( ' ' MapValue )? '>'
ObjectValue    ::= '<object ' Word ' ' TextValue '>'
```

<!-- end -->

### In a disassembly

The constants of a [canonical disassembly](08-the-abstract-machine-and-the-cost-model.md#the-canonical-disassembly) are written in the display form. The constants that aren't Script values are written like this:

- **A Built-in Constant by name** is its name, such as `pi` or `newline`.
- **A list of map keys** is a list of text, `["sku", "qty"]`.
- **A Text Pattern template** is its canonical source, with `(1)`, `(2)`, … where its splices stand.
- **A list of bit-field widths** is a list of numbers, `[4, 4]`.

## Ids

The Core assigns every id a Trace or a report names, the same way on both Cores. The counters behind them are part of the Group's state, so they carry across Reload, extend Script and save, and a restored Group goes on from its save's counters ([chapter 10](10-save-and-restore.md)).

- **Delivery ids** are `d1`, `d2`, … in the order the Group gives them. A Delivery the Host makes (`Deliver`, `Request`, `Call` or `Decide`) gets one when the call is made, or over the message layer when the Core reads it ([chapter 9](09-embedding.md#rules)), and one refused at the call gets none. Each recipient of a Broadcast gets one when the Broadcast is drained.
- **Broadcast ids** are `b1`, `b2`, … in the order the Group gives them, one for each Broadcast and Broadcast Decision.
- **Run ids** are the Script's name, `/r` and a number counting that Script's Runs from 1 in the order they start, such as `orders/r2`. A Run starts when its message leaves the mailbox, so a Delivery cancelled in the mailbox has no Run.
- **Call ids** are the Run's id, `.c` and a number counting that Run's calls from 1 in the order they start, such as `orders/r2.c1`. A call starts when it reaches its Host function or its receiver's mailbox, so one refused before that gets no id. The calls are every Capability call, every send that waits for a reply (`send … and wait`, a Command Call sent up the Message Path with `and wait`, and a call to a Function Value in another Script), and every Join Member. Automatic scope abandonment also takes a call id from that Run's sequence; Segment hooks use Segment ids and consume no call ids.
- **Segment ids** are the Run id followed by `.s1`, `.s2`, …, counting actual Segments, including cancellation cleanup, but not preemptions. They identify lifecycle hooks.
- **Save ids** are `s1`, `s2`, … in the order the Group's save attempts are made; a refused attempt has an id but no restorable snapshot.
- **Code units** are named by their Script or Library, and a Script's extensions by `<script>+<n>`, counting the extensions since its last Load or Reload from 1, such as `session+3`.
- **Code positions** are a code unit's name, `:` and an instruction index in canonical text, such as `orders:17`.

## The Trace

A Trace is the record of a Group's life: every Host Input it received, in the order it acted on them, and what it observably did in response ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). Because it holds its inputs, a Trace replays on any Core, given the sources and setup it names. A Host asks for one with the `Trace` sink of `GroupOptions` and `RestoreOptions`, or `trace: true` on the message layer's `new-group` and `restore` ([chapter 9](09-embedding.md)). A Group with no sink writes nothing, and behaves the same.

### Lines

<!-- generated: ebnf.trace-lines -->

```ebnf
TraceFile      ::= ( TraceLine #xA )*
TraceLine      ::= ( '> ' )? Record | '#' [^#xA]* | ''
Record         ::= RecordName ( ' ' Id )* ( ' ' Field )*
/* offer-chosen and offer-entered use the ordinary record grammar;
   their ordered attempt/name/at/target/args keys are in corpus.toml. */
RecordName     ::= [a-z] [a-z-]*
Id             ::= [A-Za-z0-9_] [A-Za-z0-9_./:+-]*
Field          ::= Key '=' FieldValue
Key            ::= [A-Za-z_] [A-Za-z0-9_-]*
FieldValue     ::= Value | Id | IdList
                   /* as the key's type in corpus.toml says */
IdList         ::= '[' ( Id ( ', ' Id )* )? ']'
```

<!-- end -->

- **One record per line,** in UTF-8, each ended by an LF, with no trailing spaces. A value's display form never breaks a line.
- **A Host Input** is written after `> `, and the Core's output has no prefix.
- **A record** is its name, then its ids in order, each after one space, then its keys in the order `corpus.toml` lists them, each as `key=value` after one space. A key that isn't optional is always written. An optional one is written only when it applies, a list-valued one only when its list isn't empty, and a value-typed one only when its value isn't Nothing, so a Run that completes with Nothing has no `value`, and neither has a bare `veto`. A map's entries are always written, so a `vetoes` entry keeps `reason: nothing`.
- **Values** are written as their key's type says ([below](#key-types)): a value in the display form, an id, or a list of ids.
- **Comments and blank lines:** a line that starts with `#`, and an empty line, are an author's. The Core writes neither, and comparing ignores them.
- **Only outcomes** are recorded, never single instructions.

### What is recorded, and when

A record is written when what it records happens, so a Trace is in the order the Core acted:

- **Lifecycle records** follow the [scope and participant ordering](embedding/scoped-effects.md). A Host-successful opening/closing `call` is followed immediately by its `scope` acknowledgement, before result conversion or interruption; a malformed result still gives a scope acknowledgement. Automatic abandonment writes `call` with `automatic=yes`, then `scope` with `abandoned` or `failed`; failure writes `effect-failure` next. Hooks write `effect`, followed by `effect-failure` on failure. These precede the affected `seg`, `run`, `decided` or `stopped` records. Host detail strings are outside parity. On a fault, the existing `fault` record precedes the resulting cleanup records.
- **Worker calls** (`load`, `reload`, `extend`, `add-library`, `replace-library`, `save`, `restore` and `vars`) are written when they are made, followed by what they cause, such as `diag`, `stopped` or `vars` records.
- **Queued calls** are written when the Pump that drains them has read its Clock, in the order they were made, and just before that Pump's `pump` line. So a Delivery an author writes just before a `> pump` is where the Core writes it too, and a worker call or a refused input written between them moves before it.
- **A queued call never drained,** because a worker call discarded it first, as a variables-only restore drops the saved input queue, is written just before that worker call's line, in the order the calls were made.
- **A Host Input refused at the call,** with a Host error or `MailboxFull`, is written at the call, with none of the ids the Core would assign, and a `refused` record follows it. It changes nothing. The ids the Host supplies, such as a `settle`'s call id, are kept.
- **Calls made inside a Pump,** from a Host function, land when that function returns: a queued call is drained by the next Pump, and a refused one, a `Stop` or a `CancelRun` is written right after the record of that crossing ([below](#stops-and-cancels-inside-a-pump)).
- **Inside a Pump,** the records follow in the order they happened, and the Pump ends with `pumped`. A Stretch of a Run is written as `seg` or `preempt` when it ends, so the `call`, `send`, `raise`, `guard-skip` and `note` records it made come before it, and a Run's `run` record comes after its last Stretch. A Run's first Stretch carries the start keys (`delivery`, `broadcast`, `from`, `handler`, `fallback`, `clause` and `fn`), whether it is a `seg` or a `preempt`.
- **A Verdict** is written as `decided` right after the record of what settled it. A seal comes at the end of a Segment, so an allowed or vetoed Decision's `decided` follows the sealing `seg`, and comes before the Run's `run`. An undecided Verdict is settled by the Run's end, so its `decided` follows the `run` record, or the `stopped` record for a Run stopped before its seal. A Decision cancelled in the mailbox is settled as it is drained, after its `run` record with no id, and a Broadcast Decision with no recipients as it is drained. An allow at successful dispatch to a clause without `, deciding`, or by a matching `wait for`, is written at that dispatch, before the Handler body’s records and Stretch. A Broadcast Decision with recipients is settled by its last recipient to settle. An open Decision a variables-only restore discarded or dropped is settled in the first Pump, before any Stretch, in delivery id order.
- **A reissued call,** settled with `how=reissue`, crosses to the Host again as the first Pump drains the `settle`: a `call` record under its saved call id, before any Stretch. It has `charged` only if the Host function draws with `Charge`, since the declared cost isn't charged again.
- **Guard regions:** an error raised in a guard region, which skips its clause or branch, is written as `guard-skip` with its code, and not as `raise`. A Guard that gives something other than a boolean is a `guard-skip` with that `value`.
- **An unhandled Delivery** is written as its Run's `seg`, with `end=unhandled`, then its `run`, then the `unhandled` record.
- **Every Host crossing** is recorded: each Capability call as `call`, with an immediate call's result or error and the Fuel it charged, and each property call as `prop`. So a Trace carries every answer a Host gave, and replays without that Host ([chapter 7](07-libraries-and-the-standard-library.md#standard-capabilities)).
- **Errors:** a Core-raised error map is written without its `message`, wherever the map appears, whose wording is outside parity. Every other key is kept, in the order [chapter 6](06-errors-and-limits.md#errors) gives, and so is the `message` of an error a Script or a Host made ([chapter 6](06-errors-and-limits.md#messages)). Text a Script builds from a Core-raised `message` is outside parity too, and no case may depend on it.

### Host Inputs

`*` marks a key an author may leave out, which bless fills in ([below](#bless)), and `?` an optional one. An author may also leave out the ids the Core assigns, such as a Delivery's.

<!-- generated: corpus.inputs -->

| Record | Ids | Keys | Says |
| --- | --- | --- | --- |
| `load` | `script` | `identity`\* | loads the Script that case.toml names, with its source, Grants, owner, well-known objects and limits |
| `reload` | `script` | `carry`, `source`, `identity`\* | reloads the Script from the source given |
| `extend` | `script` | `source`, `identity`\* | extends the Script with an Entry |
| `add-library` | `library` | `identity`\* | adds the Library that case.toml names |
| `replace-library` | `library` | `carry`, `source`, `identity`\* | replaces the Library with the source given |
| `pump` |  | `clock`, `fuel-slice`?, `fuel-cap`? | a Pump, with its one Clock reading |
| `deliver` | `delivery` | `to`, `message`, `args`?, `limits`? | a Delivery |
| `request` | `delivery` | `to`, `message`, `args`?, `limits`? | a Request: a Delivery whose result the Host waits for |
| `broadcast` | `broadcast` | `message`, `args`?, `limits`?, `recipients`\* | a Broadcast |
| `call-value` | `delivery` | `fn`, `args`?, `limits`? | a Host call of a Function Value |
| `decide` | `delivery` | `to`, `message`, `args`?, `limits`? | a Decision |
| `decide-broadcast` | `broadcast` | `message`, `args`?, `limits`?, `recipients`\* | a Broadcast Decision |
| `cancel-delivery` | `delivery` |  | cancels a Request, Decision or Host call, by its delivery id or broadcast id |
| `answer` | `call` | `value`, `fuel`? | answers a suspending call |
| `fail` | `call` | `error` | fails a suspending call |
| `settle` | `call` | `how`, `value`?, `error`? | settles a pending call after a restore |
| `stub` | `operation` | `value`?, `error`?, `charge`? | queues what the Host function returns at the next call of an Operation, named `<capability>.<operation>`: an immediate call's result or error, and any call's charge; the runner writes it, and the Core never sees it |
| `cancel-run` | `run` | `pc`? | cancels a Run |
| `stop` | `script` | `reason`, `pc`? | stops a Script |
| `revoke` | `script` | `grant` | revokes one of the Script's Grants |
| `set-parent` |  | `object`, `parent` | sets a Host Object's parent |
| `dispose` |  | `object` | disposes a Host Object |
| `save` | `save` |  | saves the Group |
| `restore` |  | `from`\*, `mismatch`?, `unbound`?, `withheld`?, `fingerprint`\*, `mode`\*, `pending`?\*, `disposed`?, `discarded`?\*, `dropped`?\*, `abandoned`?\* | restores a Group from a save |
| `counters` | `script` |  | reads the Script's Counters without draining Host Inputs; writes one `counters` record |
| `vars` |  |  | inspects the Group, which writes a `vars` record for each Script in it |
| `stub-effect` | `grant` | `phase`, `status` | queues a synchronous lifecycle hook result for <script>.<granted name>; a runner input, not a queued Core input |

<!-- end -->

<!-- generated: corpus.input-keys -->

| Record | Key | Type | Is |
| --- | --- | --- | --- |
| `load` | `identity` | `hex` | the Script's code identity |
| `reload` | `carry` | `word` | whether Script Variables carry over: `yes`, `no` |
| `reload` | `source` | `value` | the new source, as text |
| `reload` | `identity` | `hex` | the new source's code identity |
| `extend` | `source` | `value` | the Entry's source, as text |
| `extend` | `identity` | `hex` | the extended Script's new code identity |
| `add-library` | `identity` | `hex` | the Library's code identity |
| `replace-library` | `carry` | `word` | whether the reloaded Scripts' Script Variables carry over: `yes`, `no` |
| `replace-library` | `source` | `value` | the new source, as text |
| `replace-library` | `identity` | `hex` | the new source's code identity |
| `pump` | `clock` | `instant` | the Clock reading |
| `pump` | `fuel-slice` | `count` | the Fuel Slice |
| `pump` | `fuel-cap` | `count` | the Group's Fuel cap |
| `deliver` | `to` | `target` | the object or Script it is addressed to |
| `deliver` | `message` | `id` | the message's name |
| `deliver` | `args` | `value` | its arguments, a list |
| `deliver` | `limits` | `value` | its limit override, a map from each limit's `ts` name to its value |
| `request` | `to` | `target` | the object or Script it is addressed to |
| `request` | `message` | `id` | the message's name |
| `request` | `args` | `value` | its arguments, a list |
| `request` | `limits` | `value` | its limit override, a map from each limit's `ts` name to its value |
| `broadcast` | `message` | `id` | the message's name |
| `broadcast` | `args` | `value` | its arguments, a list |
| `broadcast` | `limits` | `value` | its limit override, a map from each limit's `ts` name to its value |
| `broadcast` | `recipients` | `ids` | each recipient, as `<script>:<delivery id>`, in recipient order |
| `call-value` | `fn` | `value` | the Function Value |
| `call-value` | `args` | `value` | its arguments, a list |
| `call-value` | `limits` | `value` | its limit override |
| `decide` | `to` | `target` | the object or Script it is addressed to |
| `decide` | `message` | `id` | the message's name |
| `decide` | `args` | `value` | its arguments, a list |
| `decide` | `limits` | `value` | its limit override, a map from each limit's `ts` name to its value |
| `decide-broadcast` | `message` | `id` | the message's name |
| `decide-broadcast` | `args` | `value` | its arguments, a list |
| `decide-broadcast` | `limits` | `value` | its limit override, a map from each limit's `ts` name to its value |
| `decide-broadcast` | `recipients` | `ids` | each recipient, as `<script>:<delivery id>`, in recipient order |
| `answer` | `value` | `value` | the answer |
| `answer` | `fuel` | `count` | a cost known only now, charged when the Run resumes |
| `fail` | `error` | `value` | the error: a map with `code`, and optionally `message` and the `Data` entries |
| `settle` | `how` | `word` | the settlement: `answer`, `fail`, `reissue`, `adopt` |
| `settle` | `value` | `value` | the answer, for `answer` |
| `settle` | `error` | `value` | the error, for `fail` |
| `stub` | `value` | `value` | the result |
| `stub` | `error` | `value` | an error to fail with instead, as for `fail`, or `{}` to fail with an error that isn't a Script error |
| `stub` | `charge` | `count` | the Fuel the Host function draws with `Charge` |
| `cancel-run` | `pc` | `count` | for one that landed early, the instruction it landed before |
| `stop` | `reason` | `value` | the Host's reason, as text |
| `stop` | `pc` | `count` | for one that landed early, the instruction it landed before |
| `revoke` | `grant` | `id` | the granted name |
| `set-parent` | `object` | `value` | the object |
| `set-parent` | `parent` | `value` | its new parent, or `nothing` |
| `dispose` | `object` | `value` | the object |
| `restore` | `from` | `id` | the save it restores |
| `restore` | `mismatch` | `word` | the Host's policy for a mismatch, when it isn't to reject: `variables-only` |
| `restore` | `unbound` | `ids` | the Grants the Host doesn't re-bind, each as `<script>.<granted name>`, which restore as revoked |
| `restore` | `withheld` | `ids` | the Libraries the Host doesn't pass, by name, so a save that needs one is a mismatch |
| `restore` | `fingerprint` | `hex` | the save's Group Fingerprint |
| `restore` | `mode` | `word` | the kind of restore: `full`, `variables-only` |
| `restore` | `pending` | `ids` | the pending calls, for the Host to settle |
| `restore` | `disposed` | `value` | the Host Objects the Host doesn't resolve, a list, which restore as disposed |
| `restore` | `discarded` | `ids` | for a variables-only restore, the discarded Runs |
| `restore` | `dropped` | `ids` | for a variables-only restore, the dropped Deliveries |
| `restore` | `abandoned` | `ids` | for a variables-only restore, the abandoned calls |
| `stub-effect` | `phase` | `word` | the hook: `begin`, `commit`, `rollback` |
| `stub-effect` | `status` | `word` | the definite or uncertain Host outcome: `ok`, `failed`, `unknown` |

<!-- end -->

- **Sources:** `load` and `add-library` take their source and options from `case.toml`, and the Core writes the code identity, so a replay can check it has the same source. `reload`, `extend` and `replace-library` carry their source, since a setup can't know it in advance. Their `source` field uses display-form text but preserves the source's exact scalar sequence, without NFC normalization on writing or reading, since code identity hashes the source as given. The stdlib Libraries need neither a `[[libraries]]` entry nor an `add-library` line.
- **`restore`** restores the save named by `from`, or else the latest one. The Host's side of it is in the line: `mismatch`, `unbound` and `disposed` are what the runner passes as its policy, leaves out of its `Grants` function and refuses in its `Resolve` function ([chapter 10](10-save-and-restore.md#restoring)).
- **The Libraries a restore is passed:** for each Library name, the runner passes the version it compiled last, from `case.toml` or the latest `replace-library`, except the ones `withheld` names. So a restore after a `replace-library` isn't given the replaced version, and a `withheld` Library the save needs is a mismatch too.
- **Lifecycle Stubs:** `stub-effect <script>.<grant> phase=begin|commit|rollback status=ok|failed|unknown` queues one result for that hook on that named Grant, in FIFO order for that phase. A hook without a Stub makes the case malformed. Ordinary `stub` supplies automatic abandonment results too; its charge must be absent or zero for automatic calls. During replay, recorded `effect` outcomes supply hook answers just as recorded `call` results supply immediate answers; no live database or file is consulted. A scope acknowledgement after `call error={}` distinguishes a Host-successful malformed result from a Host exception: replay supplies a deliberately invalid result, acknowledges the scope transition, and fails Shape validation before conversion.
- **Answers to Standard Capabilities** come as Stubs or `answer` lines, like any other Capability's. `clock`'s `now` needs neither, since its answer is the Pump's Clock reading.
- **`vars`** is `Inspect()` ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)).

### Core output

<!-- generated: corpus.outputs -->

| Record | Ids | Keys | Says |
| --- | --- | --- | --- |
| `seg` | `run`, `how` | `delivery`?, `broadcast`?, `from`?, `handler`?, `fallback`?, `clause`?, `fn`?, `fuel`, `alloc`, `state`, `end`, `until`?, `n`?, `value`? | a stretch of a Run, from its start, a resume or its continuation after a preemption, to the end of its Segment; `how` is `start`, `resume` or `continue` |
| `preempt` | `run`, `how` | `delivery`?, `broadcast`?, `from`?, `handler`?, `fallback`?, `clause`?, `fn`?, `by`, `fuel`, `alloc` | a stretch of a Run that a Fuel Slice or the Fuel cap preempted, from its start, a resume or its continuation after a preemption; `how` is as for `seg` |
| `call` | `call` | `op`, `args`, `result`?, `error`?, `charged`?, `automatic`? | a Capability call |
| `prop` | `run` | `object`, `name`, `op`, `value`?, `error`? | a Host Object property call |
| `send` | `from` | `to`, `message`?, `fn`?, `args`?, `wait`? | a message a Script sent; `from` is the call id of a send that waits for its reply, and otherwise the sending Run |
| `raise` | `run` | `code`, `at`, `pos` | an error raised, whether or not it is caught |
| `guard-skip` | `run` | `at`, `pos`, `code`?, `value`? | a clause or branch skipped because its test raised an error or its Guard gave something other than a boolean |
| `abandon` | `call` |  | a call or Join Member abandoned; for a timeout, after the `raise` it causes |
| `fault` | `run` | `limit`, `at`, `pos`, `rollback`? | a Limit Fault |
| `cleanup-failed` | `run` | `code`?, `limit`? | a cancelled Run's cleanup that failed |
| `note` | `subject` | `kind` | something the Core noted, about a Run, a call or a Delivery |
| `run` | `run` (optional) | `outcome`, `delivery`?, `broadcast`?, `handler`?, `fallback`?, `fn`?, `value`?, `error`?, `limit`?, `effect`?, `fuel`, `alloc` | a `run end` report; the id is absent for a Delivery cancelled before it started |
| `stopped` | `script` | `reason`, `discarded`?, `dropped`?, `abandoned`? | a `stop` report |
| `unhandled` | `delivery` (optional) | `message`, `args`?, `target`? | an `unhandled` report; the id is absent for a message a Script sent |
| `call-failed` | `call` | `op` | a `call failed` report, whose detail is left out |
| `decided` | `delivery` | `verdict`, `vetoes`?, `undecided`? | a `decided` report, by the Decision's delivery id or broadcast id |
| `diag` | `unit` | `code`, `pos` | a load-time diagnostic, or the first syntax error |
| `counters` | `script` | `fuel`, `alloc`, `runs`, `faults`, `state`, `mailbox` | a snapshot of the Script's lifetime work and current state (chapter 9) |
| `vars` | `script` |  | a Script's Script Variables, each as `<name>=<value>`, in declaration order |
| `pumped` |  | `state`, `fuel`, `next`? | the end of a Pump |
| `refused` |  | `code` | the Host Input before it was refused at the call, and changed nothing |
| `scope` | `call` | `grant`, `name`, `action` | the scope transition acknowledged by this Host call, before result validation, conversion or interruption |
| `effect` | `segment` | `grant`, `phase`, `status` | a synchronous participant hook and its result, including hooks outside a Pump |
| `effect-failure` | `run` | `grant`, `segment`, `phase`, `status`, `scope`? | an effect failure report; human-readable Host detail is excluded from parity |
| `offer-chosen` | `run` | `attempt`, `name`, `at`, `target`, `args`? | a successfully charged and validated Recovery Offer choice, before transfer cleanup |
| `offer-entered` | `run` | `attempt`, `target` | entry into a chosen Recovery Offer after cleanup and atomic parameter binding |

<!-- end -->

<!-- generated: corpus.output-keys -->

| Record | Key | Type | Is |
| --- | --- | --- | --- |
| `seg` | `delivery` | `id` | for a start, its Delivery |
| `seg` | `broadcast` | `id` | for a start, its Broadcast |
| `seg` | `from` | `id` | for a start, the call or Run that sent its message |
| `seg` | `handler` | `id` | for a start, the Handler dispatched to |
| `seg` | `fallback` | `word` | for a start by the Fallback Handler, `yes`; `handler` is then the message's Selector: `yes` |
| `seg` | `clause` | `count` | for a start, the clause that matched; an unhandled Run has none |
| `seg` | `fn` | `value` | for a start by a Function Value call, the Function Value |
| `seg` | `fuel` | `count` | the Fuel the stretch used |
| `seg` | `alloc` | `count` | the allocation the stretch made |
| `seg` | `state` | `count` | the Script's Persistent State at the Segment's end |
| `seg` | `end` | `word` | why the stretch ended ([End reasons](#end-reasons)) |
| `seg` | `until` | `instant` | the deadline it waits for, if it has one |
| `seg` | `n` | `count` | for `join-end`, the number of members |
| `seg` | `value` | `value` | for `veto`, the reason |
| `preempt` | `delivery` | `id` | for a start, its Delivery |
| `preempt` | `broadcast` | `id` | for a start, its Broadcast |
| `preempt` | `from` | `id` | for a start, the call or Run that sent its message |
| `preempt` | `handler` | `id` | for a start, the Handler dispatched to |
| `preempt` | `fallback` | `word` | for a start by the Fallback Handler, `yes`; `handler` is then the message's Selector: `yes` |
| `preempt` | `clause` | `count` | for a start, the clause that matched; an unhandled Run has none |
| `preempt` | `fn` | `value` | for a start by a Function Value call, the Function Value |
| `preempt` | `by` | `word` | what preempted it: `slice`, `cap` |
| `preempt` | `fuel` | `count` | the Fuel the stretch used |
| `preempt` | `alloc` | `count` | the allocation the stretch made |
| `call` | `op` | `id` | the Operation, as `<granted name>.<operation>` |
| `call` | `args` | `value` | its arguments, a list |
| `call` | `result` | `value` | for an immediate call that succeeded, the Host's result |
| `call` | `error` | `value` | for an immediate or fire-and-forget call that failed, the Host's error: a map with `code`, and any `message` and `Data` entries, or `{}` for a failure that wasn't a Script error or a result that broke its Shape; a call cut off by a `Charge` the Run can't cover has neither `result` nor `error` |
| `call` | `charged` | `count` | the Fuel `Charge` drew |
| `call` | `automatic` | `word` | Core-triggered scope abandonment; no declared cost, Charge or conversion cost applies: `yes` |
| `prop` | `object` | `value` | the object |
| `prop` | `name` | `id` | the property |
| `prop` | `op` | `word` | a read or a write: `get`, `set` |
| `prop` | `value` | `value` | the value read or written |
| `prop` | `error` | `value` | for a call that failed, the Host's error, as for `call` |
| `send` | `to` | `target` | the receiver; for a Command Call sent up the Message Path, the Script it reaches |
| `send` | `message` | `id` | the message's name, for a message |
| `send` | `fn` | `value` | the Function Value, for a call to one in another Script |
| `send` | `args` | `value` | its arguments, a list |
| `send` | `wait` | `word` | whether the sender waits, and `join` for a Join Member: `yes`, `join` |
| `raise` | `code` | `value` | its code, as text |
| `raise` | `at` | `at` | the raising instruction |
| `raise` | `pos` | `pos` | its source position |
| `guard-skip` | `at` | `at` | the instruction that raised or branched |
| `guard-skip` | `pos` | `pos` | its source position |
| `guard-skip` | `code` | `value` | the error's code, as text |
| `guard-skip` | `value` | `value` | the value that wasn't a boolean |
| `fault` | `limit` | `word` | the limit exceeded: `fuel`, `alloc`, `persistent`, `depth`, `pattern`, `join` |
| `fault` | `at` | `at` | the faulting instruction |
| `fault` | `pos` | `pos` | its source position |
| `fault` | `rollback` | `ids` | the Script Variables the rollback restored, in declaration order |
| `cleanup-failed` | `code` | `value` | the error that ended it, as text |
| `cleanup-failed` | `limit` | `word` | or the limit that ended it: `cleanup`, `alloc`, `persistent`, `depth`, `pattern`, `join` |
| `note` | `kind` | `word` | what it noted ([Notes](#notes)) |
| `run` | `outcome` | `word` | its outcome: `completed`, `errored`, `limit-fault`, `cancelled`, `unhandled`, `dropped`, `effect-failed` |
| `run` | `delivery` | `id` | its Delivery |
| `run` | `broadcast` | `id` | its Broadcast |
| `run` | `handler` | `id` | its Handler |
| `run` | `fallback` | `word` | for a Run started by the Fallback Handler, `yes`; `handler` is then the message's Selector: `yes` |
| `run` | `fn` | `value` | for a Run started by a Function Value call, the Function Value |
| `run` | `value` | `value` | for `completed`, its result |
| `run` | `error` | `value` | for `errored`, the error map |
| `run` | `limit` | `word` | for `limit-fault`, the limit: `fuel`, `alloc`, `persistent`, `depth`, `pattern`, `join` |
| `run` | `effect` | `value` | for effect-failed, a map {grant, segment, phase, status} identifying the failure that prevented commit; scope follows status for abandonment |
| `run` | `fuel` | `count` | the Fuel it used over its life |
| `run` | `alloc` | `count` | the allocation it made over its life |
| `stopped` | `reason` | `value` | the Host's reason, or `"owner disposed"` or `"reload"` |
| `stopped` | `discarded` | `ids` | the Runs discarded |
| `stopped` | `dropped` | `ids` | the Deliveries dropped from its mailbox |
| `stopped` | `abandoned` | `ids` | the pending calls abandoned |
| `unhandled` | `message` | `id` | the message's name |
| `unhandled` | `args` | `value` | its arguments, a list |
| `unhandled` | `target` | `value` | the object it was addressed to |
| `call-failed` | `op` | `id` | the Operation, as `<granted name>.<operation>` |
| `decided` | `verdict` | `word` | its Verdict: `allowed`, `vetoed`, `undecided` |
| `decided` | `vetoes` | `value` | each veto, as a map `{script, run, reason}`, in recipient order, with `script` and `run` as text |
| `decided` | `undecided` | `value` | each undecided recipient, as a map `{script, run, outcome}`, in recipient order, with `run` left out for a Delivery that never started; `script` and `run` are text, and `outcome` is text in chapter 5's words: `"errored"`, `"limit fault"`, `"cancelled"`, `"dropped"` or `"stopped"` |
| `diag` | `code` | `value` | its code, as text |
| `diag` | `pos` | `pos` | its position |
| `counters` | `fuel` | `count` | FuelTotal, including live Runs |
| `counters` | `alloc` | `count` | AllocTotal, including live Runs |
| `counters` | `runs` | `count` | Runs started since load |
| `counters` | `faults` | `count` | Runs ended with a Limit Fault |
| `counters` | `state` | `count` | current Persistent State, in bytes |
| `counters` | `mailbox` | `count` | messages currently in the mailbox, excluding Runs and undrained Host Inputs |
| `pumped` | `state` | `word` | the Group's state: `idle`, `sliced`, `stopped` |
| `pumped` | `fuel` | `count` | the Fuel the Pump used |
| `pumped` | `next` | `instant` | the next deadline: the earliest timer the next Pump could fire, a `maxPending` or `MaxWait` included, if there is one |
| `refused` | `code` | `value` | the Host error's code, or `"mailbox full"`, as text |
| `scope` | `grant` | `id` | the named Grant |
| `scope` | `name` | `id` | the declared scope name |
| `scope` | `action` | `word` | opened/closed on Host success, abandoned on automatic success, or failed on automatic abandonment failure: `opened`, `closed`, `abandoned`, `failed` |
| `effect` | `grant` | `id` | the participating named Grant |
| `effect` | `phase` | `word` | the hook: `begin`, `commit`, `rollback` |
| `effect` | `status` | `word` | the Host outcome; unknown includes malformed returns and exceptions: `ok`, `failed`, `unknown` |
| `effect-failure` | `grant` | `id` | the affected named Grant |
| `effect-failure` | `segment` | `id` | the affected Segment |
| `effect-failure` | `phase` | `word` | the failing lifecycle action: `abandon`, `begin`, `commit`, `rollback` |
| `effect-failure` | `status` | `word` | the failure status: `failed`, `unknown` |
| `effect-failure` | `scope` | `id` | the scope for abandonment failure |
| `offer-chosen` | `attempt` | `count` | the per-Run choice sequence, starting at one |
| `offer-chosen` | `name` | `value` | the chosen offer Name as text |
| `offer-chosen` | `at` | `at` | the choice instruction |
| `offer-chosen` | `target` | `at` | the action-entry instruction |
| `offer-chosen` | `args` | `value` | the supplied arguments as a list, omitted when empty |
| `offer-entered` | `attempt` | `count` | the matching choice sequence |
| `offer-entered` | `target` | `at` | the action-entry instruction, before its first charge |

<!-- end -->

- **`seg` figures:** `fuel` and `alloc` are the Fuel and allocation of the Stretch, a cancelled Run's cleanup included, though the Cleanup Budget pays for it. `state` is the Script's Persistent State measured at the Segment's end, without the Run if it has ended, and after the rollback for a fault or a cancellation ([chapter 6](06-errors-and-limits.md#limits)). A `run` record's figures are the Run's totals, from dispatch to its end, cleanup included.
- **A Limit Fault's charge** isn't made, since the faulting instruction faults before it does anything ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#the-cost-model)). So the `seg`, `run` and `pumped` figures leave it out, it adds no Fuel Slice debt, and a Run's `fuel` and `alloc` never pass its limits, where a cancelled Run's `fuel` may reach its Fuel per Run plus its Cleanup Budget.
- **`from`:** a Run started by a Script's message names the call id of the send, or the sending Run for a plain `send`. A Run started by an `error` message names the Run that errored.
- **Abandoned calls:** after a Join's fail-fast `raise`, an `abandon` record follows for each member still pending, in start order. One also follows the `raise` of each `timeout`, for the call that timed out, and a Limit Fault's `fault` record, for each call it abandons. A cancellation's abandoned calls follow its first cleanup Stretch's `seg` or `preempt`, once, including when the cleanup is preempted before it ends.
- **`fault`:** `rollback` lists the Script Variables whose bindings the rollback changed back ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).
- **`vars`:** a `vars` record is written for each Script in the Group, in load order. A Script whose first Load was rejected was never added to the Group ([chapter 9](09-embedding.md#loading-and-libraries)), so it has none. Each key is a Script Variable's name, and the record has no other keys. A Script with none is just `vars <script>`.

### Recovery choice and entry

A valid, fully charged choice emits `offer-chosen` before transfer cleanup. After cleanup, atomic parameter binding and PC transfer emit `offer-entered` before the action's first instruction charge. `at` is the choice instruction's CodePosition and `target` the action-entry CodePosition:

```text
offer-chosen <run> attempt=<int> name=<text> at=<CodePosition> target=<CodePosition> args=<list>
offer-entered <run> attempt=<int> target=<CodePosition>
```

Keys use the order shown; omit empty `args`. The per-Run counter starts at zero and increments for each valid, successfully charged choice, first emitting attempt 1. Missing names, wrong arity and faults before lookup charging completes consume no attempt and emit neither record. Nested choices share that monotonically increasing sequence; save/restore preserves it.

A first-action-instruction fault has an entry record. A choice cancelled by escaping cleanup, cancellation, Limit Fault or Stop has no entry; later Error/fault/outcome records explain that result without an abort record. Catch-test `guard-skip` precedes deeper finally records. Decline, lookup and successful transfer cleanup add no `raise`; new Errors, `throw` and Error-mode cleanup retain their ordinary raise records.

### End reasons

A `seg` record's `end` says why its stretch ended. A suspending end reason is the name of the instruction the Run suspended at, in its innermost frame ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#effects-and-suspension)), so a Command Call to a Handler that suspends ends with the Handler's own reason.

<!-- generated: corpus.ends -->

| End reason | The stretch ended because |
| --- | --- |
| `return` | the Run completed: it reached `return` or the end of its body |
| `pass` | the Run completed with `pass` |
| `veto` | the Run completed with `veto` |
| `error` | the Run ended with an uncaught error |
| `fault` | the Run had a Limit Fault |
| `cancel` | the Run was cancelled |
| `stop` | the Run was discarded by Stop Script, a Reload or disposing its Script's owner, in the middle of this Stretch; a Run discarded while suspended, parked or preempted has no Stretch to end, and only the `stopped` record lists it |
| `unhandled` | no Handler Clause matched |
| `dropped` | a `, dropping` clause dropped the Run |
| `park` | a `, queued` clause parked the Run |
| `ask-wait` | the Run suspended at a suspending Operation call |
| `send-wait` | the Run suspended at `send … and wait` |
| `send-up-wait` | the Run suspended at a Command Call sent up the Message Path with `and wait` |
| `call-value-wait` | the Run suspended at a call to a Function Value in another Script |
| `wait` | the Run suspended at `wait` |
| `wait-for` | the Run suspended at `wait for` |
| `wait-for-any` | the Run suspended at a block `wait for` |
| `join-end` | the Run suspended at a Join's closing `end` |
| `effect-failed` | a definite failure prevented participant commit; the Segment's Script Variables were rolled back |

<!-- end -->

### Notes

<!-- generated: corpus.notes -->

| Note | Noted when |
| --- | --- |
| `late-answer` | an answer or failure arrived for a call that was abandoned, or whose Run has ended, and was ignored; the subject is the call |
| `no-verdict` | a Run that holds no open Verdict reached `veto`; the subject is the Run |
| `climb-full` | a message climbing its Message Path found the next mailbox full, and is reported as `unhandled`; the subject is the Run that passed it or ended `unhandled` |
| `error-dropped` | an `error` message found its Script's mailbox full, and was dropped; the subject is the Run that errored |
| `function-gone` | a Host call named a stale Function Value, and nothing ran; the subject is the Delivery |

<!-- end -->

### Stops and cancels inside a Pump

`Stop` and `CancelRun` made during a Pump land at the latest at the running Pump's next Host crossing, or at its end ([chapter 9](09-embedding.md#threads-and-the-input-queue)).

- **Where it lands** is where its line is written: after the `call` or `prop` record of the crossing it landed at, or before the `pumped` record if it landed at the Pump's end.
- **An early landing,** between instructions elsewhere, adds `pc`, the instruction of the running Run it landed before. Only a native Core lands early, from a call made on another thread, and replay debugging lands it there through the TS Core's tooling hooks ([chapter 12](12-sessions-and-tooling.md#the-debugger)).
- **Replaying** a line written after a crossing, the runner makes the call from inside that crossing's Host function, so it lands at the same place. Corpus cases make calls inside a Pump only that way.

### Stubs

A Stub supplies, in advance, what a Host function returns during a Pump, since no later Host Input could reach it in time ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)).

- **The runner's, not the Core's:** the Core never sees a `stub` line. The runner writes it into the Trace itself, where the case has it, and queues it for its Operation, named by Capability, whichever Grant the call goes through.
- **Immediate calls** take the next Stub for their Operation, and return its `value`, or fail with its `error`. One that finds none fails, and the Script sees `host error`, with a `call-failed` record.
- **Standard `clock.now`** reads the Pump's Clock, so the runner refuses a Stub for it as an invalid case. Standard `timer` calls use fire-and-forget Stubs; the runner stores no durable timers, and the case writes each timer Delivery as an ordinary Host Input. Standard `store` calls take immediate Stubs and their lifecycle hooks `stub-effect` lines, as any Segment-bound Grant's do; the runner keeps no Store, so a case states each answer, including `store busy` and `store full` failures.
- **Fire-and-forget calls** take the next Stub if there is one. With none, they succeed.
- **`charge`** is drawn with `Charge` while the Operation starts, and a suspending call takes a Stub for its `charge` only.
- **Suspending calls** are answered by later `answer` and `fail` lines. The runner's Host functions do nothing else.
- **Replaying a Trace from a live Host,** which has no Stubs, a replaying Host answers each immediate call from its `call` record's `result` or `error`, charges its `charged`, and answers each property read from its `prop` record ([chapter 12](12-sessions-and-tooling.md#the-debugger)).

### Key types

<!-- generated: corpus.types -->

| Type | Written as |
| --- | --- |
| `id` | an id, such as `d4`, `orders/r2` or `orders/r2.c1` ([Ids](#ids)) |
| `ids` | a list of ids, `[orders/r2, orders/r3]` |
| `word` | one of the words the key lists |
| `count` | a non-negative integer, in canonical text |
| `value` | a value, in the display form |
| `instant` | an Instant, in the display form |
| `target` | a Script's name, or a Host Object in the display form |
| `at` | a code position: a code unit's name, `:`, and an instruction index, `orders:17` |
| `pos` | a source position: a line, `:`, and a column, `22:5` |
| `hex` | lowercase hexadecimal |

<!-- end -->

## Trace Cases

A Trace Case is a directory under [`corpus/`](../corpus/) holding `case.toml`, the `.talk` files it names and `case.trace`. An author writes `case.toml`, the sources and the Host Input lines, and `bless` writes the rest ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). The kinds of case are Trace Cases (ordinary replays, exhaustion points under tight limits, load diagnostics, Reload and extend Script, and save and restore), [Disassembly Cases](#disassembly-cases), [Value Encoding cases](#value-encoding-cases) and [Session Transcripts](#session-transcripts).

> **Example.** [`corpus/examples/orders-pricing/`](../corpus/examples/orders-pricing/) is a worked example. Its figures are invented until Cost Model 1.

### `case.toml`

`case.toml` holds a case's setup, in TOML. Its keys are camelCase, since its Operation Declarations and Shapes are the Host Manifest's data model, which the manifest writes as JSON ([chapter 9](09-embedding.md#the-host-manifest-format)).

A Standard Capability supplies its fixed declarations, including when compiling a Library's calls. In a Trace Case, its `costs` must name every Operation, with each cost component zero if absent. Declaring the same Capability more than once through `standard`, or through both `standard` and `operations`, is refused with Host Error `invalid value`.

<!-- generated: corpus.setup -->

| Table | Key | Holds | Case kinds |
| --- | --- | --- | --- |
| top level | `kind` | the case kind: `trace`, `disassembly`, `transcript` or `encoding` | trace, disassembly, transcript, encoding |
| `[versions]` | `language` | the language version the case is blessed for | trace, disassembly, transcript, encoding |
| `[versions]` | `costModel` | the Cost Model version the case is blessed for | trace, disassembly, transcript, encoding |
| `[operations]` | `capability` | the Capability the Operation Declaration belongs to | trace, disassembly |
| `[operations]` | `name` | the Operation's name | trace, disassembly |
| `[operations]` | `mode` | `immediate`, `suspending` or `fire-and-forget` | trace, disassembly |
| `[operations]` | `args` | the argument Shapes, a list | trace, disassembly |
| `[operations]` | `result` | the result Shape; absent for a fire-and-forget Operation | trace, disassembly |
| `[operations]` | `cost` | the declared cost, `{fuel, alloc}`, each 0 if absent | trace, disassembly |
| `[operations]` | `maxPending` | for a suspending Operation, its `maxPending` in whole milliseconds; absent means the Script's `MaxWait` | trace |
| `[operations]` | `errors` | the declared error codes, each `{code, fields}`, where `fields` are `{key, shape, optional}` | trace, disassembly |
| `[standard]` | `capability` | a Standard Capability the case uses | trace, disassembly |
| `[standard]` | `costs` | the cost of each of its Operations, a table from Operation name to `{fuel, alloc}` | trace, disassembly |
| `[objectKinds]` | `name` | an Object Kind's name | trace, encoding |
| `[objectKinds]` | `parentKinds` | the kinds its objects' parents may have | trace, encoding |
| `[objectKinds]` | `props` | its properties, each `{name, shape, readOnly, getCost, setCost}` | trace |
| `[objects]` | `kind` | a Host Object's kind | trace, encoding |
| `[objects]` | `id` | its stable id | trace, encoding |
| `[objects]` | `props` | the values its properties start with, a table from property name to a value in the display form, as text | trace |
| `[libraries]` | `name` | a user Library's name | trace, disassembly |
| `[libraries]` | `version` | its version, as text | trace, disassembly |
| `[libraries]` | `source` | the file that holds its source | trace, disassembly |
| `[scripts]` | `name` | a Script's name | trace, disassembly |
| `[scripts]` | `source` | the file that holds its source | trace, disassembly |
| `[scripts]` | `grants` | its Grants: a table from each granted name to `{capability, ops, binding}`, where `ops` is a list of Operation names or `"all"`, and `capability` may be left out when it is the granted name; optional `binding` is Host text for the Grant (Locale defaults to `und`, and other Capabilities to no binding) | trace, disassembly |
| `[scripts]` | `grantsAsUsed` | `true` to keep only the granted Operations the Script uses | trace |
| `[scripts]` | `owner` | the Host Object it owns, as `{kind, id}` | trace |
| `[scripts]` | `objects` | its well-known objects, a table from name to `{kind, id}` | trace, disassembly |
| `[scripts]` | `limits` | its limits, a table from each limit's `ts` name to its value; absent limits take their defaults | trace |
| `[disassembly]` | `unit` | the Script or Library whose disassembly the case pins | disassembly |
| `[disassembly]` | `expected` | the file that holds its expected canonical disassembly | disassembly |
| `[operations]` | `scope` | optional {opens, abandon} or {closes}; immediate only, as specified in embedding/scoped-effects.md | trace, disassembly |
| `[operations]` | `segmentBound` | optional boolean, false by default; true enlists this named Grant in its Segment and requires immediate mode; the case runner supplies all three lifecycle hooks | trace, disassembly |

<!-- end -->

- **Order:** Operation Declarations are ordered by name within their Capability, and Scripts and Libraries load in the order of the Trace's `load` and `add-library` lines, not of `case.toml`.
- **Host Objects** are made before the first Host Input, in the order listed. Their parents are set by `set-parent` lines, which the Trace records like any Host Input.
- **Properties** start with the values `case.toml` gives. The runner's `Get` returns the current value and its `Set` stores one, and both are recorded as `prop`.

A Shape is written as one of these:

- **A kind name,** as text: `"text"`, `"number"`, `"boolean"`, `"nothing"`, `"bytes"`, `"instant"`, `"civil date"`, `"range"`, `"pattern"` or `"function"`, or `"any"` or `"value"` ([chapter 9](09-embedding.md#shapes)).
- **`{quantity = "kg"}`** for a Quantity in exactly that Unit, and **`{unitKind = "mass"}`** for any Unit of that Unit Kind.
- **`{list = <shape>}`**, **`{object = "<kind>"}`**, **`{oneOf = [<shape>, …]}`** and **`{optional = <shape>}`**.
- **`{map = [<field>, …]}`**, a closed map, or with `open = true` an open one. A field is `{key, shape}`, with `optional = true` for a key that may be missing.

An Operation's trailing `{optional = <shape>}` arguments may be omitted as [chapter 9](09-embedding.md#shapes) says. Its `call` record keeps only supplied arguments; the runner adds no placeholders. Saved pending arguments keep that list for Reissue or Adopt.

### Running a case

- **The runner** is each Core's corpus-runner Example Host. The two share only data: the Corpus and the Data Files ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).
- **Setup:** it defines the Capabilities and Object Kinds `case.toml` declares, with the Host functions of [Stubs](#stubs), makes the Group, with the Trace written to its own sink, and makes the Host Objects.
- **Replay:** it makes each Host Input line's call, in order, and pumps at each `pump` line. The `stub` lines it writes into the Trace itself.
  A queued input refused with `mailbox full` can precede the accepted inputs still waiting for a Pump in the recorded Trace. The runner queues those accepted inputs before replaying the refusal, so the same mailbox depth check can refuse it; the Core still writes the refusal ahead of the drained inputs.
- **The end:** after the last line, it calls `Inspect()`, unless the last Host Input was `vars`, so every Trace ends with `> vars` and a `vars` record for each Script, and parity of state is always checked ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).
- **Comparing:** the Core's Trace must equal `case.trace` line for line, leaving out comments and blank lines. A Host Input line of the case that leaves out ids, or keys marked `*`, matches the Core's line with those left out.
- **Versions:** a case runs only on a Core with the same language and Cost Model versions as its `[versions]`, and is reported as skipped otherwise.

### Bless

- **Only on agreement:** `bless` runs the case on every Core available, in both replays below, and writes `case.trace` only if all of them give the same Trace. Otherwise it reports the divergence and writes nothing ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)).
- **What it writes** is the Core's Trace, with each comment and blank line of the case kept before the Host Input line it preceded. A human reviews the diff.
- **Version bumps:** a new language version or Cost Model version re-blesses the whole Corpus, and every case's `[versions]` with it.

### Save and restore replays

Every Trace Case is also run a second way, to check that save then restore is unobservable ([chapter 10](10-save-and-restore.md#the-rule)).

- **Between each pair of Pumps,** after each `pumped` record, the runner attempts Save. At a live-scope or participant boundary it requires `effects pending`, verifies no execution change, and continues the original Group; otherwise it restores the saved Group, on the same Core, with a `RejectMismatch` policy, every Grant re-bound and every Host Object resolved. It settles each pending call by adopting it, and goes on replaying into the restored Group.
- **The same Trace:** the Trace must equal the case's, once the injected `save`, its `effects pending` refusal where applicable, `restore` and adopting `settle` lines are left out and save-attempt ids are normalized to the original sequence.
- **Futures don't survive:** a Host-held Function Value, the context or signal that cancels a Delivery, and the `Call` of a call that isn't pending, belong to the old Group ([chapter 9](09-embedding.md#capabilities)). So the runner skips the save and restore at any point where a later `call-value`, another Host Input carrying a Function Value, `cancel-delivery`, `answer` or `fail` line needs one made before it, such as an `answer` to a call that had already timed out.
- **Explicit save/restore boundaries** in a case use its own records and settlements; the runner omits the extra hidden round-trip there, so automatic Adopt inputs cannot enter a visible save.
- **Hand-written cases** cover what this can't reach: settling by answer, fail and reissue, variables-only restores, and restoring with Grants, Libraries or Host Objects the Host no longer has ([chapter 10](10-save-and-restore.md)).

## Other case kinds

### Disassembly Cases

A Disassembly Case pins a code unit's lowering ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md)). Its `case.toml` has `kind = "disassembly"`, the Scripts and Libraries to compile, and a `[[disassembly]]` table for each unit it pins.

- **The expected text** is the unit's [canonical disassembly](08-the-abstract-machine-and-the-cost-model.md#the-canonical-disassembly), Unwind Table and event table included, compared byte for byte.
- **Libraries:** a Script's case shows a call into a Library by name and never pins the Library's body. A Library has Disassembly Cases of its own ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).
- **Bless** works as for a Trace Case.

### Value Encoding cases

A Value Encoding case checks that both Cores encode values the same way, with no decoder in the Corpus ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)). Its `case.toml` has `kind = "encoding"`, and any Object Kinds and Host Objects its values name. `case.encoding` pairs a value with the exact bytes of its [Value Encoding](09-embedding.md#json-and-the-value-encoding):

<!-- generated: ebnf.encoding-lines -->

```ebnf
EncodingFile   ::= ( EncodingLine #xA )*
EncodingLine   ::= Value ' => ' [^#xA]+ | '#' [^#xA]* | ''
                   /* the value, then its Value Encoding's exact bytes */
```

<!-- end -->

- **The runner** reads each value, builds it through the Host's constructors, encodes it with `EncodeValue`, and compares the bytes. So a text that isn't NFC is normalised as a Host's is, and a case shows it by its NFC bytes.
- **Function Values** are left out, since Host storage refuses them.

> **Example.**
>
> ```text
> 7.50 => {"$dec":"7.50"}
> 2.50 GBP => {"$quantity":["2.50","GBP"]}
> {"$ref": 1} => {"$map":[["$ref",1]]}
> ```

### Session Transcripts

A Session Transcript is a case directory holding `case.toml` with `kind = "transcript"`, `session.transcript` and a blessed `case.trace`. The runner replays the Transcript through the Session Host of [chapter 12](12-sessions-and-tooling.md#session-transcripts), and both the Transcript's output lines and the Trace must match ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)).

## Conformance

- **A conforming Core,** for a language version and a Cost Model version, passes every case of those versions: each Trace Case in both replays, each Disassembly Case, each Value Encoding case, and, through its REPL, each Session Transcript. It also passes the Unicode test data of [chapter 1](01-lexical-structure.md#unicode).
- **Parity** is everything a Trace, a report or a Host call shows. Given the same inputs to a Group (its Scripts and Libraries, its Host Inputs in order, the Capability answers, the Clock readings, the Fuel Slices and the limits), both Cores give the same results, reports and Script Variables, use the same Fuel and fault at the same instruction, measure the same allocation and Persistent State, interleave the same way with the same ids, raise the same codes at the same positions, and give the same diagnostics ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).
- **One repo:** the Spec, the Corpus and both Cores live in one repository, so a Spec fix, its new case and both Cores' fixes land in one change. CI runs the whole Corpus, both replays included, on both Cores for every change.
- **A divergence report** gives the case, both Cores' versions, the first line that differs, with context, and both Traces. On a mismatch, the runner also writes a ready-to-commit case directory, and the fix starts from it.
- **Every divergence found,** by a lockstep Host, a user or a fuzzer, becomes a case, with a Spec fix if the Spec was unclear.

> **Note.** Differential fuzzing is a required engineering practice, not part of the Spec ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)). A nightly job generates Scripts, Host Inputs and limit sweeps, runs them on both Cores, compares their Traces directly, and minimises each divergence into a Trace Case. Until the Go Core exists, the TS Core runs against itself, with and without the save and restore replays ([the research](../docs/research/differential-fuzzing.md)).

## Outside parity

- **Wording:** the `message` of a Core-raised error, and a Host error's or diagnostic's detail, none of which a Trace writes.
- **Early landings** of `Stop` and `CancelRun`, which a Trace records so that a replay follows them ([chapter 5](05-handlers-messages-and-scheduling.md#outside-parity)).
- **The runners:** how each Core's corpus runner, bless tool and divergence report are built, beyond what this chapter fixes. Trace sinks that write files are helpers ([chapter 9](09-embedding.md#outside-parity)).
- **Fuzzing:** the generator, the minimiser and the schedule.


## Scope and Segment-effect conformance scenarios

The following scenarios are required by [the lifecycle contract](embedding/scoped-effects.md). Implement Trace Cases under `corpus/capabilities/`, using Operation and lifecycle Stubs, plus embedding tests for Host callbacks and Message Layer exchanges. The [coverage reconciliation](../corpus/capabilities/scoped-effects.md) identifies executable TS coverage, pending expectation review and transport gaps; it does not establish Go or Message Layer conformance. Keep real filesystem/database integration tests in the relevant Example Host.

| Scenario | Required observation |
| --- | --- |
| Explicit close, reopen, duplicate open, missing close | Only Host-successful calls change slots; invalid calls have no Host invocation or call id; reopening is allowed after closure |
| Two differently named scopes, independent closes | An older scope may close first; remaining abandonment follows reverse opening order |
| Two Grant aliases or two Scripts sharing a binding | Core ownership remains distinct; the Host is responsible for rejecting incompatible resource use |
| Completion and uncaught ordinary error with open scopes | Each remaining scope abandoned once before Run/Decision reports; ordinary errors still preserve Script Variables |
| Caught error and failed explicit close | Scope remains open and usable; subsequent close or automatic abandonment can succeed |
| Limit Fault, Stop and owner disposal | Abandonment runs without Script finally or Script charges; participant rollback precedes subsequent execution/reporting |
| Cancellation before/after preemption | Participating scopes abandon before original rollback; unrelated scopes remain available to finally; cleanup may enlist a fresh participant |
| Cleanup ordinary error, limit and commit failure | Ordinary error preserves cleanup writes; limit rolls them back; definite commit failure gives effect-failed |
| Opening Host success followed by malformed result, conversion exhaustion or Stop | Acquisition is registered before failure; exactly one abandonment occurs |
| Closing Host success followed by conversion exhaustion | Closed scope is not abandoned again; participant still rolls back if enlisted |
| Wait forms, waiting sends and suspending calls with open scope | scope-open before Host work, message dispatch or wait registration; a caught error leaves scopes open |
| Wait-marked local call that never suspends | Call completes normally; only an executed suspension-producing boundary is rejected |
| Empty/nonempty Join entry and opening inside Join | Join entry with a scope fails; opener inside any Join fails even through a local call and before the first member |
| Fuel Slice/Group cap between open and close | Preemption remains; Save refuses without draining inputs; resuming preserves ownership and ordering |
| Explicit close while participant remains provisional | Save still refuses; later Limit Fault rolls back Host effects and Script Variables |
| GrantsAsUsed and missing abandonment permission | Implicit cleanup target retained; incomplete Grant refused; no other permission added |
| Revocation or disablement before cleanup | Ordinary calls rejected; reserved automatic cleanup still invokes original binding without Fuel |
| Failed abandonment with other scopes remaining | Failure reported, Grant disabled, remaining cleanup attempted; no automatic retry |
| Disabled Grant through Reload, replacement and both restore policies | Disablement survives; calls fail capability-disabled; fresh Script load is the recovery boundary |
| Participant begin definite failure, ordinary Operation error, second Grant | Begin failure invokes no Operation; Operation error leaves participant enlisted; second participant has no Host work |
| Return/pass/veto/error and suspension boundaries | Commit follows all Script charges and state checks, before reply, forwarding, Verdict or suspension publication |
| Explicit scope commit then later Limit Fault | Plain scoped effects stay final; Segment-bound effects roll back |
| Failed participating abandonment before commit | Prevent commit, roll back Script Variables/participant and end effect-failed; unrelated abandonment failure does not veto commit |
| Definite commit failure, unknown commit and failed rollback | Definite failure rolls back and ends effect-failed; uncertainty stops Group, attempts remaining cleanup, never retries commit |
| Reload/replacement validation rejection and successful termination | Rejected validation has no hooks; CarryVariables checks and carries the prospective post-rollback state; successful termination cleans before replacement; fatal cleanup prevents replacement |
| Message Layer cleanup outside Pump | Interim op/effect replies retain original ref and last Clock; final reports wait; reentry is rejected |
| Fingerprints and manifests | Scope name/target or segmentBound changes identity; false equals omission; binding, hooks and disabled state do not affect identity |
| Replay and save injection | Trace records determine lifecycle results; refused saves continue original Group; successful saves retain disabled state and Segment numbering |
| Ordinary file writing | Fault closes handle but does not undo bytes already written |
| Staged single-file publication | Close does not publish; successful Segment commits once; fault after close discards; abandoned unfinished file is not published |
