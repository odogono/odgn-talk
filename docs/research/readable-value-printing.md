# Values that print as source and read back

Research for [#372](https://github.com/odogono/odgn-talk/issues/372), checked
2026-10-08 against repository revision `927f0e8`. This is a design recommendation,
not an accepted ADR or implemented behavior.

## Recommendation

Do not add a Built-in, and do not add a third value format. The normative display
form is already source-shaped for most values: as probed on both Cores, typing an
echoed value back at the prompt gives an equal value with the same display form
for Nothing, booleans, numbers, Quantities, Text, Bytes, lists, ranges, Text
Patterns and most maps. Define a tooling-only **source form** as the display form
with a short list of substitutions where it isn't source. Use the source form for
copying in the debugger and Playground, and for `northtalk test` failure output.
For Function Values and Host Objects, keep the existing `<function …>` and
`<object …>` spellings. Those values cannot be rebuilt from source. Pasting either
spelling is a syntax error, rather than producing a different value.

A tooling-only form needs no ADR. [ADR 0028](../adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)
already makes the debugger and test runner tooling freedom. An ADR **is** needed
if the REPL echo, Session Transcripts or the display form change. These are
normative, and a change would re-bless the Corpus on both Cores. The cheapest
normative fix is to quote an `offer` map key ([below](#the-gaps)), which
chapter 2 already requires; it is being made separately as a Spec fix.

## What exists today

- **The display form is normative and round-trips through a Core's reader, not
  as source.** Every value has a single-line display form. A Trace, the Session
  echo, `String()`/`toString()`, error `message` templates and disassemblies use
  it. Reading it back gives an equal value with the same display form. The
  rationale explicitly limits the guarantee: "The display form needs to read back
  only through a Core's reader, not as source, where `2026-09-27` would be a
  subtraction." [Chapter 11](../../spec/11-the-trace-and-conformance.md#the-display-form)
  (lines 11 and 26), [ADR 0018](../adr/0018-the-trace-is-the-corpus-case.md).
- **The text form is the display form, except at the top level of Text.** `&`,
  `put` into text, `say`, `format` and `as text` show Text unquoted. Every other
  value, and Text nested in a list or map, appears in its display form, so
  `"a" & ["b"]` gives `a["b"]`. Scripts can therefore already reach the display
  form, but text is never evaluated as code.
  [Chapter 3](../../spec/03-values.md#the-text-form) (lines 112 and 132–145).
- **Text is already written as source joins it.** Plain runs are quoted; `"`,
  LF and tab become the Built-in Constants `quote`, `newline` and `tab`. Hidden
  and bidirectional code points become `fromCodePoint(n)`. Pieces are joined with
  ` & `. [Chapter 11 Text](../../spec/11-the-trace-and-conformance.md#text),
  [ADR 0029](../adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md).
- **Numbers were designed to read back as source.** Numbers have no positive
  exponent, so "every number prints in the literal syntax and reads back as
  itself", trailing zeros included.
  [Chapter 3 arithmetic rationale](../../spec/03-values.md#arithmetic) (line 196),
  [ADR 0034](../adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md).
- **The Value Encoding is not a source form.** It is lossless tagged JSON for the
  Message Layer and Host storage. Scripts can't reach it, the Corpus doesn't use
  it, and it refuses to encode Function Values.
  [ADR 0030](../adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md),
  [embedding](../../spec/09-embedding.md#json-and-the-value-encoding).
- **The issue's premise about escapes has moved on.** [ADR 0053](../adr/0053-backticks-interpolate-and-raw-fences-preserve-text.md)
  added hole-free backtick text with JavaScript escapes (`` `a\nb "q"` ``) and
  Raw Text Literals. Both "satisfy every literal-only Text position", such as map
  keys and Destructuring literals. Ordinary `"…"` still has no escapes.
  [Fenced text](../../spec/01-lexical-structure.md#fenced-text) (lines 51–56 and 132).
- **One printer per Core:** [Go `Value.Display`](../../impl/go/internal/value/display.go#L57)
  and [TS `Value.toString`](../../impl/ts/src/values.ts#L354), with `displayText`
  and the map-key rule at [Go L13/L87](../../impl/go/internal/value/display.go#L13)
  and [TS L739/L768](../../impl/ts/src/values.ts#L739).
- **Every tool uses that printer.** These include the Session Host echo
  ([TS](../../impl/ts/src/session/host.ts#L1570), [Go](../../impl/go/session/trace.go#L160)),
  `:vars` ([TS](../../impl/ts/src/session/host.ts#L1294),
  [Go](../../impl/go/session/commands.go#L398)), the debugger's variables
  ([stack](../../tooling/stack/src/debug.ts#L492),
  [Playground](../../tooling/playground/src/session.ts#L80)) and `northtalk test`
  failures ([test runner](../../tooling/cli/src/test.ts#L422)). The echo is
  normative because Session Transcripts replay it
  ([chapter 12](../../spec/12-sessions-and-tooling.md#the-foreground), line 81).
  The debugger and test output are not normative.
- **Test Scripts compare with `=`, not text.** `assertEqual` throws
  `{code: "assertion failed", expected, actual}` unless the two are equal under
  `=` ([Test Library](../../tooling/cli/src/test.ts#L46),
  [ADR 0056](../adr/0056-user-scripts-are-tested-by-a-black-box-test-script.md)).
  A source form helps authors write `expected`. It does not change how tests compare.

## What "reads back as an equal value" should mean

`=` alone is too weak a criterion. `2.5 = 2.50`, `5 kg = 5000 g` and maps that
differ only in key order are equal, but print differently
([equality](../../spec/03-values.md#equality)). Use the display-form reader's
existing contract: evaluating the source form gives a value `v2` with `v1 = v2`
**and** the same display form as `v1`. Every probe below met both conditions.

Value Semantics make cycles impossible. A Core may share structure internally,
but no Script or Trace can observe it ([Value Semantics](../../spec/03-values.md#value-semantics)).
A printer therefore needs no cycle labels or sharing markers, unlike Common
Lisp's `*print-circle*`. Output size is the only practical concern. A display
may elide a long value, but a copy action must not.

## Value kinds

Status is for the display form typed back as an Entry, on the TS Session Host
unless noted ([probes](#verification-of-current-behavior)).

| Kind | Display form | Valid source, reads back equal? | Source form |
| --- | --- | --- | --- |
| `nothing`, `boolean` | `nothing`, `true` | yes | unchanged |
| `number` | `-2.50`, `0.3333…` (34 digits) | yes; no NaN, Infinity or negative zero exist ([numbers](../../spec/03-values.md#numbers)) | unchanged |
| `quantity` | `-1 day`, `0.5 1/s`, `6 m*s` | yes | unchanged |
| `text` | `"say " & quote & "hi" & quote`, `fromCodePoint(13) & newline` | yes, as an expression. Not in literal-only positions: a `match` pattern rejects `"a" & quote`, and accepts `` `a"` `` | one hole-free backtick literal |
| `bytes` | `<<0x0D, 0x0A>>`, `<<>>` | yes | unchanged |
| `list` | `[1, "a", [nothing]]` | yes, if every item is | items in source form |
| `map` | `{sku: "A1", if: true}` | yes for Word and single-piece keys. **No** for `{offer: 1}` and keys like `{"" & quote & "x": 1}` | `"offer"` quoted; other non-literal keys as backtick literals, e.g. `` {`"x`: 1} `` |
| `range` | `-2..-1`, `3 m/s..7 m/s` | yes | unchanged |
| `civil date` | `2026-09-27`, `2026-09-27T14:30:00.5` | **No.** A date-only value silently evaluates to `1990`, and a date-time is a syntax error | `("2026-09-27" as civil date)` |
| `instant` | `2026-09-28T09:00:00Z` | **No**, syntax error | `("2026-09-28T09:00:00Z" as instant)` |
| `pattern` | `<"ID-", 4 digits>`, `<(quote & "x"), 2 digits>` | yes; equality is by canonical source | unchanged |
| `function` | `<function session:tax>`, `<function weather:12:3 {n: 3}>` | **No**, syntax error at `<` | not readable; keep the display form |
| `object` | `<object item "object-slot-183">` | **No** | not readable; keep the display form |

Notes on the rows:

- **Text.** A source form must not depend on how a piece splits. Pieces split at
  `"`, LF, tab and hidden code points ([chapter 11](../../spec/11-the-trace-and-conformance.md#text)).
  Each literal is normalised to NFC on its own, then `&` normalises the join
  ([chapter 1](../../spec/01-lexical-structure.md#text-literals)). The probe
  `quote & fromCodePoint(769)` (a piece that starts with a combining mark) read
  back equal. Keep that probe as an acceptance case. The pieces use the Built-in
  Constants, and a Script may shadow `quote`, `newline` or `tab`, which only a
  Lint flags. Like Python's "given an appropriate environment", a source form can
  only promise to read back in a Script that doesn't shadow those names.
- **Constant initialisers.** `&` with Built-in Constants and `as civil date` /
  `as instant` are both allowed there (probed). The proposed date form is
  therefore also valid in a `constant` or `script variable` initialiser.
- **Dates.** There is deliberately no date literal ([chapter 3](../../spec/03-values.md#dates-and-times),
  line 423). The parenthesised `as` form is the only reading that is both source
  and equal. The parentheses keep it safe beside `&` or arithmetic. A date-only
  display form pasted as source is the most dangerous gap: it raises no error,
  and gives a plain number.
- **Function Values.** Equality needs the same Home Script, the same Lambda or
  named function, and equal captures ([chapter 3](../../spec/03-values.md#function-values)).
  A named function's bare name rebuilds an equal value, but only inside its Home
  Script: at the prompt, `tax = tax` is `true`. Pasted into another Script or a
  Test Script, it is a different value or an `unknown name`. A Lambda can't be
  re-made at the same position with the same captures. Treat both as not readable.
- **Host Objects** have identity, and only the Host makes them
  ([Host Objects](../../spec/03-values.md#host-objects)). No source can produce one.

### The gaps

Only four constructs make the display form invalid as source:

1. **Map key `offer`.** `offer` became reserved as a bare map key
   ([chapter 2](../../spec/02-grammar.md#recovery-offers-and-choices), line 302; grammar line 474).
   The display form still writes every Word key bare, Reserved Words included
   ([chapter 11 Maps](../../spec/11-the-trace-and-conformance.md#maps)).
   `put 1 into the offer of m` then echoes `{offer: 1}` on both Cores, and that
   echo is a syntax error at the prompt. Quoting it in the display form, as
   `{"offer": 1}`, still reads through the display-form reader. Chapter 2 already
   says to quote it, so chapter 11 contradicts it. **Decided:** fix the display
   form on both Cores now, as a Spec fix rather than an ADR.
2. **Map keys that aren't one quoted piece**, such as `{"" & quote & "x": 1}`.
   A map literal has no computed keys. A hole-free backtick key reads back equal
   (probed). Putting backticks into the display form would change the Trace
   grammar ([`trace.ebnf`](../../spec/data/trace.ebnf)), so keep this substitution
   in the tooling source form.
3. **Civil Dates and Instants**, as above. Changing their display form would also
   change the text form inside containers (`"x" & [d]`) and every Trace. Keep
   this substitution in tooling too.
4. **Function Values and Host Objects**, which have no source.

## Primary-source precedents

### Common Lisp

`prin1` binds `*print-escape*` to true, and `princ` binds it and
`*print-readably*` to false. "Output from `princ` is intended to look good to
people, while output from `prin1` is intended to be acceptable to `read`."
[CLHS write/prin1/princ](https://www.lispworks.com/documentation/HyperSpec/Body/f_wr_pr.htm).
With `*print-readably*` true, printing must produce a representation that reads
back as a *similar* object. Otherwise "an error of type `print-not-readable` is
signaled rather than using a syntax (e.g., the `#<` syntax) that would not be
readable". [CLHS *print-readably*](https://www.lispworks.com/documentation/HyperSpec/Body/v_pr_rda.htm).
`#<` itself "is not valid reader syntax", and reading it signals `reader-error`.
[CLHS 2.4.8.20](https://www.lispworks.com/documentation/HyperSpec/Body/02_dht.htm).

Inference: NorthTalk's `&` is `princ` and its display form is close to `prin1`.
The `<function …>` and `<object …>` spellings already play the role of `#<`: they
fail loudly at read. A tooling copy action that refuses or warns on unreadable
parts corresponds to `*print-readably*`.

### Python

`repr()` makes "an attempt to return a string that would yield an object with
the same value when passed to `eval()`; otherwise, the representation is a string
enclosed in angle brackets". [repr](https://docs.python.org/3/library/functions.html#repr).
`__repr__` "should look like a valid Python expression that could be used to
recreate an object with the same value (given an appropriate environment)". It
is "typically used for debugging", while `__str__` has "no expectation" of being
an expression. [Data model](https://docs.python.org/3/reference/datamodel.html#object.__repr__).

Inference: Python's REPL echo uses the repr. Constructor-call forms
(`datetime.date(2026, 9, 27)`) are the accepted answer for values with no
literal. That matches `("2026-09-27" as civil date)`. "Given an appropriate
environment" is the same caveat as shadowed Built-in Constants.

### Clojure

`pr` prints "in a way that objects can be read by the reader". `print` and
`println` "produce output for human consumption", by binding `*print-readably*`
to nil. `*print-dup*` prints "in a way that preserves their type when read in
later". [core.clj 1.12.4](https://github.com/clojure/clojure/blob/clojure-1.12.4/src/clj/clojure/core.clj#L3703).
Objects without a reader form print as `#object[Class 0x… "…"]`
([core_print.clj](https://github.com/clojure/clojure/blob/clojure-1.12.4/src/clj/clojure/core_print.clj#L104)).
Instants print as the tagged literal `#inst "…"`, which the reader reads
([reader reference](https://clojure.org/reference/reader),
[instant.clj](https://github.com/clojure/clojure/blob/clojure-1.12.4/src/clj/clojure/instant.clj#L176)).

Inference: Clojure gives dates a reader tag, rather than an evaluated constructor.
NorthTalk could only do that with new grammar, against ADR 0023's choice of no
date literal. The `as` form reaches the same result without a language change.

## Answers to the issue's questions

### What exists today

There is one normative printer, the display form. It is source-shaped by design
for numbers and Text, but its promise is explicitly to a Core's reader, not to
source. Neither chapter 3 nor the Value Encoding promises a source form. All the
Cores' tools print the display form.

### Values with no literal

- **Text with quotes or line breaks** already round-trips as an `&` expression.
  It can also be one hole-free backtick literal, which works in literal-only
  positions.
- **Civil Dates and Instants** round-trip through `("…" as civil date)` and
  `("…" as instant)`.
- **Text Patterns** already round-trip, since equality is by canonical source.
- **Function Values and Host Objects** cannot round-trip. Keep the angle-bracket
  display form, which fails loudly when pasted.

### Normative or not

Not a Built-in. Text is never evaluated as code, so a Script gains nothing from a
second printer it can't read back. A Built-in would pin a second format to the
language version and to parity on both Cores, with no Script-side use.

The tooling choice is lower-risk. It changes no Trace, Transcript or Corpus case,
and it can grow per tool. Its trade-off is that the REPL/Playground echo, which
users copy most, keeps printing `2026-09-27`. That form is still misleading as
source. Two mitigations stay within tooling:

- a Playground/debugger "copy as source" action that uses the source form; and
- a Lint for an expression that looks like an ISO date (`2026-09-27` or
  `2026-09-27T…`), suggesting `"…" as civil date`. This also catches mistakes
  typed by hand.

Changing the echo itself is possible. It would be a Session change under
[chapter 12](../../spec/12-sessions-and-tooling.md), with an ADR, both Session
Hosts and re-blessed Transcripts. Defer it until the tooling form has been used.

## Proposed contract

**Name:** source form. If adopted, add it to `CONTEXT.md`: "The display form with
the substitutions that make it valid source. Tooling uses it, and nothing about
it is normative." _Avoid_: repr, readable form, literal form.

**Definition**, applied recursively through lists, maps and range ends:

- A Civil Date is `("<ISO form>" as civil date)`, and an Instant is
  `("<ISO form>Z" as instant)`.
- A map key is bare when it is a Word other than `offer`. It is a single quoted
  piece when its display form is one.
- **Decided:** any other Text, as a value or a map key, is one hole-free backtick
  literal, escaping `` ` ``, `\`, `${` and every code point the display form
  would hide (with `\n`, `\t` or `\u{…}`). It is valid wherever a literal is
  required and doesn't depend on names a Script can shadow.
- Every other value is its display form.
- A value is **readable** when it contains no Function Value or Host Object.
  Tooling must label an unreadable value, or refuse to copy it as source. Such a
  value still prints its display form, and that fails at `<` if it is pasted.

**Which tools use it:**

- **Debugger** (live and replay): variable copy, and an optional source-form view.
- **Playground:** a copy action on echoed results and inspector values.
- **`northtalk test`:** print the `expected` and `actual` fields of an
  `assertion failed` Error in source form, so they can be pasted into
  `assertEqual`.
- **LSP hover:** the source form for a Constant's value.
- **Unchanged:** the REPL echo, Session Transcripts, Traces and the text form
  (all normative).

**Where it lives:** one TS function beside the TS Core's printer, exported for
tooling. There is no Go counterpart, since the Go REPL has no debugger or copy
action ([ADR 0028](../adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Acceptance cases

For each readable value, evaluating its source form as an Entry gives a value
with `=` true and the same display form. Cover at least:

- `nothing`, `true`, `-2.50`, `0.00`, `1 / 3`, `-1 day`, `0.5 1/s`, `6 m*s`.
- Text with `"`, LF, tab, CR, U+FEFF, U+202E, an empty text, and a piece that
  begins with a combining mark (`quote & fromCodePoint(769)`).
- `<<>>`, `<<0x0D, 0x0A>>`; `[1..3]`, `-2..-1`, `3 m/s..7 m/s`.
- Maps with keys `if`, `offer`, `"unit price"`, `` `"x` ``, `` `a\nb` ``, a key
  that is a backtick or contains `${`, a hidden code point, and `{a: nothing}`
  against `{}`.
- Date-only and date-time Civil Dates with fractions, and an Instant made from an
  offset. Test each nested in a list, a map value and a Constant initialiser.
- Text Patterns with splices, a leading nested group (`< <4 digits>, "x">`) and
  a text piece in parentheses.
- Unreadable: a named function, a Lambda with captures, a Host Object, and a list
  that contains one. Each is labelled unreadable, and the display form fails to
  parse.
- A Test Script whose `assertEqual` failure output can be pasted back as
  `expected`, so the test passes.

## Side finding: Go and TS print an Entry's Lambda differently

On the same Session input (`put given n: n * k into g`, then `g`), the TS Session
Host echoes `<function session+9:3:5>`. The Go REPL echoes
`<function session:session+9:3:5>`. The Spec's example and grammar give the TS
shape, `<function session+3:1:9>` ([chapter 11](../../spec/11-the-trace-and-conformance.md#function-values),
grammar line 118). Go's `functionCode` prefixes the extension unit's name with
the Home Script ([Go](../../impl/go/internal/machine/library.go#L10),
[TS](../../impl/ts/src/machine.ts#L3431)). No Corpus case covers a Lambda made in
an extension unit. Under the [cross-Core convention](../agents/issue-tracker.md#cross-core-findings),
it is tracked as Go Core issue [#424](https://github.com/odogono/odgn-talk/issues/424). It affects any echo or Trace that shows such
a Lambda, independent of #372.

## Open questions

- Should a later ADR change the REPL echo to the source form, once tooling
  experience shows the date gap matters in practice?
- Is a date-like-subtraction Lint (`2026-09-27`) worth its false positives?

## Verification of current behavior

At the revision named above, `bun install --frozen-lockfile` succeeded. These
existing tests passed. They verify the baseline, not the proposed source form:

```sh
bun test impl/ts/tests/values.test.ts impl/ts/tests/dates.test.ts \
  impl/ts/tests/session.test.ts
# 144 passed, 0 failed
go -C impl/go test ./internal/value -count=1
# ok
```

Probes against the TS `SessionHost` entered each value, then entered its echo as
a new Entry, then evaluated `(original) = (echo)`:

- Equal, with an identical echo: every row marked "yes" in the table above.
  These include `"say " & quote & "hi" & quote`,
  `fromCodePoint(13) & newline`, `quote & fromCodePoint(769)`, a backtick literal
  with `\n` and `\u{202E}`, `{sku: "A1", if: true}`, `-2..-1`,
  `<(quote & "x"), 2 digits>` and `"a" & ["b"]`.
- `{offer: 1}`: `! unexpected token at 1:2`. The same map built with
  `put 1 into the offer of m` echoes `{offer: 1}`.
- `` {`"x`: 1} `` echoes `{"" & quote & "x": 1}`, and that echo fails with
  `! unexpected token`. The backtick form compares equal to itself.
- `"2026-09-27" as civil date` echoes `2026-09-27`, which reads back as `1990`
  (equality `false`). Date-times and Instants fail with `! unexpected token`.
  `{d: ("…" as civil date), t: ("…" as instant), …}` compares equal, and the `as`
  forms are accepted in `constant` initialisers.
- `tax` echoes `<function session:tax>`, and `tax = tax` is `true`. The echo
  fails with `! unexpected token`.
- In `match`, `when "a" & quote` is a syntax error, and `` when `a"` `` matches.

The Go REPL (`go run ./cmd/northtalk`, with Entries on standard input) gave the
same echoes for the quote text, the backtick key, `{offer: 1}`, the Instant, the
`1990` subtraction, `0.5 1/s` and the spliced Text Pattern. It differed only in
the Lambda display described above.
