# 2. Grammar

_Draws on:_ [ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md), [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md).

The grammar is one set of productions, in [`grammar.ebnf`](data/grammar.ebnf), and one set of word lists, in [`grammar.toml`](data/grammar.toml). This chapter shows both and states the rules they can't. What each construct means is in the chapters that follow.

- **Predictive:** a Core parses with a fixed lookahead of two tokens and no backtracking. Every choice between productions is made on the next token, or on the next two where [a decision below](#two-token-decisions) says so.
- **One grammar:** the grammar is the same on every Host. Neither Hosts nor Scripts can add syntax ([ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md)).
- **What is normative:** for source that parses, the parse, since a different parse lowers differently ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)). For source that doesn't, the first syntax error: its code and position.

## Notation

- **The EBNF** is that of [the W3C XML Recommendation](https://www.w3.org/TR/xml/#sec-notation), as [chapter 0](00-introduction.md#notations) says.
- **Tokens** come from [chapter 1](01-lexical-structure.md#tokens): `Word`, `Name`, `Number`, `Text`, `Unit` and `NL`, plus `CallOpen` (a `(` straight after a Name), `PatternOpen` and `PatternClose` (the `<` and `>` of a Text Pattern) and `BinaryOpen` (`<<` in operand position).
- **A quoted word** such as `'put'` matches a Word with that spelling. If it is a Reserved Word, it is only ever that keyword. Otherwise it is a contextual keyword, which has its meaning only where a production quotes it, and is an ordinary Name everywhere else.
- **Overlaps:** where a contextual keyword could also be read as a Name, a [two-token decision](#two-token-decisions) picks the reading.
- **Comments** in a production state a rule that the notation can't, such as "the Name after `end` is the Handler's name".

## Words

### Reserved Words

<!-- generated: grammar.reserved -->

`add`, `after`, `and`, `ask`, `be`, `catch`, `delete`, `divide`, `else`, `end`, `exit`, `false`, `finally`, `for`, `function`, `given`, `if`, `in`, `into`, `is`, `it`, `let`, `match`, `me`, `multiply`, `not`, `nothing`, `of`, `on`, `or`, `pass`, `put`, `repeat`, `replace`, `return`, `send`, `set`, `subtract`, `tell`, `the`, `then`, `throw`, `to`, `true`, `try`, `until`, `veto`, `wait`, `when`, `where`, `while`

<!-- end -->

A Reserved Word is never a Name, anywhere. Each one is reserved for a reason:

- **Block structure:** `end`, `else`, `when`, `catch`, `finally` and `after` end or continue a block at the start of a statement, and `then` ends a condition. None of them can be a Handler name.
- **Statement keywords:** if `add` were contextual, `add 1 to x` and a Command Call `add 1` would differ only at `to`, arbitrarily far in. The same holds for every statement keyword.
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
| `as` | after an operand (a conversion); after a pattern (binding the whole value); after the imported name in `use`; after a Text Pattern element; after the value of a Binary Pattern build field |
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

## Source and declarations

<!-- generated: ebnf.source -->

```ebnf
Source         ::= NL* ( Declaration NL* )*
Declaration    ::= 'private'? ( Handler | Function | Constant ) | ScriptVariable | Use
ScriptVariable ::= 'script' 'variable' Name ( '=' Expression )? NL
Constant       ::= 'constant' Name '=' Expression NL
Use            ::= 'use' Name ( ( ',' Name )+ 'from' Name | 'from' Name ( 'as' Name )? ) NL
Function       ::= 'function' Name ( Name ( ',' Name )* )? NL Block 'end' Name NL
                   /* the Name after `end` is the function's name */
Entry          ::= NL* ( Declaration | Statement NL | Expression NL )
                   /* at a Session prompt only; decided on its first token */
```

<!-- end -->

- **Top level:** a Script or Library is a sequence of declarations, and a top-level line can only start one. A statement at top level is a syntax error at its first token.
- **Declarations are decided on their first token,** except `script variable`, which is decided on two. `use`, `constant`, `private`, `script` and `variable` are contextual, since a top-level line can't start anything else.
- **`=`** in a Script Variable or Constant means "starts as". It is equality everywhere else.
- **`use … as`** renames a single imported name (`use trim from text as tidy`). After two or more names, `as` is a syntax error.
- **`private`** goes before a Handler, a function or a Constant. It is a load error in a Script ([chapter 7](07-libraries-and-the-standard-library.md)).
- **Functions** take a list of names, with no Destructuring. The Name after `end` must be the function's name.

> **Example.**
>
> ```talk
> use pad, trim from text
> use sum from list as total
> script variable visits = 0
> constant welcome = "Hello"
>
> function tax amount, rate
>   return amount * rate
> end tax
> ```

### Entries

An Entry is what a Session reads at its prompt ([ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [chapter 12](12-sessions-and-tooling.md)). It is decided on its first token, with no second parse:

- A word that starts a declaration (`on`, `function`, `private`, `use` or `constant`, and `script` before `variable`) starts one.
- Any other Reserved Word starts a statement.
- Any other Name starts a Command Call only if the Session Script has a Handler by that name. Otherwise the Entry is an expression, and its value is echoed. So `n - 1` echoes a value rather than calling a Handler `n` with `-1`.

## Handlers

<!-- generated: ebnf.handlers -->

```ebnf
Handler        ::= 'on' MessageName HandlerHead NL Block ( 'finally' NL Block )? 'end' Name NL
                   /* the Name after `end` is the Handler's name */
HandlerHead    ::= ( Pattern ( ',' Pattern )* )? Guard? ( ',' Suffix )*
Suffix         ::= 'queued' | 'dropping' | 'replacing' | 'deciding' | 'during' Name
Guard          ::= 'where' Expression
MessageName    ::= Name  /* not `all` */
```

<!-- end -->

- **Handler and message names** are one Name each (`beforeClose`). `all` can't name a Handler, a message or an event, since `wait for all` starts a Join.
- **The head** is the parameters, then an optional Guard, then the suffixes, in that order. Each parameter is one Destructuring pattern.
- **Suffixes:** after a comma in a head, `queued`, `dropping`, `replacing` and `deciding` are always suffixes, so none of them can be a parameter name there. `during` followed by a Name is the `during` suffix. Which suffixes may combine is a load rule ([chapter 5](05-handlers-messages-and-scheduling.md)).
- **The end:** the Name after `end` must be the Handler's name, so a missing `end repeat` is reported at the name after `end`, not at `end`.
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
Send           ::= 'send' MessageName ( 'with' ExpressionList )? 'to' Expression AndWait?
Ask            ::= 'ask' Expression 'to' Word ExpressionList? AndWait?
Tell           ::= 'tell' Expression 'to' Word ExpressionList?
AndWait        ::= 'and' 'wait'
Return         ::= 'return' Expression?
Veto           ::= 'veto' Expression?
Pass           ::= 'pass' MessageName
Exit           ::= 'exit' 'repeat'
Next           ::= 'next' 'repeat'
Throw          ::= 'throw' Expression
Replace        ::= 'replace' 'first'? ChunkLevel 'in' Container 'with' Expression
CallStatement  ::= Call AndWait?
CommandCall    ::= Name ExpressionList? AndWait?
ExpressionList ::= Expression ( ',' Expression )*
```

<!-- end -->

- **Every statement keyword is reserved,** so a statement that starts with a Name is a Command Call or a call statement.
- **Command Calls:** a Name, then its arguments, if the next token can start an expression. So `greet "Ann"` passes one argument, `blink and wait` passes none, and `n - 1` passes `-1` to a Handler `n`.
- **Call statements:** a Name straight followed by `(`, with no space, is a call (`refresh()`), not a Command Call. With a space, `(` groups an argument, so `say (1 + 2) & "!"` passes one argument.
- **`and wait`** ends a `send`, an `ask`, a Command Call or a call statement, and only as a whole statement. `put f(x) and wait into y` is a syntax error at `and`.
- **Operations:** the Word after `ask … to` or `tell … to` is always an Operation name, even a Reserved Word (`ask files to delete path`). `tell` never takes `and wait`.
- **Containers:** a Container is a Name, or a Chunk Expression or key path rooted in one. A Container whose root isn't a Name is `not a container`, reported at the Container's first token (`put 1 into 3`, `put "Z" into character 20 of "short"`). What a root Name refers to is a load rule.
- **`put ...`** splices a list, and so takes only `after` or `before`.
- **`return` and `veto`** take an expression if one starts next. `return` is never an operand ([chapter 1](01-lexical-structure.md#text-literals)).
- **`pass`** names the message it passes. **`exit`** only takes `repeat`, and **`next repeat`** is decided on two tokens, so `next` is otherwise a Name.
- **`replace`:** at the start of a statement, `replace <p> in c with e` rewrites the Container `c`. In operand position, the same words give the new text. There, `c` and `e` are each an expression at the level of `&`, so `put replace <"-"> in s with "+" & x into t` replaces with `"+" & x`, and `into` ends the expression, since it isn't an operator. `replace first` replaces only the first match.

## Blocks

<!-- generated: ebnf.blocks -->

```ebnf
If             ::= 'if' Expression 'then'
                   ( Inline ( 'else' Inline )?
                   | NL Block ( 'else' 'if' Expression 'then' NL Block )* ( 'else' NL Block )? 'end' 'if' )
Repeat         ::= 'repeat' ( 'for' 'each' Pattern 'in' Expression | 'while' Expression
                            | 'until' Expression | 'forever' | Expression 'times' )
                   NL Block 'end' 'repeat'
Match          ::= 'match' Expression IgnoringCase? NL ( NL | When )* ( 'else' Body NL* )? 'end' 'match'
When           ::= 'when' 'contains'? Pattern Guard? 'then' Body
Body           ::= Inline NL | NL Block
Try            ::= 'try' NL Block ( 'catch' Pattern Guard? NL Block )* ( 'finally' NL Block )? 'end' 'try'
Wait           ::= 'wait' ( 'for' ( Join | WaitBlock | Event Timeout? ) | Expression )
Join           ::= 'all' NL Block 'end' 'wait'
WaitBlock      ::= NL ( NL | WaitBranch )* 'end' 'wait'
WaitBranch     ::= 'when' Event Guard? 'then' Body | 'after' Expression 'then' Body
Event          ::= MessageName ( Pattern ( ',' Pattern )* )? ( 'from' ChunkLevel )?
Timeout        ::= 'or' Expression
```

<!-- end -->

- **One-line `if`:** `if … then` followed by a statement on the same line is the one-line form, and its `else` must be on that line too. Each branch is one `Inline` statement: not an `if`, `repeat`, `match`, `try`, Join or block `wait for`.
- **Block `if`:** `if … then` at the end of a line opens a block, closed by `end if`. An `else if … then` or `else` ends its line too.
- **`repeat`:** `forever` straight after `repeat` is always the keyword. A count is any expression before `times`.
- **`match`:** each `when` has one pattern, then an optional Guard. `when contains <…>` searches rather than matching the whole value. At most one `else` comes last. A branch body is an `Inline` statement on the same line, or a block.
- **`wait for`:** an event, optionally with `from` and a timeout (`wait for click from okButton or 30 s`). `from` takes a postfix-level operand, so the `or` there is the timeout. At the end of a line, `wait for` starts a block of `when` and `after` branches, and `wait for all` starts a Join. Neither block has a one-line form.
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
Lambda         ::= 'given' ( Pattern ( ',' Pattern )* )? ( ':' Expression | NL Block 'end' 'given' )
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
                   /* inside a BuildField, `as` before an integer type ends the value */
Kind           ::= 'civil' 'date' | Name
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

- **Lambdas** have the lowest precedence of all. The body of `given r: …` runs to the next top-level comma or closing bracket, so `map(xs, given r: r * 2, 2)` passes `2` as a third argument. A block Lambda (`given r` at the end of a line) ends with `end given`. Zero parameters are written `given: e`, or `given` alone at the end of a line.
- **Comparisons don't chain:** `a = b = c` is a syntax error at the second `=`.
- **`is`:** after `is` or `is not`, `in` tests membership, `a` or `an` before a kind tests the kind, `empty` tests emptiness, and anything else is equality. So `x is a number` is a kind test, and `x is a then …` compares `x` with a variable `a`.
- **Kinds:** a kind or Unit after `is a`, `can be` or `as` is a Name, or `civil date`. Which names are kinds is a load rule ([chapter 3](03-values.md)).
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
Primary        ::= Number Unit? | Text | TextPattern | BinaryBuild | '(' Expression ')'
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
ReplaceExpression ::= 'replace' 'first'? ChunkLevel 'in' Concat 'with' Concat
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

## Patterns

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

- **Where patterns go:** Handler heads, `let`, `match … when`, `catch`, `repeat for each`, Lambda parameters and `wait for` events.
- **A Name binds,** and `_` matches anything without binding. In a map pattern, a Name alone is short for `{name: name}`.
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
- **Building:** in `<< … >>` in operand position, each field is a value with an optional `as` type. `as` followed by an integer type ends the value, so `<< the length of b as uint16, b >>` needs no parentheses. Inside brackets within the value, `as` is a conversion again.

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
| `as-in-build` | inside `<< >>`, `as` followed by an integer type ends the value and gives the field type |
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
| `is-a` | after `is` or `is not`, `a` or `an` followed by a word that isn't reserved starts a kind test; otherwise it is a name |
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
| `unterminated text` | A text literal has no closing quote before the end of its line; reported at the opening quote |
| `bad unit` | A Unit after a numeric literal names a factor the Unit Catalogue doesn't have, or has a malformed or negative exponent |
| `unexpected token` | A token can't continue the parse, including the end of a line or of the source |
| `not a container` | A Container's root isn't a name, e.g. `put 1 into 3`; reported at the Container's first token |

<!-- end -->

- **Only the first syntax error is normative:** its code and its position. The parse stops there.
- **Its position** is the first token that can't continue the parse. A lexical error is reported where its token starts, and `not a container` at the Container's first token.
- **Error order:** lexical and parse errors come first, then checker diagnostics in source order. Since the parse stops at the first syntax error, source with one has no checker diagnostics.

> **Example.** In `put 5 into` followed by a comment, the error is at the end of the line, after the comment. In `if count > then say "x"`, it is at `then`. In `put <"a", bogus> into x`, it is at `bogus`.

## Outside parity

- **Messages:** the wording of a syntax error. Its code and position are normative.
- **Recovery:** anything a Core or tooling reports after the first syntax error ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
- **Syntax trees:** the shape of a Core's tree. Only the parse, as the lowering shows it, is normative.
- **Tags and Lints:** the Advanced tags and every Lint ([ADR 0027](../docs/adr/0027-layers-are-a-tooling-view-over-one-language.md)).
