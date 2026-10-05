# 2. Grammar

_Draws on:_ [ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md), [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md), [ADR 0042](../docs/adr/0042-block-ending-suffixes-are-optional-and-explicitness-is-lint-advice.md), [ADR 0055](../docs/adr/0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md).

The grammar is one set of productions, in [`grammar.ebnf`](data/grammar.ebnf), and one set of word lists, in [`grammar.toml`](data/grammar.toml). This chapter shows both and states the rules they can't. What each construct means is in the chapters that follow.

- **Predictive:** a Core parses with a fixed lookahead of two tokens and no backtracking. Every choice between productions is made on the next token, or on the next two where [a decision below](#two-token-decisions) says so.
- **One grammar:** the grammar is the same on every Host. Neither Hosts nor Scripts can add syntax ([ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md)). A Handler's [Argument Labels](#argument-labels) are parsed the same whatever Handlers exist.
- **What is normative:** for source that parses, the parse, since a different parse lowers differently ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)). For source that doesn't, the first syntax error: its code and position.

## Notation

- **The EBNF** is that of [the W3C XML Recommendation](https://www.w3.org/TR/xml/#sec-notation), as [chapter 0](00-introduction.md#notations) says.
- **Tokens** come from [chapter 1](01-lexical-structure.md#tokens): `Word`, `Name`, `Number`, `Text`, `Unit` and `NL`, plus `CallOpen` (a `(` straight after a Name), `PatternOpen` and `PatternClose` (the `<` and `>` of a Text Pattern) and `BinaryOpen` (`<<` in operand position).
- **A quoted word** such as `'put'` matches a Word with that spelling. If it is a Reserved Word, it is only ever that Reserved Word. Otherwise it is a contextual keyword, which has its meaning only where a production quotes it, and is an ordinary Name everywhere else.
- **Overlaps:** where a contextual keyword could also be read as a Name, a [two-token decision](#two-token-decisions) picks the reading.
- **Comments** in a production state a rule that the notation can't, such as "the Name after `end` is the Handler's name".

## Words

### Reserved Words

<!-- generated: grammar.reserved -->

`add`, `after`, `and`, `ask`, `be`, `catch`, `delete`, `divide`, `else`, `end`, `exit`, `false`, `finally`, `for`, `function`, `given`, `if`, `in`, `into`, `is`, `it`, `let`, `match`, `me`, `multiply`, `not`, `nothing`, `of`, `on`, `or`, `pass`, `put`, `repeat`, `replace`, `return`, `send`, `set`, `subtract`, `tell`, `the`, `then`, `throw`, `to`, `true`, `try`, `until`, `veto`, `wait`, `when`, `where`, `while`

<!-- end -->

A Reserved Word is never a Name, anywhere. Each one is reserved for a reason:

- **Block structure:** `end`, `else`, `when`, `catch`, `finally` and `after` end or continue a block at the start of a statement, and `then` ends a condition. None of them can be a Handler name.
- **The words that start statements:** if `add` were contextual, `add 1 to x` and a Command Call `add 1` would differ only at `to`, arbitrarily far in. The same holds for every word that starts a statement, except `next`: `next repeat` is decided on its two tokens, so `next` stays contextual.
- **`given`** starts a Lambda, decided on its first token.
- **`in`** makes `x is in r` (membership) a decision on one token, not three. **`wait`** makes `… and wait` a decision on two. **`the`, `of`, `is`, `not`, `and` and `or`** are the expression words.
- **`to`, `into`, `be`, `then` and `where`** aren't needed to parse valid source. They are reserved because they put first errors on the right token: `put 1 + into x` fails at `into`, not at `x`.
- **Constants:** `true`, `false`, `nothing`, `it` and `me`.

> **Note.** A Reserved Word can still be a map key, since a word followed by `:` in `{…}` is always a key (`{to: who}`), and it can be read back with `the to of m` or `m's to`. It can't be a variable, a parameter, a Capture or a Handler name.

### Contextual keywords

<!-- generated: grammar.contextual -->

| Contextual keyword | Positions |
| --- | --- |
| `a` | after `is` or `is not`, before a kind; after `can be`; before a kind in a Text Pattern (a Typed Element) |
| `all` | straight after `wait for` (a Join) |
| `an` | as `a` |
| `as` | after an operand (a conversion); after a pattern (binding the whole value); after the Library name in `use`, before the new name; after a Text Pattern element; after the value of a Binary Pattern build field |
| `before` | after the value in `put` |
| `begins` | operator position, before `with` |
| `by` | after the Container in `multiply` and `divide`; after `delimited` |
| `can` | operator position, before `be` |
| `case` | after `ignoring` |
| `civil` | before `date` in a kind |
| `constant` | at the start of a top-level declaration |
| `contains` | operator position; after `when`, before `<` |
| `date` | after `civil`, in a kind |
| `deciding` | after a comma in a Handler head |
| `delimited` | after a Chunk Expression, before `by` |
| `div` | operator position |
| `dropping` | after a comma in a Handler head |
| `during` | after a comma in a Handler head, before a name |
| `each` | after `repeat for` |
| `empty` | after `is` or `is not` |
| `ends` | operator position, before `with` |
| `every` | operand position, before `match` (the Match Search) |
| `forever` | straight after `repeat` |
| `from` | after the value in `subtract`; after the event in `wait for`; after the imported names in `use` |
| `ignoring` | after a comparison, a `match` subject or a Text Pattern element, before `case` |
| `lazily` | after a Text Pattern element |
| `matches` | operator position |
| `mod` | operator position |
| `next` | at the start of a statement, before `repeat` |
| `private` | at the start of a top-level declaration, before `on`, `function` or `constant` |
| `queued` | after a comma in a Handler head |
| `replacing` | after a comma in a Handler head |
| `script` | at the start of a top-level declaration, before `variable` |
| `target` | after `the`, when `of` doesn't follow |
| `times` | after the count in `repeat` |
| `use` | at the start of a top-level declaration |
| `variable` | after `script` at the start of a top-level declaration |
| `with` | after the message name in `send`; after the Container in `replace`; after `begins` or `ends` |

<!-- end -->

The chunk kinds, the ordinals, the Built-in property names, the Text Pattern keywords and the Binary Pattern words below are contextual too. Each has its meaning only where the grammar gives it one.

### The FOLLOW set

<!-- generated: grammar.follow -->

`as`, `before`, `begins`, `by`, `can`, `contains`, `delimited`, `div`, `ends`, `from`, `ignoring`, `matches`, `mod`, `times`, `with`

<!-- end -->

These are the contextual keywords that may come straight after a complete expression. None of them can start a chunk index, which is how a chunk word is told from a Name ([Operands](#operands)). No Unit's name or plural may be a Reserved Word or in the FOLLOW set, and the generator checks this against [`units.toml`](data/units.toml).

### Argument Label words

Any Name may be an [Argument Label](#argument-labels), except these. Of the Reserved Words, only these may be one.

<!-- generated: grammar.labels -->

- **Reserved Words that may be labels:** `to`.
- **Names that may not be labels:** `from`, `with`.

<!-- end -->

## Source and declarations

<!-- generated: ebnf.source -->

```ebnf
Source         ::= NL* ( Declaration NL* )*
Declaration    ::= 'private'? ( Handler | Function | Constant ) | ScriptVariable | Use
ScriptVariable ::= 'script' 'variable' Name ( '=' Expression )? NL
Constant       ::= 'constant' Name '=' Expression NL
Use            ::= 'use' Name ( ( ',' Name )+ 'from' Name | 'from' Name ( 'as' Name )? ) NL
Function       ::= 'function' Name ( Parameter ( ',' Parameter )* )? NL Block 'end' Name? NL
                   /* a Name after `end`, if present, is the function's name */
Parameter      ::= Name ( '=' Expression )?
                   /* a default; only trailing parameters may have one */
Entry          ::= NL* ( Declaration | Statement NL | Expression NL )
                   /* at a Session prompt only; decided on its first token */
```

<!-- end -->

- **Top level:** a Script or Library is a sequence of declarations, and a top-level line can only start one. A statement at top level is a syntax error at its first token.
- **Declarations are decided on their first token,** except `script variable`, which is decided on two. `use`, `constant`, `private`, `script` and `variable` are contextual, since a top-level line can't start anything else.
- **`=`** in a Script Variable or Constant means "starts as", and in a function's parameters "defaults to". It is equality everywhere else.
- **`use … as`** renames a single imported name (`use trim from text as tidy`). After two or more names, `as` is a syntax error.
- **`private`** goes before a Handler, a function or a Constant. It is a load error in a Script ([chapter 7](07-libraries-and-the-standard-library.md)).
- **Functions** take a list of names, with no Destructuring. A Name after `end`, if present, must be the function's name.
- **Defaults:** `name = expression` gives a parameter a default, which a call may leave off ([ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md)). The default runs to the next top-level comma or the end of the line. Only trailing parameters may have one, and what a default may use is a load rule ([chapter 7](07-libraries-and-the-standard-library.md#defaults)).

> **Example.**
>
> ```talk
> use pad, trim from text
> use sum from list as total
> script variable visits = 0
> constant welcome = "Hello"
>
> function tax amount, rate = 0.2
>   return amount * rate
> end tax
> ```

### Entries

An Entry is what a Session reads at its prompt ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [chapter 12](12-sessions-and-tooling.md)). It is decided on its first token, with no second parse:

- A word that starts a declaration (`on`, `function`, `private`, `use` or `constant`, and `script` before `variable`) starts one.
- A Reserved Word that starts a statement (`put`, `if`, `wait`, …) starts one, and so does `next` before `repeat`.
- Any other Name starts a Command Call only if the Session Script has a Handler whose Selector starts with that Name, or the Name is `say` ([chapter 12](12-sessions-and-tooling.md#the-console)). Anything else, including an Entry that starts with `the`, `not`, `given` or a constant, is an expression, and its value is echoed. So `n - 1` echoes a value rather than calling a Handler `n` with `-1`.

## Handlers

<!-- generated: ebnf.handlers -->

```ebnf
Handler        ::= 'on' MessageName HandlerHead NL Block ( 'finally' NL Block )? 'end' Name? NL
                   /* a Name after `end`, if present, is the Handler's name */
HandlerHead    ::= ( Pattern ( ( ',' Pattern )* | ( Label Pattern )+ ) )? Guard? ( ',' Suffix )*
Label          ::= Name | 'to'
                   /* an Argument Label: any Name but those grammar.toml's [labels]
                      excludes, or one of its Reserved Words; never the start of an
                      operator that can continue the expression before it */
Suffix         ::= 'queued' | 'dropping' | 'replacing' | 'deciding' | 'during' Name
Guard          ::= 'where' Expression
MessageName    ::= Name  /* not `all` */
```

<!-- end -->

- **Handler and message names** are one Name each (`beforeClose`), and so is each part of a Selector. `all` can't name a Handler, a message or an event, since `wait for all` starts a Join.
- **The head** is the parameters, then an optional Guard, then the suffixes, in that order. Each parameter is one Destructuring pattern. The parameters are a comma-separated list, or one parameter followed by [Argument Labels](#argument-labels), each with its parameter.
- **Suffixes:** after a comma in a head, `queued`, `dropping`, `replacing` and `deciding` are always suffixes, so none of them can be a parameter name there. `during` followed by a Name is the `during` suffix. Which suffixes may combine is a load rule ([chapter 5](05-handlers-messages-and-scheduling.md)).
- **The end:** a Name after `end`, if present, must be the Handler's name, which for a labelled Handler is its first word (`end move`). If an inner `repeat` is still open, `end handlerName` is a syntax error at `handlerName`; it cannot close through the `repeat`.
- **`finally`** may end a Handler's body, as sugar for a `try` around it ([chapter 6](06-errors-and-limits.md)).

> **Example.**
>
> ```talk
> on handle {type: "invoice", amount: a} as inv where a > 1000
>   send review with inv to approvals
> end handle
>
> on search term, replacing
>   send query with term to index and wait
> end search
>
> on beforeMove m, dropping, deciding
>   if the to of m is in own then veto "Your own piece is on that square."
>   pass beforeMove
> end beforeMove
>
> on error {code: c}, during msg
>   tell log to write c
> end error
> ```

### Argument Labels

An Argument Label names the parameter after it, in a Handler's head and at its call sites ([ADR 0055](../docs/adr/0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md)).

- **The Selector:** the message name and its labels make the message's Selector, written with a colon after each part. `on move piece to square` handles `move:to:`, and `on move piece` handles `move`, a different message. A message with no labels keeps its plain name.
- **Where labels go:** one leading parameter or argument, then any number of `label parameter` pairs. There is no comma after a label, no label before the first parameter, and no labels after a comma-separated list. The same shape holds in a Handler head, a Command Call, an event of `wait for` and the phrase of a target-first `send`.
- **Decided on one token:** after a complete parameter or argument, a label word in operator position starts a label. Any reading that continues the expression comes first, so `as`, `mod`, `div`, `contains` and `matches`, and `begins`, `ends`, `can`, `ignoring` and `delimited` when their [two-token decision](#two-token-decisions) gives the operator, are never labels there.
- **Lines:** a label at the end of a line doesn't continue the line. A long labelled call goes in brackets.
- **Traps:** the existing reading wins. A chunk word before an open label starts a Chunk Expression (`move word toward x` reads `word toward …`), and a number before a Unit-named label is a Quantity (`scale 3 m 4`). Brackets avoid both: `move (word) toward x`, `scale (3) m 4`.
- **Errors:** a word in operator position after an argument is now a label, so a mistake such as `log error rest` fails at the end of the line, where `rest` has no argument.

> **Example.**
>
> ```talk
> on move piece to square where square is not "e1", queued
>   put square into the location of piece
> end move
>
> on play
>   move knight to "e4" and wait
>   send to board: move knight to "e4"
>   wait for move p to sq or 30 s
> end play
> ```

## Statements

<!-- generated: ebnf.statements -->

```ebnf
Block          ::= ( Statement? NL )*
Statement      ::= If | Repeat | Match | Try | Wait | Simple
Inline         ::= Simple | 'wait' ( 'for' Event Timeout? | Expression )
Simple         ::= Put | Let | Set | Add | Subtract | Multiply | Divide | Delete
                 | Send | Ask | Tell | Return | Veto | Pass | Exit | Next | Throw
                 | Replace | CallStatement | CommandCall
Put            ::= 'put' ( Expression ( 'into' | 'after' | 'before' )
                         | '...' Expression ( 'after' | 'before' ) ) Container
Let            ::= 'let' Pattern 'be' Expression
Set            ::= 'set' Container 'to' Expression
Add            ::= 'add' Expression 'to' Container
Subtract       ::= 'subtract' Expression 'from' Container
Multiply       ::= 'multiply' Container 'by' Expression
Divide         ::= 'divide' Container 'by' Expression
Delete         ::= 'delete' Container
Container      ::= ChunkLevel  /* rooted in a Name, or else `not a container` */
Send           ::= 'send' ( ( MessageName | '(' Expression ')' ) ( 'with' ExpressionList )? 'to' Expression
                          | 'to' Expression ':' CommandPhrase ) AndWait?
Ask            ::= 'ask' Expression 'to' Word ExpressionList? AndWait?
Tell           ::= 'tell' Expression 'to' Word ExpressionList?
AndWait        ::= 'and' 'wait'
Return         ::= 'return' Expression?
Veto           ::= 'veto' Expression?
Pass           ::= 'pass' MessageName Label*
Exit           ::= 'exit' 'repeat'
Next           ::= 'next' 'repeat'
Throw          ::= 'throw' Expression
Replace        ::= 'replace' 'first'? ChunkLevel 'in' Container 'with' Expression
CallStatement  ::= Call AndWait?
CommandCall    ::= CommandPhrase AndWait?
CommandPhrase  ::= Name ( Expression ( ( ',' Expression )* | ( Label Expression )+ ) )?
ExpressionList ::= Expression ( ',' Expression )*
```

<!-- end -->

- **Every word that starts a statement is reserved,** except `next`, so a statement that starts with any other Name is a Command Call or a call statement.
- **`say`:** the grammar reads `say x` as an ordinary Command Call. [Chapter 12](12-sessions-and-tooling.md) makes it short for `tell console to write x`.
- **Command Calls:** a Name, then its arguments, if the next token can start an expression. So `greet "Ann"` passes one argument, `blink and wait` passes none, and `n - 1` passes `-1` to a Handler `n`. The arguments are a comma-separated list, or one argument followed by [Argument Labels](#argument-labels) (`move knight to "e4"`), and the call names the Selector they make.
- **Call statements:** a Name straight followed by `(`, with no space, is a call (`refresh()`), not a Command Call. With a space, `(` groups an argument, so `say (1 + 2) & "!"` passes one argument.
- **`send`** names its receiver last (`send greet with "Ann" to board`), or, after `send to`, first, then `:` and a Command Call's phrase (`send to board: move knight to "e4"`). `to` can't name a message, so one token decides. Only the target-first form carries labels. A bracketed expression in place of the message name computes it (`send (next) with order to me`), and `(` can't start a Name, so one token decides that too.
- **`and wait`** ends a `send`, an `ask`, a Command Call or a call statement, and only as a whole statement. `put f(x) and wait into y` is a syntax error at `and`.
- **Operations:** the Word after `ask … to` or `tell … to` is always an Operation name, even a Reserved Word (`ask files to delete path`). `tell` never takes `and wait`.
- **Containers:** a Container is a Name, or a Chunk Expression or key path rooted in one. A Container whose root isn't a Name is `not a container`, reported at the Container's first token (`put 1 into 3`, `put "Z" into character 20 of "short"`). What a root Name refers to is a load rule.
- **`put ...`** splices a list, and so takes only `after` or `before`.
- **`return` and `veto`** take an expression if one starts next. `return` is never an operand ([chapter 1](01-lexical-structure.md#text-literals)).
- **`pass`** names the message it passes, by its name and then its labels: `pass move to` passes `move:to:`. **`exit`** only takes `repeat`, and **`next repeat`** is decided on two tokens, so `next` is otherwise a Name.
- **`replace`:** at the start of a statement, `replace <p> in c with e` rewrites the Container `c`. In operand position, the same words give the new text. There, `c` is any expression but a Lambda, and `e` an expression at the level of `&`, so `put replace <"-"> in s with "+" & x into t` replaces with `"+" & x`, and `into` ends the expression, since it isn't an operator. `replace first` replaces only the first match.

## Blocks

- **Optional endings:** every block closes with `end`, optionally followed by its matching Name (a Handler or function) or keyword (`if`, `repeat`, `match`, `try`, `wait` or `given`). Each ending closes exactly one innermost open block, regardless of indentation. Bare and explicit endings may be mixed, and a supplied suffix must match that block.
- **Lines:** a closing suffix belongs on the same physical line as `end`; a word on the following line is never consumed as its suffix. A statement block's ending must finish its statement. After a block Lambda's ending, the enclosing expression continues under the usual rules, including commas, closing brackets and separators such as `into`.
- **Style:** the full endings used in the Spec's examples also introduce the Beginner Surface. Bare endings have the same meaning and are not Advanced Constructs. The `prefer-explicit-end` Lint advises explicit endings in the `beginner` profile ([chapter 12](12-sessions-and-tooling.md#layers-and-lints)).

<!-- generated: ebnf.blocks -->

```ebnf
If             ::= 'if' Expression 'then'
                   ( Inline ( 'else' Inline )?
                   | NL Block ( 'else' 'if' Expression 'then' NL Block )* ( 'else' NL Block )? 'end' 'if'? )
Repeat         ::= 'repeat' ( 'for' 'each' Pattern 'in' Expression | 'while' Expression
                            | 'until' Expression | 'forever' | Expression 'times' )
                   NL Block 'end' 'repeat'?
Match          ::= 'match' Expression IgnoringCase? NL ( NL | When )* ( 'else' Body NL* )? 'end' 'match'?
When           ::= 'when' 'contains'? Pattern Guard? 'then' Body
Body           ::= Inline NL | NL Block
Try            ::= 'try' NL Block ( 'catch' Pattern Guard? NL Block )* ( 'finally' NL Block )? 'end' 'try'?
Wait           ::= 'wait' ( 'for' ( Join | WaitBlock | Event Timeout? ) | Expression )
Join           ::= 'all' NL Block 'end' 'wait'?
WaitBlock      ::= NL ( NL | WaitBranch )* 'end' 'wait'?
WaitBranch     ::= 'when' Event Guard? 'then' Body | 'after' Expression 'then' Body
Event          ::= MessageName ( Pattern ( ( ',' Pattern )* | ( Label Pattern )+ ) )? ( 'from' ChunkLevel )?
Timeout        ::= 'or' Expression
```

<!-- end -->

- **One-line `if`:** `if … then` followed by a statement on the same line is the one-line form, and its `else` must be on that line too. Each branch is one `Inline` statement: not an `if`, `repeat`, `match`, `try`, Join or block `wait for`.
- **Block `if`:** `if … then` at the end of a line opens a block, closed by `end` or `end if`. An `else if … then` or `else` ends its line too.
- **`repeat`:** `forever` straight after `repeat` always means a loop with no end, and never a count. A count is any expression before `times`.
- **`match`:** each `when` has one pattern, then an optional Guard. `when contains <…>` searches rather than matching the whole value. At most one `else` comes last. A branch body is an `Inline` statement on the same line, or a block.
- **`wait for`:** an event, optionally with `from` and a timeout (`wait for click from okButton or 30 s`). An event's patterns take [Argument Labels](#argument-labels) as a head's parameters do (`wait for move p to sq`), and since `from` is never a label, it always starts the source. `from` takes a postfix-level operand, so the `or` there is the timeout. At the end of a line, `wait for` starts a block of `when` and `after` branches, and `wait for all` starts a Join. Neither block has a one-line form.
- **`try`:** `catch` clauses are Destructuring heads with optional Guards, tried top to bottom ([chapter 6](06-errors-and-limits.md)).

> **Example.**
>
> ```talk
> if the length of fruit > 3 then say "lots" else say "a few"
> repeat for each [k, v] in pairs
>   if v is empty then next repeat
>   say k
> end repeat
> match msg
>   when <"ID-", num: 4 digits as number> then put num into id
>   when contains <"WARN"> then tell log to write msg
>   else put nothing into id
> end match
> wait for all
>   repeat for each s in stations
>     send allReadings with s to me and wait
>   end repeat
> end wait
> ```

## Expressions

<!-- generated: ebnf.expressions -->

```ebnf
Expression     ::= Lambda | Or
Lambda         ::= 'given' ( Pattern ( ',' Pattern )* )? ( ':' Expression | NL Block 'end' 'given'? )
Or             ::= And ( 'or' And )*
And            ::= Not ( 'and' Not )*  /* never `and` before `wait` */
Not            ::= 'not' Not | Comparison
Comparison     ::= Concat ( Comparator IgnoringCase? )?
Comparator     ::= ( '=' | '<>' | '<' | '>' | '<=' | '>=' | 'contains' | 'matches'
                   | 'begins' 'with' | 'ends' 'with' ) Concat
                 | 'is' 'not'? ( 'in' Concat | Article Kind | 'empty' | Concat )
                 | 'can' 'be' Article? Kind
Article        ::= 'a' | 'an'
IgnoringCase   ::= 'ignoring' 'case'
Concat         ::= Range ( '&' Range )*
Range          ::= Additive ( '..' Additive )?
Additive       ::= Multiplicative ( ( '+' | '-' ) Multiplicative )*
Multiplicative ::= Power ( ( '*' | '/' | 'mod' | 'div' ) Power )*
Power          ::= Unary ( '^' Power )?
Unary          ::= '-' Unary | Conversion
Conversion     ::= ChunkLevel ( 'as' ( Unit | Kind ) )*
                   /* inside a BuildField, `as` before an integer type, a number, `(` or `^` ends the value */
Kind           ::= 'civil' 'date' | 'function' | Name
```

<!-- end -->

The operators, lowest precedence first:

<!-- generated: grammar.operators -->

| Level | Associativity | Operators |
| --- | --- | --- |
| 1 | left | `or` |
| 2 | left | `and` |
| 3 | prefix | `not` |
| 4 | none | `=`, `<>`, `<`, `>`, `<=`, `>=`, `is`, `is not`, `is in`, `is not in`, `is a`, `is not a`, `is empty`, `is not empty`, `can be`, `contains`, `begins with`, `ends with`, `matches` |
| 5 | left | `&` |
| 6 | none | `..` |
| 7 | left | `+`, `-` |
| 8 | left | `*`, `/`, `mod`, `div` |
| 9 | right | `^` |
| 10 | prefix | `-` |
| 11 | postfix | `as` |
| 12 | postfix | `of`, `'s`, `f(…)` |

<!-- end -->

- **Lambdas** have the lowest precedence of all. The body of `given r: …` runs to the next top-level comma or closing bracket, so `map(xs, given r: r * 2, 2)` passes `2` as a third argument. A block Lambda (`given r` at the end of a line) ends with `end` or `end given`. Zero parameters are written `given: e`, or `given` alone at the end of a line.
- **Comparisons don't chain:** `a = b = c` is a syntax error at the second `=`.
- **`is`:** after `is` or `is not`, `in` tests membership, `a` or `an` before a kind tests the kind, `empty` tests emptiness, and anything else is equality. So `x is a number` is a kind test, and `x is a then …` compares `x` with a variable `a`.
- **Kinds:** a kind or Unit after `is a`, `can be` or `as` is a Name, `civil date`, or `function`, the one Reserved Word that names a kind, so `f is a function` works. Which names are kinds is a load rule ([chapter 3](03-values.md)).
- **Unary minus** binds tighter than `^`, so `-2 ^ 2` is `4`.

Each trailing modifier attaches to its own construct:

<!-- generated: grammar.modifiers -->

| Modifier | Attaches to |
| --- | --- |
| `as` | the operand before it, as a postfix operator above every binary operator and below chunk `of`, `'s` and calls |
| `ignoring case` | the nearest comparison before it, a `match` subject, or a Text Pattern element |
| `delimited by` | the outermost Chunk Expression of an `of` chain |
| `lazily` | a Text Pattern element |
| `and wait` | a `send`, an `ask`, a Command Call or a call statement, and only as a whole statement |
| `little, big` | an integer field of a Binary Pattern or build |

<!-- end -->

- **`as`:** `item 2 of line 3 of r as number * 2` means `((item 2 of line 3 of r) as number) * 2`.
- **`ignoring case`** binds to the nearest comparison, so in `a is b and c is d ignoring case` it applies only to `c is d`. Functions take no `ignoring case`, so a case-insensitive search passes a Text Pattern, as in `offset(<"abc" ignoring case>, s)`.
- **`delimited by`:** in `item 2 of line 3 of r delimited by ";"`, the delimiter belongs to the whole chain.

## Operands

<!-- generated: ebnf.operands -->

```ebnf
ChunkLevel     ::= Postfix ( 'delimited' 'by' Postfix )?
                   /* `delimited by` only after a Chunk Expression or a plural chunk property */
Postfix        ::= Primary ( "'s" Key )*
Key            ::= 'code' 'points' | Word
Primary        ::= Number Unit? | Text | InterpolatedText | TextPattern | BinaryBuild | '(' Expression ')'
                 | List | Map | 'true' | 'false' | 'nothing' | 'it' | 'me'
                 | The | ReplaceExpression | MatchSearch | Chunk | Call | Name
Call           ::= Name CallOpen ExpressionList? ')'
Chunk          ::= ChunkWord Range 'of' Postfix
ChunkWord      ::= 'code' ( 'point' | 'points' ) | Name  /* a chunk kind's singular or plural */
The            ::= 'the' ( '(' Expression ')' 'of' Postfix | Text 'of' Postfix | 'target'
                         | Ordinal ( 'code' 'point' | Name ) 'of' Postfix | Key 'of' Postfix )
                   /* the Name after an Ordinal is a chunk kind's singular */
Ordinal        ::= Name  /* one of grammar.toml's ordinals */
MatchSearch    ::= 'every' 'match' 'of' ChunkLevel 'in' Concat
ReplaceExpression ::= 'replace' 'first'? ChunkLevel 'in' Or 'with' Concat
List           ::= '[' ( ListItem ( ',' ListItem )* )? ']'
ListItem       ::= '...'? Expression
Map            ::= '{' ( MapKey Expression ( ',' MapKey Expression )* )? '}'
MapKey         ::= ( Word | Text ) ':'
```

<!-- end -->

- **Chunk words:** a chunk word followed by a token that can start an index is a Chunk Expression. An index starts with a Number, a Text, `-`, `[`, `(` with a space before it, a Name that isn't in the FOLLOW set, or `the`, `it` or `me`. Anything else makes the chunk word a Name. So `put 5 into line` and `line 3 of report` both work, but `put line - 1 into x` reads `line -1 of …` and fails at `into`, and needs `(line) - 1`.
- **Keys and properties:** `the <word> of x` reads a key, unless the word is a Built-in property below. Any Word may follow `the` or `'s`, Reserved Words included, and `code points` is read as one. `the "any key" of m` always reads a key, and `the (k) of m` computes one.
- **Ordinals** name a chunk only after `the`, and only when a chunk kind's singular follows (`the last word of s`). Otherwise the ordinal is a key.
- **`the target`** is the object a message was sent to. `the target of x` is a key named `target`.
- **Calls need a name:** `name(` with no space is the only call. A call's result can't be called again, so `times(3)(14)` is a syntax error at the second `(`.
- **Lists and maps:** `...` spreads a list into a list literal. In a map literal, a Word or a Text followed by `:` is a key, Reserved Words included. A map literal has no computed keys.
- **The Match Search** is `every match of <p> in s`. Any other `every` is a Name.

The chunk kinds:

<!-- generated: grammar.chunks -->

| Chunk kind | Plural |
| --- | --- |
| `character` | `characters` |
| `word` | `words` |
| `line` | `lines` |
| `item` | `items` |
| `byte` | `bytes` |
| `code point` | `code points` |

<!-- end -->

The ordinals:

<!-- generated: grammar.ordinals -->

`first`, `second`, `third`, `fourth`, `fifth`, `sixth`, `seventh`, `eighth`, `ninth`, `tenth`, `last`

<!-- end -->

The Built-in property names, which `the <name> of x` reads instead of a key:

<!-- generated: grammar.properties -->

`length`, `keys`, `values`, `items`, `lines`, `words`, `characters`, `bytes`, `code points`

<!-- end -->

> **Example.**
>
> ```talk
> put word 2 of line 3 of report into w
> put characters 2..4 of w into mid
> put the last word of s into tail
> put the length of the words of s into count
> put person's age into a
> put the "full name" of person into fn
> put item 2 of "a;b;c" delimited by ";" into b
> put [...fruit, "plums"] into more
> put every match of <digits> in "a1 b22" into hits
> ```

## Destructuring

<!-- generated: ebnf.patterns -->

```ebnf
Pattern        ::= PatternPrimary ( 'as' Name )?
PatternPrimary ::= ListPattern | MapPattern | TextPattern | BinaryPattern | Pin | Literal | '_' | Name
ListPattern    ::= '[' ( ListPatternItem ( ',' ListPatternItem )* )? ']'
ListPatternItem ::= '...' Name? | Pattern
MapPattern     ::= '{' ( MapPatternEntry ( ',' MapPatternEntry )* )? '}'
MapPatternEntry ::= MapKey Pattern | Name
Pin            ::= '^' Name
Literal        ::= Text | '-'? Number Unit? | 'true' | 'false' | 'nothing'
```

<!-- end -->

- **Where Destructuring goes:** Handler heads, `let`, `match … when`, `catch`, `repeat for each`, Lambda parameters and `wait for` events.
- **A Name binds,** and `_` matches anything without binding. In a map, a Name alone is short for `{name: name}`.
- **`as name`** after a pattern binds the whole value it matched.
- **Literals** match by `=`: a Text, a Number with an optional sign and Unit, `true`, `false` and `nothing`. A text literal in a `catch` or `on error` head is short for `{code: "…"}` ([chapter 6](06-errors-and-limits.md)).
- **The pin** `^name` compares with an existing variable instead of binding.
- **No kind tests inside a pattern:** a kind test goes in the Guard, as in `where a is a number`.

## Text Patterns

<!-- generated: ebnf.text-patterns -->

```ebnf
TextPattern    ::= PatternOpen ( Alternation ( ',' Alternation )* )? PatternClose
Alternation    ::= Element ( 'or' Element )*
Element        ::= Atom ( 'as' Kind | 'lazily' | 'ignoring' 'case' )*
Atom           ::= Text | Number Atom | TextPattern | '(' Expression ')' | Capture
                 | Anchor | PatternClass | Repetition | Article Kind | PatternKeyword
Capture        ::= Name ':' Alternation
Anchor         ::= ( 'text' | 'line' ) ( 'start' | 'end' ) | 'word' 'break'
PatternClass   ::= ( 'uppercase' | 'lowercase' ) ( 'letter' | 'letters' )
Repetition     ::= ( 'one' | 'zero' ) 'or' 'more' 'of' Atom | 'optional' Atom
PatternKeyword ::= Name  /* one of grammar.toml's Text Pattern keywords */
```

<!-- end -->

<!-- generated: grammar.text-patterns -->

- **Keywords:** `character`, `characters`, `digit`, `digits`, `letter`, `letters`, `punctuation`, `space`, `spaces`, `text`, `whitespace`, `word`, `words`.
- **Classes:** `lowercase letter`, `lowercase letters`, `uppercase letter`, `uppercase letters`.
- **Anchors:** `line end`, `line start`, `text end`, `text start`, `word break`.
- **Repetitions:** `one or more of`, `optional`, `zero or more of`.

<!-- end -->

- **Bare words:** a bare Word inside `<…>` is a Text Pattern keyword, part of a class, anchor or repetition, the article of a Typed Element (`a number`), or, when a `:` follows, a Capture. Anything else is a syntax error at the word.
- **Captures:** a Word followed by `:` names a Capture, and a Reserved Word can't, so `<end: word>` is a syntax error at `end`.
- **Anchors** are two words, decided on two tokens. `end` alone means nothing inside `<…>`.
- **Grouping** is a nested `<…>`: `one or more of <letter or digit>`. `( … )` always holds an expression, whose value is spliced in (`<"ID-", (idPat)>`), so `(letter or digit)` would splice a boolean.
- **Modifiers** trail the element they modify: `"x" ignoring case`, `text lazily`, `4 digits as number`.

## Binary Patterns

<!-- generated: ebnf.binary-patterns -->

```ebnf
BinaryPattern  ::= BinaryOpen ( Field ( ',' Field )* )? '>>'
Field          ::= '...' Name? AsText? | Number | Text | ( Name | '_' ) ':' FieldType
                   /* the Name after `...` isn't `as` */
FieldType      ::= IntegerType ByteOrder? | Size SizeUnit AsText?
IntegerType    ::= Name  /* one of grammar.toml's integer types */
ByteOrder      ::= 'little' | 'big'
Size           ::= Number | Pin | Name | '(' Expression ')'
                   /* inside the parentheses, a Pin is also a Primary */
SizeUnit       ::= 'byte' | 'bytes' | 'bit' | 'bits'
AsText         ::= 'as' 'text'
BinaryBuild    ::= BinaryOpen ( BuildField ( ',' BuildField )* )? '>>'
BuildField     ::= Concat ( 'as' FieldType )?
```

<!-- end -->

<!-- generated: grammar.binary-patterns -->

- **Integer types:** `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`.
- **Size units:** `bit`, `bits`, `byte`, `bytes`.
- **Byte orders:** `big`, `little`.

<!-- end -->

- **Fields:** in a Binary Pattern, a Word followed by `:` names a field, and a Number or Text is a literal field. `...` ends the pattern, optionally binding the rest.
- **Sizes** are a Number, a Name bound earlier in the pattern, a pinned `^n`, or a parenthesised expression, inside which `^n` may also appear (`(^n * 2) bytes`).
- **Building:** in `<< … >>` in operand position, each field is a value with an optional `as` type. `as` followed by an integer type, a number, `(` or `^` ends the value and starts the field type, so `<< the length of b as uint16, b >>` and `<< flags as 4 bits, mode as 4 bits >>` need no parentheses. A size held in a name is written in parentheses, `v as (n) bytes`, since `as n` would read as a conversion. Inside brackets within the value, `as` is a conversion again.

> **Example.**
>
> ```talk
> on packet << 0x02, id: uint32, x: int16 little, body: len bytes, ...rest >>
>   send moved with << 0x02, id as uint32, x as int16 >> to lobby
> end packet
> ```

## Two-token decisions

These are the only places where the parser reads a second token before it chooses. Everywhere else, one token decides.

<!-- generated: grammar.decisions -->

| Decision | Rule |
| --- | --- |
| `and-wait` | `and` followed by `wait` ends the expression before it, and is never a boolean `and` |
| `as-in-build` | inside `<< >>`, `as` followed by an integer type, a number, `(` or `^` ends the value and gives the field type |
| `begins-with` | `begins` or `ends` followed by `with` is the operator; otherwise the word ends the expression |
| `binary-field` | in a Binary Pattern, a word followed by `:` names a field |
| `can-be` | `can` followed by `be` is the kind test; otherwise the word ends the expression |
| `capture` | in a Text Pattern, a word followed by `:` is a Capture |
| `chunk-word` | a chunk word followed by a token that can start an index, and isn't a FOLLOW-set word, is a Chunk Expression; otherwise it is a name |
| `code-point` | `code` followed by `point` or `points` is the chunk kind |
| `delimited-by` | `delimited` followed by `by` is the modifier |
| `during` | after a comma in a Handler head, `during` followed by a word is the modifier |
| `every-match` | `every` followed by `match` starts a Match Search; otherwise `every` is a name |
| `ignoring-case` | `ignoring` followed by `case` is the modifier |
| `is-a` | after `is` or `is not`, `a` or `an` followed by a word that isn't reserved, or by `function`, starts a kind test; otherwise it is a name |
| `kind` | `civil` followed by `date` is the kind `civil date` |
| `map-key` | in `{…}`, a word or text followed by `:` is a key, Reserved Words included; in a map pattern, a word without `:` is the shorthand `{name}` |
| `next-repeat` | at the start of a statement, `next` followed by `repeat` is the loop statement; otherwise `next` starts a Command Call |
| `ordinal` | after `the`, an ordinal followed by a singular chunk word (or `code`) is an ordinal chunk; otherwise it is a key |
| `pattern-anchor` | in a Text Pattern, `text`, `line` or `word` followed by the second word of an anchor is that anchor |
| `replace-first` | after `replace`, `first` followed by anything but `in` means only the first match |
| `script-variable` | at top level, `script` followed by `variable` starts a Script Variable |
| `target` | after `the`, `target` not followed by `of` is `the target` |
| `wait-from` | in an event, `from` followed by a token that can start an operand is the sender; otherwise it is a name in the event's patterns |
| `when-contains` | after `when` in a `match`, `contains` followed by `<` is a search; otherwise `contains` is a name |

<!-- end -->

The second token of each decision is lexed in the same mode under both readings, so choosing never changes how a token was lexed.

> **Note.** [`tools/grammar/`](../tools/grammar/check.ts) holds a parser that follows this chapter, reads its word lists from [`grammar.toml`](data/grammar.toml), throws on a third token of lookahead and names every two-token decision it takes. `bun run grammar:check` runs it over the syntax sketch, every `talk` block in `docs/` and `spec/`, the corpus, and the broken cases in `tools/grammar/broken.talk`, whose first errors it checks. CI runs it on every pull request. Like all tooling, it isn't normative ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Advanced Constructs

Every Core accepts every construct. These are tagged Advanced for tooling only, and a Lint in the `beginner` Lint Profile flags them ([ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md)). The tags are published with the language version but aren't covered by parity.

<!-- generated: grammar.advanced -->

| Advanced Construct | Written | Beginner Surface form |
| --- | --- | --- |
| The pin | `^name` in a pattern, e.g. `{order: ^orderId}` | `{order: o} where o = orderId` |
| A pinned Binary Pattern size | `^n bytes`, or `^` inside a parenthesised size | a Guard on the length the pattern read, or `...rest` and then `bytes 1..n of rest` |
| The `code point` chunk | `code point 1 of s`, `code points 2..3 of s` | Characters |
| The `code points` property | `the code points of s` | Characters |
| `lazily` | after a Text Pattern element, e.g. `text lazily` | a narrower element |

<!-- end -->

## Syntax errors

<!-- generated: grammar.syntax-errors -->

| Code | Raised when |
| --- | --- |
| `bad character` | A character outside a text literal or comment starts no token |
| `unterminated text` | An ordinary text literal is unclosed at its line end, or a fenced literal is unclosed at EOF; reported at its opener |
| `bad unit` | A Unit after a numeric literal names a factor the Unit Catalogue doesn't have, has a malformed or negative exponent, or names two Units of one Unit Kind |
| `unexpected token` | A token can't continue the parse, including the end of a line or of the source |
| `not a container` | A Container's root isn't a name, e.g. `put 1 into 3`; reported at the Container's first token |
| `unterminated interpolation` | A hole is unclosed at EOF; reported at its dollar-brace opener |
| `empty interpolation` | An interpolation hole contains no expression |
| `invalid text escape` | A backtick escape is malformed, octal, or produces an unpaired surrogate |
| `invalid text indentation` | Fenced text does not match its closing margin |
| `invalid text delimiter` | A raw closing quote run is longer than its opening fence |

<!-- end -->

- **Only the first syntax error is normative:** its code and its position. The parse stops there.
- **Its position** is the first token that can't continue the parse. A lexical error is reported where its token starts, and `not a container` at the Container's first token.
- **Error order:** lexical and parse errors come first, then [load-time diagnostics](#load-time-diagnostics) in source order. Since the parse stops at the first syntax error, source with one has no other load-time diagnostics.

> **Example.** In `put 5 into` followed by a comment, the error is at the end of the line, after the comment. In `if count > then say "x"`, it is at `then`. In `put <"a", bogus> into x`, it is at `bogus`.

## Load-time diagnostics

Source that parses is then checked, and each rule it breaks is a load error: the Script, Library or Entry doesn't load. The chapters state the rules, and [`diagnostics.toml`](data/diagnostics.toml) gives each one its code. A code covers a family of rules, and no code is shared with a syntax error, an Error Code or a Host error.

<!-- generated: diagnostics -->

| Code | Raised when | Reported at | Sources |
| --- | --- | --- | --- |
| `unknown name` | A Name resolves to nothing (chapter 4), including a well-known object the Host didn't bind, or a Binary Pattern size names a name that isn't bound earlier in the pattern | the Name | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not a value` | The bare name of a Handler or a Built-in function is used as a value | the name | [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `name clash` | A name has two meanings: a variable named like a function of the unit or an Import, a parameter, pattern binding or Capture named like a Script Variable, a Constant or a well-known object, an imported name, after any rename, named like a local Handler, function, Constant, Script Variable or well-known object, two Imports of one name, or a Library Handler that an importer also defines | the later of the two in the source; for an Import, its name in the `use` line | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `duplicate name` | One pattern binds the same Name twice, or a Text Pattern has two Captures with one name | the second | [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `duplicate key` | A map literal names a key twice | the second key | [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `unknown kind` | A name after `is a`, `as` or `can be` isn't a kind name, `integer` or a Unit, or a Text Pattern's `a` or `an` is followed by a kind other than `number` | the kind name | [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `no conversion` | `as` names a kind that has no conversion, or a Text Pattern's `as number` follows an element that can match something other than ASCII digits or `a number` | `as` | [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `bad number` | A number literal has more than 34 significant digits, a magnitude of 10^34 or more, or more than 6176 fraction digits | the literal | [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `pattern too large` | A Text Pattern with no splices compiles to a program over the Script's `patternSize`, counting every copy of a counted repetition | the pattern's opening `<` | [ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md), [#92](https://github.com/odogono/odgn-talk/issues/92), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `wrong argument count` | A call to a function, the unit's own or imported, passes fewer arguments than its parameters without defaults, or more than all of them, a Capability call passes a number of arguments its Operation Declaration doesn't take, or `say` has no argument or more than one | the function's or Operation's name, or `say` | [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `wrong argument` | A literal argument of a Capability call breaks its parameter's Shape: a literal of the wrong kind, or a closed map literal whose keys don't fit | the argument's first token | [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `unknown operation` | `ask` or `tell` names a Grant the Script doesn't hold, including one revoked before a Reload, or an Operation its Grant doesn't declare | the Grant's name, or the Operation's | [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `wrong mode` | A call doesn't fit its Operation's mode: `ask … and wait` on an immediate Operation, `ask` without `and wait` on a suspending one, `ask` on a fire-and-forget one, or `tell` on one that isn't fire-and-forget | `ask` or `tell` | [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `missing and wait` | A Command Call to a Handler that may suspend has no `and wait` | the Handler's name | [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `needless and wait` | A Command Call with `and wait` names a Handler that can't suspend, or `say` has `and wait` | the Handler's name, or `say` | [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `can't suspend here` | A possible Suspension Point is in a `finally` block, or a named function, or a Handler called function-style, reaches one, directly or through what it calls | the Suspension Point, or the call in the function or Handler through which it reaches one | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `unknown import` | A `use` line names a Library the Group doesn't hold, or a name the Library doesn't export | the Library's name, or the name | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `import cycle` | Libraries import each other in a cycle | the `use` line that closes the cycle | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `missing grant` | A Library the Script imports, directly or through another Library, needs an Operation that the Script's Grants don't give | the `use` line | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not in a library` | Library code uses `me`, `the target`, `pass`, `veto`, `wait for`, `send` or a well-known object name, or has a top-level `script variable` | its first token | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not in a script` | A Script's declaration starts with `private` | `private` | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not in a lambda` | `pass` or `the target` is inside a Lambda | `pass` or `the` | [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not in a guard` | A Guard calls anything but a Built-in, a call through a name that shadows a Built-in included, holds a Lambda, or reads a non-id key of a Host Object known at load; a computed key on such an object must be the text literal id | the call's name, the Lambda's `given`, or the key's `the` or `'s` | [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not in a join` | A Join's body holds `wait`, `wait for`, a nested Join, `name … and wait`, `f(x) and wait`, `return`, `veto`, `pass`, an `exit repeat` or `next repeat` whose loop is outside the Join, or a member inside a `try` | its first token, or the member's | [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `empty join` | A Join has no member in its source | its `wait` | [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `leaves finally` | A `return`, `veto` or `pass` is inside a `finally` block, or an `exit repeat` or `next repeat` inside one belongs to a loop outside it | its first token | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `outside a loop` | An `exit repeat` or `next repeat` is outside any loop | its first token | [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `veto outside a decision` | `veto` is outside a `, deciding` Handler: in a function, a Lambda, or a Handler reached by a local call, Command Call or function-style | `veto` | [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `after a suspension` | A `veto` or `pass` in a `, deciding` Handler is reached, on some path from the Handler's start, through a possible Suspension Point | `veto` or `pass` | [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `wrong message` | `pass m` names a message other than the one its Handler handles | the message's name | [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `bad suffixes` | A Handler head has more than one of `queued`, `dropping` and `replacing`, a suffix twice, `, queued` with `, deciding`, or `, during` on a Handler other than `on error` | the first suffix that breaks the rule | [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `can't write` | A Container is rooted in a Constant, a Lambda puts into a captured local, or `set` writes a read-only property of a Host Object whose kind and key are known at load | the Container's root, or `set` | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not a property` | `set` writes a bare variable, not a key of a Host Object | `set` | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `not constant` | The initialiser of a Constant or a Script Variable, or a parameter's default, uses anything but literals, Constants declared above it and Built-ins | the first token that isn't allowed | [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `default order` | A parameter without a default follows one with a default | the parameter | [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `initialiser failed` | An initialiser raises an error when the unit loads | the raising instruction's position in the source map | [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `nothing to fold` | `ignoring case` follows `is a`, `can be` or `is empty`, which compare no text | `ignoring` | [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `no item chunk` | `delimited by` ends a Chunk Expression chain that has no `item` chunk | `delimited` | [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `capture in repetition` | A Text Pattern's Capture is inside a repetition | the Capture's name | [ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `rest not last` | A `...` or `...rest` is anywhere but last in a list pattern or a Binary Pattern | the `...` | [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |
| `bits not whole bytes` | A run of bit fields in a Binary Pattern or a `<< … >>` build doesn't add up to whole bytes | the run's first field | [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [#115](https://github.com/odogono/odgn-talk/issues/115) |

<!-- end -->

- **All of them are normative:** every diagnostic, its code and its position, which is the token its entry gives, in the unit's own lines and columns.
- **Order:** by position, and at one position in the order the table lists their codes.
- **One per construct:** a construct that breaks one rule several times, such as a call with two arguments too many, has one diagnostic.

## Outside parity

- **Messages:** the wording of a syntax error. Its code and position are normative.
- **Recovery:** anything a Core or tooling reports after the first syntax error ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
- **Syntax trees:** the shape of a Core's tree. Only the parse, as the lowering shows it, is normative.
- **Tags and Lints:** the Advanced tags and every Lint ([ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md)).
