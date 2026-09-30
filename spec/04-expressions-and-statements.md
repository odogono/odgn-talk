# 4. Expressions and statements

_Draws on:_ [ADR 0001](../docs/adr/0001-value-semantics.md), [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md), [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md).

This chapter says what each expression computes and what each statement does. [Chapter 2](02-grammar.md) has their syntax, and [chapter 3](03-values.md) the values they work on. Handler dispatch, messages and waiting are in [chapter 5](05-handlers-messages-and-scheduling.md), and how an error unwinds is in [chapter 6](06-errors-and-limits.md).

A load error, here as in every chapter, is a checker diagnostic: the Script or Library doesn't load, and parity covers the diagnostic ([ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md)).

## Names

### Bodies and locals

- **A body** is the code of a Handler, a function or a Lambda. Each Run of it has its own locals. A loop, a branch or a `try` block has no scope of its own.
- **Its locals** are its parameters and every name it binds: a Container root it puts into that isn't a Script Variable, and the names bound by a `let`, `repeat for each`, `match`, `catch` or `wait for` pattern, including Captures ([Destructuring](#destructuring)).
- **They start as Nothing.** When a body starts, every local that isn't a parameter holds Nothing, so reading one before anything is put into it gives Nothing.
- **`it`** is a local of every body, and also starts as Nothing ([below](#it)).
- **Script level:** a Script's Script Variables, Constants, Handlers, functions and Imports can be used from all of its bodies.
- **Built-ins:** the Built-in functions and Constants ([chapter 7](07-libraries-and-the-standard-library.md)) can be used everywhere, without an Import.

### Resolving a name

A Name in an expression or a Container refers to the first of these that has it:

1. a local of the body, or, in a Lambda, a local it captures ([Lambdas](#lambdas))
2. a Script Variable
3. a Constant, the Script's own or imported
4. a function, the Script's own or imported, whose bare name is a Function Value ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md))
5. a well-known Host Object name, bound by the Host at load ([ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md))
6. a Built-in Constant: `pi`, `newline`, `tab` or `quote`

A Name that is none of these is a load error. So is the bare name of a Handler or a Built-in function, since neither is a value.

- **No two meanings:** a variable (a local, parameter, Capture or Script Variable) that has the name of a function the Script can call, its own, imported or Built-in, is a load error. So is a parameter, pattern binding or Capture that has the name of a Script Variable, a Constant or a well-known object. Import clashes are [chapter 7](07-libraries-and-the-standard-library.md)'s.
- **Built-in Constants may be shadowed:** a Script's own variable, parameter, Capture or Constant may take the name of a Built-in Constant. The Script's name wins inside that Script ([ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md)).
- **Other positions:** a message name after `on`, `send` or `pass`, a Grant name after `ask` or `tell`, and an Operation name after `to` aren't resolved this way ([chapter 5](05-handlers-messages-and-scheduling.md)). `me` and `the target` are also chapter 5's.

### Constants and Script Variables

- **Initialisers** of a Constant and of a Script Variable may use only literals, Constants declared above them and Built-ins, so evaluating one has no effect. They are evaluated once, in source order, when the Script or Library loads, and an error in one is a load error.
- **A Script Variable** declared without `=` starts as Nothing.
- **A Constant** can never be put into, and a Container rooted in one is a load error.

### `it`

`it` holds the result of the last statement that set it, in this body:

| Statement | `it` becomes |
| --- | --- |
| `ask … to …` | the Operation's result |
| `send … and wait` | the receiver's reply |
| a Command Call to a Handler of the Script or of a Library | the Handler's result |
| a call statement, `f(x)` or `f(x) and wait` | the call's result |
| `wait for` an event | the message, or Nothing on a timeout ([chapter 5](05-handlers-messages-and-scheduling.md)) |
| a Join | the list of its members' answers, in start order |

Nothing else sets it. A Join Member leaves it unchanged inside the Join's body.

## Evaluation

- **Source order:** an expression's operands are evaluated left to right, then its operator runs. A call's arguments, a list's items, a map's values and a chunk's index are evaluated in the order they are written.
- **Errors** are raised by the operation that fails, and nothing after it in the expression is evaluated.
- **`and` and `or` short-circuit:** `a and b` evaluates `b` only if `a` is `true`, and `a or b` only if `a` is `false`. Each operand they evaluate, and the operand of `not`, must be a boolean, or `wrong kind` is raised with `expected` `"boolean"`.
- **Conditions** of `if`, `repeat while` and `repeat until` must be booleans too, so `if 0 then …` raises `wrong kind`. A Guard's must be `true` for its clause to be chosen ([Guards](#guards)).

## Operators

| Operator | Meaning |
| --- | --- |
| `=`, `<>`, `is`, `is not` | [equality](03-values.md#equality) |
| `<`, `>`, `<=`, `>=` | [ordering](03-values.md#ordering) |
| `is in`, `is not in` | membership (below) |
| `is a`, `is not a`, `can be` | [kind tests](03-values.md#conversion) |
| `is empty`, `is not empty` | [emptiness](03-values.md#conversion) |
| `contains`, `begins with`, `ends with` | search (below) |
| `matches` | a whole-text match (below) |
| `&` | joins the [text forms](03-values.md#the-text-form) of its operands |
| `..` | makes a [range](03-values.md#ranges) |
| `+`, `-`, `*`, `/`, `mod`, `div`, `^`, unary `-` | arithmetic on [numbers](03-values.md#arithmetic), [Quantities](03-values.md#quantity-arithmetic) and [dates](03-values.md#date-arithmetic) |
| `as` | [conversion](03-values.md#conversion) |
| `of`, `'s` | [keys](#keys-and-properties) and [chunks](#chunk-expressions) |

- **Membership:** `x is in xs` is `true` when some element of the list `xs` equals `x`. `x is in r` over a range is chapter 3's. Any other right operand raises `wrong kind`, with `expected` `"list"`.
- **Search:** `a contains b`, `a begins with b` and `a ends with b` take text on the left, and text or a Text Pattern on the right. Text on the right matches its own Characters, on whole-Character boundaries. They also take Bytes on both sides. Any other operand raises `wrong kind`.
- **`matches`:** `s matches p` is `true` when the Text Pattern or text `p` matches the whole of the text `s` ([Text Patterns](#matching)).
- **`&`:** the result is the NFC form of the two text forms, joined.
- **`ignoring case`** makes every comparison of two texts that its operator makes compare their simple case foldings, inside lists and maps too, and it applies to every text literal of a Text Pattern the operator uses. After `is a`, `can be` or `is empty` it is a load error, since they compare no text.

> **Example.**
>
> ```talk
> put "Total: " & 42 into label          -- "Total: 42"
> if "abc" is "ABC" ignoring case then say "same letters"
> if "banana" contains "nan" then say "found"
> if "ID-0042" begins with <"ID-", digit> then say "an id"
> if 3 is in [1, 2, 3] then say "listed"
> ```

## Keys and properties

- **`the k of x` and `x's k`** read the Built-in property `k` if `k` is one (below), and otherwise the key `k`. `the "k" of x` always reads a key, and `the (e) of x` reads the key that `e` gives, which must be text, or `wrong kind` is raised.
- **On a map,** a key gives its value, or Nothing if the map has no such key.
- **On a Host Object,** a key reads the Host's property ([chapter 9](09-embedding.md)), and `id` gives its Core-held id. Reading any key but `id` of a disposed object raises `object gone`.
- **On anything else,** Nothing included, reading a key raises `wrong kind` with `expected` `"map"`. So in `the b of the a of m`, a missing `a` raises at `b`.

The Built-in properties:

| Property | Of | Gives |
| --- | --- | --- |
| `length` | text, a list, a map, Bytes or an integer range | the number of Characters, elements, keys, bytes or integers |
| `keys` | a map | its keys, as a list, in insertion order |
| `values` | a map | its values, as a list, in the same order |
| `items` | text | its items, as a list of texts |
| `items` | a list or an integer range | its elements, as a list |
| `lines`, `words`, `characters` | text | its lines, words or Characters, as a list of texts |
| `bytes` | Bytes | its bytes, as a list of numbers |
| `code points` | text | its code points, as a list of one-code-point texts |

A property of any other value raises `wrong kind`. `the items of s delimited by ";"` splits at `;` ([below](#delimited-by)).

## Chunk Expressions

A Chunk Expression reads part of a value by kind and position: `word 2 of line 3 of report` ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)). A chunk word's singular and plural are the same chunk kind.

### Chunk kinds

| Kind | Of | One chunk is |
| --- | --- | --- |
| `character` | text | one Character |
| `word` | text | a longest run of Characters that aren't White_Space |
| `line` | text | the Characters between line breaks |
| `item` | text | the Characters between commas, or between delimiters given by `delimited by` |
| `item` | a list | one element |
| `item` | an integer range | one of its integers |
| `byte` | Bytes | one byte, as a number |
| `code point` | text | one Unicode scalar value, as text |

- **White space:** a Character is White_Space when its first scalar is. So the only word in `"cat, dog"` before the space is `"cat,"`.
- **Line breaks** are LF, CR and CR LF, and each is one Character. A line break at the very end of the text doesn't start an empty last line.
- **Items** aren't trimmed, so `"a, b"` has the items `"a"` and `" b"`. Two delimiters in a row give an empty item, and a delimiter at the very end doesn't give an empty last item.
- **Empty text** has no words, lines or items.
- **Any other value** raises `wrong kind`, as `word 1 of 42` does.

### Positions

- **An index** is an integer counted from 1, or from the end when negative, so `-1` is the last chunk. It may also be an integer range, such as `2..4` or `-3..-1`, whose ends are read the same way.
- **Ordinals:** `the first word of s` is `word 1 of s`, and so on to `tenth`. `the last word of s` is `word -1 of s`.
- **Any other index** raises `wrong kind`: a non-integer with `expected` `"integer"`, and a value of another kind with `expected` `"number"`.

### Reading

- **Text:** a chunk of text is text. A range of chunks runs from the start of the first to the end of the last, with the delimiters between them, so `items 2..4 of "a,b,c,d,e"` is `"b,c,d"`.
- **Out of range:** reading text past its end, at index 0 or over a reversed range gives empty text. Reading a list, an integer range or Bytes that way gives Nothing for a single chunk, and an empty list or empty Bytes for a range of them.
- **Chains:** each `of` reads from the value the chunk to its right gives, so `word 2 of line 3 of s` reads line 3, then its second word.
- **Chunks of text are text,** so arithmetic on them needs `as number` ([ADR 0003](../docs/adr/0003-no-implicit-coercion.md)).

### `delimited by`

`delimited by d` gives the delimiter of every `item` chunk in its chain, and of `the items of`. `d` must be text of one or more Characters, and it matches on whole Characters. A chain with no `item` chunk is a load error. An empty `d` raises `out of range` with `field` `"delimiter"`.

> **Example.**
>
> ```talk
> put "The quick brown fox" into s
> put word 2 of s into w                   -- "quick"
> put characters 2..4 of w into mid        -- "uic"
> put the last word of s into tail         -- "fox"
> put word -2 of s into brown              -- "brown"
> put item 2 of "a;b;c" delimited by ";" into b
> put item 5 of "a,b" into gone            -- ""
> put item 5 of ["a", "b"] into none       -- nothing
> put word 1 of "12 apples" as number * 2 into dozens   -- 24
> ```

## Lists and maps

- **A list literal** evaluates its items in order. `...xs` splices the elements of the list `xs` in, and any other value there raises `wrong kind` with `expected` `"list"`.
- **A map literal** evaluates its values in order, and its keys are the words or texts before each `:`. A literal with the same key twice is a load error.

## Calls

- **`f(x, y)`** calls a function: the Script's own, an imported one or a Built-in, or a Function Value held in a variable `f`. The arguments are evaluated left to right, and then the call is made.
- **Named functions** run in the caller's Run, in a new body with its parameters bound. `return e` gives the result, and a bare `return` or reaching `end` gives Nothing. A call with the wrong number of arguments is a load error. A function never suspends, and reaching a Suspension Point through one is a load error ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).
- **Handlers called as functions:** a Handler of the Script or of an imported Library may also be called as `h(x)`. It then may not suspend either.
- **Library functions** are plain calls too, in the caller's Run, on the caller's budgets and Grants ([chapter 7](07-libraries-and-the-standard-library.md)).
- **Built-ins** never run Script code and never suspend ([chapter 7](07-libraries-and-the-standard-library.md)).
- **Function Values:** calling a value held in a variable:
  - A value that isn't a Function Value raises `wrong kind` with `expected` `"function"`.
  - A stale one raises `function gone` before anything else happens.
  - The wrong number of arguments raises `wrong arity`.
  - One whose Home Script is this Script, and that can't suspend, runs in the caller's Run, like a named function.
  - One that may suspend, or whose Home Script is another Script, raises `would suspend` unless it is called as the statement `f(x) and wait`. A call from another Script is a message to the Home Script ([chapter 5](05-handlers-messages-and-scheduling.md)).
- **Depth:** each call counts toward the call depth limit, and going past it is a Limit Fault ([chapter 6](06-errors-and-limits.md)).
- **Calls need a name:** `times(3)(14)` doesn't parse ([chapter 2](02-grammar.md#operands)), so a Function Value that a call returns goes into a variable first.

## Lambdas

A Lambda makes a Function Value each time it is evaluated ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).

- **Its Home Script** is the Script whose code it is in. A Lambda in a Library has the calling Script as its Home Script.
- **Captures:** a Lambda captures each local of the enclosing body that it names, by value, as it is when the Lambda is evaluated. Inside the Lambda a captured local is read-only, and putting into one is a load error. A Lambda inside a Lambda captures from the one around it.
- **Script Variables aren't captured.** A Lambda reads and writes its Home Script's Script Variables live, as a Handler does.
- **Parameters** are Destructuring patterns, one clause only. An argument that doesn't match raises `no match`. The Lambda's own locals are its parameters and the names it binds itself.
- **Its result:** the expression form `given r: e` gives `e`. The block form gives the value of its `return`, or Nothing at `end given`.
- **Control:** `return` returns from the Lambda, never from the body around it. `pass` and `the target` are load errors inside a Lambda. `it` is the Lambda's own, and `try` works as anywhere.
- **May suspend:** the loader marks a Lambda as may-suspend when its body holds a Suspension Point, and the mark is part of the value. Only the block form can hold one, since `wait`, `ask … and wait` and `f(x) and wait` are statements.

> **Example.**
>
> ```talk
> use map from list
>
> on lambdas
>   put 3 into k
>   put given x: x * k into triple
>   put 4 into k
>   put triple(14) into answer        -- 42: k was captured as 3
>   put map([1, 2], given n: n + k) into more    -- [5, 6]
> end lambdas
> ```

## Text Patterns

A Text Pattern is a readable alternative to regular expressions, run on a linear-time matcher with no backreferences and no lookaround ([ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md)).

### Making a pattern

- **A `<…>` literal** makes a pattern value each time it is evaluated.
- **Splicing:** `( e )` inside it evaluates `e` then. A Text Pattern is spliced in as an element, and text as a literal element. Any other value raises `wrong kind` with `expected` `"pattern"`.
- **Spliced Captures** stay Captures. If splicing gives two Captures the same name, or puts a Capture inside a repetition, making the pattern raises `can't convert` with `to` `"pattern"`.

### Elements

| Element | Matches |
| --- | --- |
| a text literal | its Characters, in order |
| `character` | any one Character |
| `characters` | one or more Characters |
| `digit` | one Character that is exactly one of the ASCII digits `0` to `9` |
| `digits` | one or more `digit` |
| `letter` | one Character whose first scalar is a letter (General Category L) |
| `letters` | one or more `letter` |
| `uppercase letter`, `lowercase letter` | one Character whose first scalar is in General Category Lu, or Ll |
| `uppercase letters`, `lowercase letters` | one or more of the singular |
| `punctuation` | one Character whose first scalar is punctuation (General Category P) |
| `space` | one U+0020 |
| `spaces` | one or more `space` |
| `whitespace` | one Character whose first scalar is White_Space |
| `word` | one or more Characters that aren't White_Space |
| `words` | one or more `word`, separated by one or more `whitespace` |
| `text` | zero or more Characters |
| `a number` | an optional `-`, `digits`, then optionally `.` and `digits`, giving a number |
| `<…>` | the elements inside it, as one element |
| `a or b` | `a`, or else `b` |

- **Sequences:** elements separated by commas match one after another.
- **Repetition:** `one or more of e`, `zero or more of e` and `optional e` repeat an element, and `n e` repeats it exactly `n` times, where `n` is an integer literal. For a plural keyword, `n` counts its singular, so `4 digits` is four `digit`, and `2 words` is two words separated by white space.
- **Anchors** match an empty position: `text start` and `text end` at either end of the text, `line start` at the start or after a line break, `line end` at the end or before a line break, and `word break` between a White_Space Character or either end and a Character that isn't White_Space.
- **Typed Elements:** `a number` is the only one ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)). `a` or `an` before any other kind is a load error.
- **`as number`** after an element converts its matched text to a number. It is allowed only after an element that can match nothing but ASCII digits, or after `a number`, so the text always has the number syntax. Anywhere else, `as` is a load error. Digits past the [number limits](03-values.md#reading-numbers) raise `can't convert`, as `a number` does.
- **`ignoring case`** after an element makes its text literals match by simple case folding. Classes keep their meaning.
- **`lazily`** after an element makes it prefer fewer Characters. It is an Advanced Construct ([chapter 2](02-grammar.md#advanced-constructs)).
- **Captures:** `name: e` records what `e` matched: its text, or its number with `a number` or `as number`. A Capture inside a repetition is a load error, and so are two Captures with one name.

### Matching

- **Priority:** a pattern can often match in several ways, and it takes the one it prefers most. An earlier element's choice counts before a later one's. `a or b` prefers `a`. A repetition, `optional` and a plural keyword prefer to match more, unless they are `lazily`, which prefers less.
- **A whole-text match** (`matches`, and a Text Pattern in Destructuring) takes the most preferred way of matching all of the text.
- **A search** (`contains`, `when contains`, the Match Search and `replace`) takes the match that starts leftmost, and the most preferred one there.
- **`begins with p`** is `true` when a match starts at the first Character, and **`ends with p`** when one ends at the last.
- **Whole Characters:** every element matches whole Characters, and every position is between two.
- **The subject** must be text, or `wrong kind` is raised with `expected` `"text"`.
- **Use-site `ignoring case`**, on `matches`, a search operator or a `match` subject, is the same as putting `ignoring case` on every text literal of the pattern, spliced ones included.
- **Limits and Fuel:** matching costs Fuel in proportion to the pattern's size and the text's length, and the pattern size limits are in [chapter 6](06-errors-and-limits.md).

### Matches

A Match is the plain map one match gives:

- **`text`**: the matched text.
- **`range`**: the integer range of its Characters, counted from 1. An empty match before Character `p` has the range `p..p-1`.
- **`captures`**: a map from each Capture's name, in the pattern's order, to its value, or to Nothing if it took no part.
- **`ranges`**: a map from each Capture's name to its range, or to Nothing.

`every match of p in s`, the Match Search, gives a list of Matches, left to right. Each search starts where the last match ended. An empty match where the last match ended is skipped, and the search goes on one Character later. Nothing holds a last match after `matches` or `contains`. Captures bind only through Destructuring or `replace` ([ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md)).

### `replace`

`replace p in c with e` finds the matches of the Text Pattern or text `p` in the text `c`, as the Match Search does. For each match, in order, the Captures written in `p` are put into locals of those names, and then `e` is evaluated. The result is `c` with each match replaced by the text form of its `e`. `replace first` replaces only the first match.

- **The statement** puts the result into the Container `c`. **The expression** gives it.
- **No match** leaves the text as it was.
- **A non-text `c`** raises `wrong kind` with `expected` `"text"`.

> **Example.**
>
> ```talk
> put "Smith, Ann" into names
> replace <last: word, ", ", first: word> in names with first & " " & last
> put replace <"-"> in "a-b-c" with "+" into plussed      -- "a+b+c"
> put every match of <digits> in "a1 b22 c333" into hits
> put the range of item 2 of hits into span              -- 5..6
> if "ID-0042" matches <"ID-", 4 digits> then say "an id"
> ```

## Destructuring

A pattern tests the shape of a value and binds its parts ([chapter 2](02-grammar.md#destructuring) has the syntax).

- **Order:** a pattern's tests run left to right, outer before inner, and stop at the first that fails.
- **All or nothing:** a pattern's names are bound only when the whole pattern matches, and its Guard, if it has one, is true. A failed test binds nothing.
- **Names:** a Name matches any value and binds it. The same Name twice in one pattern is a load error. `_` matches any value and binds nothing.
- **Literals** match a value `=` to them, so `5 kg` matches `5000 g` and `1` matches `1.0`.
- **List patterns** match a list with exactly as many elements, each matching in turn. A final `...rest` binds the elements left over as a list, and a final `...` ignores them. A rest anywhere but last is a load error.
- **Map patterns** match a map that has every listed key, whatever other keys it has. A missing key is a failure, even under `_`. `{name}` is short for `{name: name}`.
- **Text Patterns** match a text as a whole-text match, and bind its Captures. After `when contains`, they search instead.
- **Binary Patterns** match Bytes ([below](#binary-patterns)).
- **The pin** `^name` matches a value `=` to the variable `name` as it stands. It is an Advanced Construct.
- **`p as name`** binds the whole value that `p` matched.
- **The wrong kind** never raises: a list pattern given text, or a Text Pattern given a number, simply fails.
- **Errors while testing,** such as a splice that isn't a pattern or a matched number too large to convert, are treated like an error in a Guard: a clause or branch is skipped, and in `let`, a Lambda parameter or `repeat for each` the error is raised.

Where a failure goes depends on the pattern's place:

| Place | A failure |
| --- | --- |
| `let` | raises `no match` |
| a Lambda parameter | raises `no match` |
| `repeat for each` | raises `no match` |
| `match … when` | tries the next branch |
| a Handler head, `catch`, `wait for` | tries the next clause or branch ([chapters 5](05-handlers-messages-and-scheduling.md) and [6](06-errors-and-limits.md)) |

> **Example.**
>
> ```talk
> let [a, b, ...rest] be [10, 20, 30, 40]              -- rest is [30, 40]
> let {name: n, age} be {name: "Ann", age: 34, city: "Oslo"}
> match reading
>   when {kind: "wind", speed: s} where s > 30 km/hr then say "gusty"
>   when [x, y] then say x & "," & y
>   else say "something else"
> end match
> ```

## Binary Patterns

Bytes are matched and built by Binary Patterns, which read fields left to right and never search or backtrack ([ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md)).

### Matching Bytes

- **The value** must be Bytes, or the pattern fails.
- **Literal fields:** a number matches one byte of that value, and text matches its UTF-8 bytes.
- **Integer fields:** `n: uint16` reads 2 bytes as an unsigned integer, and `int8` to `int64` read two's-complement integers. They are big-endian, unless `little` follows, and `big` may be written. Each binds a number, and `_: uint32` skips its bytes.
- **Bit fields:** `n: 4 bits` reads an unsigned integer, most significant bit first. Their sizes are integer literals, and each run of bit fields in a row must add up to whole bytes, which is checked at load.
- **Byte fields:** `body: len bytes` binds that many bytes as Bytes. `as text` after it decodes them as `as text` does, and bytes that don't decode make the pattern fail.
- **Sizes** are an integer literal, a name bound earlier in the same pattern, a pinned variable `^n`, or a parenthesised arithmetic expression over those. A negative or non-integer size makes the pattern fail. A bare name that isn't bound earlier is a load error, which suggests `^n`.
- **The rest:** a final `...` ignores the bytes left over, and `...rest` binds them as Bytes, or as text with `as text`. A `...` anywhere but last is a load error. Without one, the fields must use up every byte.
- **Too short:** a field that needs more bytes than are left makes the pattern fail.

### Building Bytes

In operand position, `<< … >>` builds Bytes from its fields, in order:

- **A number** is one byte. It must be an integer from 0 to 255.
- **Text** is its UTF-8 bytes, and **Bytes** are copied in as they are.
- **`v as uint16`**, and the other integer types, write `v` in that many bytes, big-endian unless `little` follows, as for matching. **`v as n bits`** writes `v` in `n` bits, and each run of bit fields must add up to whole bytes.
- **`v as n bytes`** takes Bytes of exactly `n` bytes, and `v as n bytes as text` takes text whose UTF-8 is exactly `n` bytes.
- **Errors:** an integer too large or too small for its field raises `out of range`, with the field's type as `field`, such as `"uint16"`. A non-integer, or a Quantity, raises `wrong kind`. Any other value raises `wrong kind` too. Nothing ever wraps around.

> **Example.**
>
> ```talk
> put << 0x02, 7 as uint32, -3 as int16 little >> into packet
> match packet
>   when << 0x02, id: uint32, x: int16 little >> then say id & " at " & x
> end match
> put <<0x0D, 0x0A>> into crlf
> ```

## Containers

A Container is a variable, or a chain of chunks and keys rooted in one: `item 2 of totals`, `the age of person` ([chapter 2](02-grammar.md#statements) has the syntax).

- **The root** is a local or a Script Variable. A root that is a Constant is a load error. A Built-in Constant's name as a root makes a local that shadows it.
- **One store:** a write reads the root's value, builds the new value with the named part replaced, and stores it into the root once ([ADR 0001](../docs/adr/0001-value-semantics.md)). A write that fails leaves the root unchanged.
- **Order:** the value being put and the Container's indexes and keys are evaluated in source order.

### Writing chunks

- **A chunk of text** is replaced by the text form of the value, and the result is normalised to NFC. Writing a `word` replaces only its Characters, and keeps the white space around it.
- **Past the end:** writing an `item` or `line` past the end first pads the text with delimiters, or with `newline`, up to that index. Writing a `character` or `word` past the end raises `out of range`.
- **Index 0, a reversed range or an index before the start** raises `out of range` for every chunk kind, with the chunk word as `field` and the index, or `[from, to]`, as `value`.
- **An item of a list** is replaced by the value. Writing past the end pads the list with Nothing. A range of items is replaced by the elements of a list, and any other value there raises `wrong kind`.
- **A byte** is replaced by an integer from 0 to 255, and a range of bytes by Bytes. Writing past the end raises `out of range`.

### Writing keys

- **The value under a key** is replaced, keeping its place, or the key is added last.
- **Not a map:** writing a key of anything but a map raises `wrong kind` with `expected` `"map"`. That includes Nothing and a Host Object, whose properties are written only with `set`.

> **Example.**
>
> ```talk
> put "a,b,c" into row
> put "X" into item 2 of row                -- "a,X,c"
> put "e" into item 5 of row                -- "a,X,c,,e"
> put {name: "Ann"} into person
> put 35 into the age of person             -- {name: "Ann", age: 35}
> put [1, 2] into xs
> put 9 into item 4 of xs                   -- [1, 2, nothing, 9]
> ```

## Statements

### `put`, `let` and `set`

- **`put e into c`** puts the value of `e` into the Container `c`.
- **`put e after c`** and **`put e before c`**: if `c` holds a list, `e` becomes its last or first element, as one element. If `c` holds text, the text form of `e` is joined on, as `&` does. Anything else raises `wrong kind` with `expected` `"text"`.
- **`put ...e after c`** and **`before`** splice the elements of the list `e` into the list `c`. Either one not being a list raises `wrong kind` with `expected` `"list"`.
- **`let p be e`** matches `e` against the pattern `p` and binds its names, or raises `no match`.
- **`set c to e`** writes a property of a Host Object: the last step of `c` must be a key of a value that is a Host Object, or `wrong kind` is raised with `expected` `"object"`. The Host's `Set` runs ([chapter 9](09-embedding.md)). A read-only property is a load error where the object's kind is known at load, and otherwise raises `read only`. A disposed object raises `object gone`. `set` on a bare variable is a load error.

### Arithmetic statements

`add e to c`, `subtract e from c`, `multiply c by e` and `divide c by e` put `c + e`, `c - e`, `c * e` and `c / e` into `c`, with the Container's indexes and keys evaluated once. So after `put "1,2,3" into row`, `add 1 to item 2 of row` raises `wrong kind`, since a chunk of text is text.

### `delete`

- **A chunk of text** is removed. A `word` goes with the white space after it, or before it if it is the last word. A `line` or `item` goes with the delimiter after it, or before it if it is the last one.
- **An item of a list** or **a byte** is removed, and the rest move up.
- **A key** is removed from its map.
- **A chunk or key that isn't there** leaves the value as it was.
- **A bare variable** is set to Nothing.

### `if`

`if c then …` runs its first branch when `c` is `true`, and its `else` branch, if any, when `c` is `false`. `else if` chains test in order.

### `repeat`

- **`repeat for each p in e`** evaluates `e` once and walks a snapshot of it, so changing the variable inside the loop doesn't change the walk. `e` must be a list, whose elements are walked in order, or an integer range, whose integers are walked from its first end up to its second. A range whose ends aren't integers raises `wrong kind` with `expected` `"integer"`, and anything else with `expected` `"list"`. Each element is matched against `p`, and one that doesn't match raises `no match`.
- **`repeat while c`** tests `c` before each pass and stops when it is `false`. **`repeat until c`** tests `c` before each pass and stops when it is `true`.
- **`repeat forever`** runs until something leaves it.
- **`repeat e times`** evaluates `e` once. It must be an integer of 0 or more: a non-integer raises `wrong kind`, and a negative one `out of range` with `field` `"times"`.
- **`exit repeat`** leaves the innermost loop, and **`next repeat`** starts its next pass. Either outside a loop is a load error.

### `match`

`match e` evaluates `e` once, then tries each `when` branch in order. A branch is chosen when its pattern matches `e` and its Guard, if any, is `true`, and then its names are bound and its body runs. If no branch is chosen, the `else` body runs, and without an `else`, nothing does.

- **`when contains <p>`** searches `e`, which must be text for the branch to match, and binds the first match's Captures.
- **`ignoring case`** on the subject makes every text literal and Text Pattern in its branches match case-insensitively.

### `try` and `throw`

- **`try`** runs its body. If an error is raised in it, its `catch` clauses are tried in order, each a pattern with an optional Guard, and the first that matches runs with its names bound. If none matches, the error keeps unwinding. `finally` runs after the body or the `catch` clause, whether or not an error is still unwinding.
- **`throw e`** raises `e`. A map with a text `code` is raised as it is, with the Core adding `at` only if it is missing, so `throw e` rethrows with the original position. Text is short for `{code: e}`. Anything else raises `bad throw`.
- **A text literal** in a `catch` head is short for `{code: "…"}`.
- **What `catch` never sees:** Limit Faults, cancellation and Stop Script, which aren't errors. `finally`'s full rules, and which errors each operation raises, are in [chapter 6](06-errors-and-limits.md).

### `return`

`return e` ends the body with the value of `e`, and a bare `return` ends it with Nothing, as reaching `end` does. In a Handler, that value is the Handler's result, and the reply to a `send … and wait` ([chapter 5](05-handlers-messages-and-scheduling.md)).

### Calls as statements

- **A Command Call** `name args` calls a Handler of the Script, or else an imported one, in this Run, with the arguments evaluated left to right, and puts its result in `it`. With no such Handler, it is a `send` of the message along the Message Path, which doesn't wait ([chapter 5](05-handlers-messages-and-scheduling.md)).
- **A call statement** `f(x)` makes the call and puts its result in `it`.
- **`and wait`:** a Command Call to a Handler that may suspend must end in `and wait`, and one to a Handler that can't must not. Both are checked at load. `f(x) and wait` is allowed on any Function Value, since the loader can't know which one a variable holds ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).

### Capabilities

- **`ask g to op args`** calls the Operation `op` of the Grant `g`, with the arguments evaluated left to right, and puts its result in `it`. `and wait` must be written exactly when the Operation is declared suspending, and both are checked at load against the Grant ([ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md)).
- **`tell g to op args`** calls a fire-and-forget Operation, and drops its result. `tell` on any other Operation is a load error.
- **Grants, Shapes, costs and failures** are in [chapter 5](05-handlers-messages-and-scheduling.md) and [chapter 9](09-embedding.md). `say x` is short for `tell console to write x` ([chapter 12](12-sessions-and-tooling.md)).

### Messages and waiting

`send`, `wait`, `wait for`, the Join, `veto` and `pass` are in [chapter 5](05-handlers-messages-and-scheduling.md).

## Guards

A Guard is the `where` condition of a Handler Clause, a `match` branch, a `catch` clause or a `wait for` branch ([ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)).

- **When:** it is evaluated after its pattern matches, with the pattern's names bound.
- **What it may use:** literals, operators, conversions, Chunk Expressions, keys and Built-in properties, Text Patterns, Built-in functions and Built-in Constants. It may read the pattern's names, the body's locals, Script Variables and a Host Object's `id`, and compare Host Objects by identity.
- **What it may not use:** a call to anything but a Built-in, including a Script or Library function, a Handler and a Function Value, a Lambda, and a Host Object property other than `id`. Any of these is a load error. So a Guard never runs Script code, never calls the Host and never suspends.
- **Its result:** the clause is chosen only when the Guard gives `true`. `false` skips it. So does any other value and any error, which is never raised into the Run. `try`, `on error` and the Run's report don't see it, and the Trace records the skip.

> **Example.**
>
> ```talk
> try
>   add part as number to runningTotal
> catch {code: "can't convert", value: v} where the length of v < 20
>   tell log to write "skipping " & v
> end try
> ```

## Outside parity

_None._
