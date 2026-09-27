# SenseTalk: chunks, units, types and Pattern Language

Research for [#3](https://github.com/odogono/odgn-talk/issues/3). The question: what exactly are SenseTalk's Chunk Expressions, Units, value types and Pattern Language (our **Text Pattern**), and what traps would a Go/TypeScript reimplementation hit?

**Sources.** Everything comes from the official SenseTalk reference at `docs.eggplantsoftware.com/epf/` (doc version 26.3, pages last updated July 2026), plus the RE2 syntax doc for the Go comparison. Citations use short labels, listed in full under [Sources](#sources). Code samples are copied or lightly trimmed from those pages. `-->` shows the documented output.

---

## 1. Chunk Expressions

### Chunk kinds

| Kind | Delimited by | Notes |
|---|---|---|
| `character` / `char` | none | Includes invisible and control characters. [CT] |
| `word` | any run of whitespace (space, tab, return) | A quoted phrase counts as **one word, quotes included**. [CT] |
| `line` | any of CRLF, LF, CR, U+2028, U+2029 | A *list* of delimiter strings, tried in the order given. [CT][GP] |
| `text item` | `,` by default | A single delimiter string, which may be several characters long. [CT] |
| `list item` | none (structural) | Elements of a list value. [CT] |
| `item` | depends on the runtime value | Means list item if the value is a list or the `itemDelimiter` is empty; otherwise text item. [CT] |
| `byte` | none | Parts of binary data. [CT] |
| `occurrence` / `instance` | a Text Pattern | Returns the matched text. A range of occurrences returns a list. [CT] |
| `match` | a Text Pattern | Returns `{text:…, text_range:…}` plus capture groups. [CT] |

Property lists aren't chunked by ordinal. You reach into them with `x.key`, `x's key`, `property key of x`, `the key of x`, `x.(varKey)`, or a list of keys (`pitch's [e,d,c]`). `number of keys/values of x` counts their entries [PL][WC]. A **tree** (parsed XML) acts as both a list (its children are `item`s) and a property list (its attributes) [XML].

### Addressing forms [CS]

```
put word 4 of "Mary had a little lamb"            --> "little"
put item -2 of "apple,banana,pear,orange"         --> "pear"          -- negative counts from the end
get the third-to-last item of [9,12,13,42]        --> 12
put the penultimate word of "Peace is its own reward." --> "own"
put any item of "cow,ant,moose"                   -- random pick
put chars 3 to 5 of "dragon"                      --> "ago"
put chars 4..6 of "incredible"                    --> "red"           -- range value
put items middle to last of [1,2,3,4,5,6,7]       --> [4,5,6,7]
put the first 4 characters of "abracadabra"       --> "abra"
put words [4,1,2,-1] of "Mary had a little lamb"  --> [little,Mary,had,lamb]  -- a list of indexes always yields a list
```

* Ordinals can be numerals (`1st`, `2023rd`) or words (`first` … `millionth`). Counting from the end needs dashes, e.g. `second-to-last` or `fourth-from-end` [V].
* The special ordinals are `any`, `middle`/`mid`, `last`/`final`/`end`/`ultimate`, `penultimate`, `antepenultimate`, `preantepenultimate` and `propreantepenultimate` [CS].
* `of` and `in` are interchangeable, and chunks nest: `char 3 of last word of name` [CS][WC].
* Delimiters can be given inline: `item 3 delimited by "," of item 5 delimited by tab of line 18 of file x` [CT].
* A custom *word* delimiter is treated as a **set of characters**, and any run of them is one break. Custom *item* and *line* delimiters are exact strings:
  ```
  put each line delimited by ["<",">"] of "12><<>>A19><>X" --> ["12","","","","","A19","","","X"]
  put each word delimited by "<>"      of "12><<>>A19><>X" --> ["12","A19","X"]
  ```
  [CT]

### Delimiter properties [GP]

| Property | Default | Scope |
|---|---|---|
| `the itemDelimiter` / `defaultItemDelimiter` | `,` | Local to each handler, reset from the global when the handler starts |
| `the lineDelimiter` / `defaultLineDelimiter` | `[CRLF, Return, CarriageReturn, LineSeparator, ParagraphSeparator]`. Order matters (CRLF must come before CR). Setting it to empty restores the default. | Local to each handler |
| `the wordDelimiter` / `defaultWordDelimiter` | space, tab, return | Local to each handler |
| `the wordQuotes` / `defaultWordQuotes` | `"`. Can be a pair such as `("[[","]]")`, or `none` | Local to each handler |
| `the characterFiller` / `lineFiller` / `wordFiller` | `.` / `Return` / `?` | Global |

`the caseSensitive` is also handler-local and resets to `false` in every handler [E].

### Writing through chunks [WC]

Any chunk of a container is itself a container. You can `put … into / before / after` it, `delete` it, `add` to it, and so on.

```
put "Jack Peterson" into name
put "d" into char 3 of last word of name
put "e" into char -2 of name
put "Olaf" into first word of name        -- name = "Olaf Pedersen"
put "ugly" into words 2 to 5 of monster   -- a range write replaces the whole range
put "G" into chars [5,11,16,22,28] of monster        -- multi-chunk write
put ["Old","Ugly"] into words [5,2] of monster       -- values paired with indexes
put "$$$" into occurrences 2 to 3 of <"[", character, "]"> in text   -- writing through a Text Pattern
delete words 2 to 7 of ad
```

Writing **past the end** pads the value with filler:

```
put "saturn" into item 5 of "mercury,venus,mars"   --> "mercury,venus,mars,,saturn"   (uses itemDelimiter)
put "seven" into word 7 of "one two three"         --> "one two three ? ? ? seven"   (uses wordFiller)
put "z" into character 26 of "abcdefg"             --> "abcdefg..................z"  (uses characterFiller)
put "X" into character -7 of "abc"                 --> "X...abc"                     (negative indexes pad at the front)
```

Writing through a chunk can **change a value's type**, depending on which chunk word you use:

```
put 1 into myText;  put 2 into item 2 of myText       --> "1,2"   (text)
put 1 into myList;  put 2 into list item 2 of myList  --> [1,2]   (list)
```

`insert`/`push` always turns the target into a list. Inserting a list splices it `item by item` or `nested`, controlled by a keyword or by `the listInsertionMode`. `pop` and `pull` remove items from the end or the front [TDM][L].

Related queries: `number of words in x`, `x is among the words of y` (whole-chunk equality, unlike `contains`), `the word number containing "main" within text`, `number of occurrences of "be" among the words of s`, and `each word of s where each begins with "w"`. That last form maps an operator over every element, so `2 + each item of "1,2,5,6"` gives `[3,4,7,8]` [WC].

---

## 2. Units

### Syntax and catalogue [U]

```
put 3 ft                   --> "3 feet"
put 9 sq in                --> "9 square inches"
put 6 ft 3 in              --> "6.25 feet"        -- chained values of the same kind add up
set weight to 2 pounds and 3 ounces     --> "2.1875 pounds"
set speed to 25 mi/hr      --> "25 miles per hour"
set g to 32 ft/s^2
set price to $5.96 per lb  -- "$" is the one prefix unit
put 3..7 m/s               --> 3 meters per second to 7 meters per second   -- one unit covers both ends
put 4 cm is between 1 and 3 inches   --> True
```

* Unit names can be singular, plural or abbreviated. `square`/`sq` and `cubic` build area and volume. Abbreviations take no trailing period. Numbers can also be words: `four grams` [U][V].
* `unitTypes("standard")` returns the standard kinds: length, mass, byteSize, duration, calendarDuration, rotation, electric_charge, area, volume, electric_current, force, pressure, stress, energy, power, electric_potential, electric_resistance, resistance, electric_conductance, conductance, electric_capacitance, magnetic_flux, inductance, magnetic_flux_density, frequency, velocity, acceleration, flow, angular_velocity, temperature_difference and currency [U].
  * Synonyms for these (distance, weight, speed, …) appear in `unitTypes()` [UT].
  * There is **temperature_difference but no absolute temperature**, so the catalogue never needs an affine (offset) conversion.
  * `unitNames("speed")` returns `["knot","mph","mps","kph","knots"]` [U].
* **Calendar durations** (month, quarter, calendar year, decade, century) are a separate kind from exact time intervals and don't convert into them. `Jan 31 + 1 month` gives `Feb 28/29`, controlled by `the lastDayOfMonthCalculation` [V].

### Arithmetic and conversion [U]

| Operation | Rule | Example |
|---|---|---|
| `+` `-` and comparison | The kinds must match. The result unit is picked by an **internal ordering** of units, not by operand order. | `8 inches + 3 cm` gives `23.32 centimeters`, and so does `3 cm + 8 inches` |
| unit ± plain number | **Error** while `strictUnits` is true (the default) | `7 ft + 3` throws |
| × or ÷ by a plain number | Keeps the unit | `10 hours / 2` gives `5 hours` |
| ÷ compatible units | Converts, then **drops** the units | `4 yards / 2 feet` gives `6` |
| × any units, or ÷ incompatible | Builds a **compound unit** | `4 yard * 2 feet` gives `24 square feet`. `500 miles / 4 hours` gives `125 miles per hour`. `2 liters * 2 liters` gives `4 liters^2` |
| incompatible kinds | Throws a mismatched-units exception | `add 2 liters to area` throws. `average(4 in, 5 ft, 1 pint)` throws |
| lists | Applied item by item when the lengths match | `[4 oz, 2 g] + [4 oz, 2 g]` gives `[8 ounces, 4 grams]` |

* **Explicit conversion** uses `x as inches` or `convert depth to fathoms`. `as` binds tighter than `+`, so write `(a + b) as yards` [U].
* **`x's units`** reads or sets the unit label **without converting**. `if radius.units is empty then set units of radius to "meters"` is the documented idiom for a default unit [U].
* **Type test:** `if mySize is not a length …`. `unitType(765 ft)` returns `length` [U].
* **Global switches:**
  * `the unitsEnabled`, default true. When off, only duration and byte-size units are kept, for backwards compatibility [U].
  * `the strictUnits`, default true. When off, a plain number takes on the other operand's unit (`7 ft + 3` gives `10 feet`), and a mismatch silently **drops** the units (`3 ft + 4 gallons` gives `7`) [U].

### Printing and parsing

* By default a value prints as the number followed by the full unit name, pluralised: `1 mm` prints as `1 millimeter` [UF].
* The number part follows `the numberFormat` (default `0.######`), so display is rounded to 6 decimal places: `9.181102 inches` [GV][U].
* **Unit formats** are small templates: `put 483 secs format "[min] minutes [s] seconds"` prints `8 minutes 3 seconds` [UF].
  * Tokens are filled left to right with whole units. Only the last token can carry a fraction (`[seconds .###]`).
  * `@` stands for the correctly pluralised unit name, and `*` sets the default number format for the tokens that follow.
* `the unitFormats` sets a format per unit kind (`set the unitFormats.duration to "[hours 00]:[minutes 00]:[seconds 00]"`, after which `5432 sec` prints `01:30:32`). `splitUnits(4288.321 seconds, "hrs","mins","secs")` returns `[1 hour, 11 minutes, 28.321 seconds]` [U].
* **Parsing from text:** a literal `"5 pounds 3 ounces"` inside a list stays a string, while the bare expression `5 pounds 3 ounces` becomes `5.1875 pounds` [L]. The docs don't say whether text like `"3 ft"` gets unit-parsed when it's used as a number. **Undocumented.**

---

## 3. Value types and coercion

### SenseTalk calls itself *typeless*

The ticket says SenseTalk has "strong data types". The official docs say the opposite:

* "SenseTalk is a *typeless* language. That is, all values can be treated as text" [CV].
* "The existence of the `as` operator does not imply that SenseTalk is a 'typed' language. In fact, it is an 'untyped' language" [MO].

A value does carry an **internal representation**, one of: text, number (optionally with a unit), list, property list/object, range, date/time, color, binary data, tree, pattern, reference, iterator, or `missing value`/`nil`/`null`. Operators convert between these on demand [CV][V][MO]. What the ticket calls strength is really **opt-in strictness flags**:

* `the strictUnits`, default true [U]
* `the strictProperties`: reading an unset property throws instead of returning empty. Default false [PL]
* `the booleanComparison`: `Normal`, `Strict` or `Lenient` [GV]

### Coercion rules [CV][MO][V][E][GV]

* **Numeric operators** read their operands as numbers. **`&`** reads them as text. A number becomes text through the *current handler's* `numberFormat`, which makes `((1 + 2) & 4) + 5` give 39, 309, 3009 or an error depending on the format [CV].
* **Comparison:** `"007" is equal to "7.0"` is **true**, because both look numeric and are compared as numbers. `… as text` makes it false. Text comparison ignores case by default [MO][E].
* **Dates are not inferred for comparison.** Two strings that could both parse as dates still compare as text unless both sides are `as date` [MO]. Arithmetic *does* try to read a string as a date. Text-to-date parsing tries each format in `the timeInputFormat` in turn. A bare number is taken as seconds since 2001-01-01 [GV].
* **Booleans:** `true`/`yes`/`on` count as true, and `false`/`no`/`off`/empty count as false, in any case. Any other value throws when a boolean is needed [V].
* **`is a` checks two different things.** For `number`, `integer`, `date`, `boolean` and `point` it asks whether the value *could* convert. For `list`, `range`, `tree` and `object` it checks the *current representation* [MO].
  * So `"A man, a plan" is a list` is false, while `number of items` still counts its text items.
  * `as a list` turns the whole string into a one-item list. It does not split on commas [L].
* **A one-item list acts like a scalar:** `[4] + 2` gives `6` [L].
* **`as list`, `as object` and `as tree` evaluate text.** "They will evaluate that value's text as an expression (in the same manner as the `value()` function)". `as tree` parses the text as XML [MO].
* **Objects can override conversion** by defining `asText`, `asNumber`, … handlers or `asListExpression` properties [MO].
* **Printing lists:** they print through `the listFormat`, `[1,2]` by default. Text representations are capped by `the asTextLimit`, default 10,000,000 characters [GV].

---

## 4. Pattern Language (Text Patterns)

### Syntax [PB][PE]

A pattern is written `{pattern} < element, element … >`. Elements are separated by commas, `then` or newlines. `or` gives alternation and `( … )` groups.

```
set ssn to <3 digits then "-", 2 digits then "-", 4 digits>
set zipcode to <5 digits then preferably ("-", 4 digits)>
<"cat" or ("cow" then 2 digits)>
set phoneNumber to <maybe areaCode then localNumber>   -- patterns stored in variables compose
set datePattern to <1 or 2 digits, "-", month, "-", (the year - 1)>   -- variables and (expressions) are spliced in
pattern "\d{5}(?:-\d{4})?"                              -- raw ICU regex escape hatch
```

**Elements** [PE]:
* quoted string, variable, or `(expression)`
* `character(s)`, `letter(s)`, `digit(s)`, `uppercase`/`lowercase letter(s)`, `letterOrDigit`/`alphanumeric`, `whitespace character(s)`, `word character(s)`, `punctuation character(s)`
* the negation of each (`nondigit`, …)
* `char in "ABC"`, `char not in …`. A character set can be a string, a range, a class, or a list of these.

A singular element matches exactly one; the plural matches one or more.

### Quantifiers [PE]

**Lazy by default**, the opposite of most regex dialects.

| Meaning | Lazy (default) | Greedy |
|---|---|---|
| exactly 1 | `a character`, `one character` | n/a |
| exactly n | `2 characters`. With a variable you must write `exactly n characters` | n/a |
| 0 or 1 | `maybe a character` | `preferably a character` |
| 1 or more | `characters`, `some characters`, `one or more characters` | `lots of characters`, `one or preferably more characters` |
| 0 or more | `maybe characters`, `zero or more characters` | `preferably characters`, `maybe lots of characters` |
| at least n | `at least 2 characters`, `2 or more characters` | `2 or preferably more characters` |
| n to m | `2 to 4 characters` | `2 to 4 characters greedily` |

`greedily` and `lazily` override any term. The greedy synonyms are `lots`, `lots of`, `many`, `max`, `maximum`, `the maximum number of` and `the most` [PE].

### Anchors and lookaround [PA]

* **Anchors that match text:** `word starting with "c"`, `"t" at the end of the word`, `line starting with …`, `text ending with …`.
* **Zero-width anchors:** `word break`, `start of word`, `word end`, `line start`, `line end`, `text start`, `text end`.
* **Lookaround:** `preceded by`, `not preceded by`, `followed by`, `not followed by`, as prefixes or suffixes: `<some characters preceded by "(" followed by ")">`.
  * A **`preceded by` pattern must have bounded length** (`3 to 5 digits` is fine, `some characters` is not).
* **Case:** `case sensitive` / `case insensitive` inside the pattern, applied to the rest of it, to one element, or to one sub-pattern. This overrides the operator option and `the caseSensitive` [PE].

### Named captures and back-references [PC]

```
set parenPattern to <"(" then {content: some characters} then ")">
put the match of parenPattern in "John Jacob (Jingleheimer) Smith"
--> {content:"Jingleheimer", content_range:13 to 24, text:"(Jingleheimer)", text_range:12 to 25}

set doubleWord to <word break, {word: word chars}, nonword chars, {:word}, word break>   -- {:name} is a back-reference
set doubleWord to <word break, {word chars}, nonword chars, {1}, word break>           -- unnamed groups: Group_1…, {1}
replace <line start, {last: chars}, ", ", {first: chars}, line end> in names with "{:first} {:last}"
```

* `{name: sub}` captures and `{:name}` refers back to it.
* The same name can appear in two `or` branches. A group from an alternative that didn't match is **left out** of the result.
* `text` is reserved: never use it as a group name [PC][PF].

### How patterns are used [UP][PF][TO][WC][TDM]

* **`p matches s`:** true if the pattern can match the **whole** string. Lazy quantifiers still let it match in full, so `<"$", digits> matches "$895"` is true even though `the occurrence of <"$", digits> in "$895"` returns `"$8"` [UP].
* **`match` / `every match`** (and `match(p, s, pos, caseSensitive, before)`) return property lists of `text`, `text_range`, `<group>` and `<group>_range`. `after position n` and `before position n` limit the search [PF].
* **`occurrence` / `every occurrence`** (synonym `instance`) return the matched text [PF].
* Patterns work anywhere a search string works:
  * `contains`, `is in`, `begins with`, `ends with`
  * `offset`, `range`, `every offset`
  * `replace`, `delete`, `split … by <pattern>`
  * `number of occurrences of <digit> in s`
  * chunk reads and writes (`occurrence 2 of p in s`, `put x into matches 1 to 3 of p in s`) [UP][CT][WC]

### Mapping to regex [PB][GV]

The docs say the Pattern Language is "built on top of regular expressions" and runs on the **ICU regex engine**, which raw `pattern "…"` strings also use [PB][PE]. The page states no formal translation, but the parts line up with regex like this:

| Pattern Language | Regex | Source |
|---|---|---|
| literal | escaped literal | |
| `digit` | `\d` | |
| `word break` | `\b` | |
| `line start` | `^` in multi-line mode | |
| `maybe x` | `x??` | |
| `x` (plural) | `x+?` | |
| `lots of x` | `x+` | |
| `{n: …}` | `(?<n>…)` | |
| `{:n}` | `\k<n>` | |
| `preceded by` | `(?<=…)` | the bounded-length rule is ICU's lookbehind rule |
| `case sensitive:` | `(?-i:…)` | |

Some global properties change how patterns behave:

* `the patternCharacterMode` (`Text`/`Line`): whether `characters` crosses line breaks.
* `the matchesCanOverlap` (default false).
* `the patternTimeout`: **30 seconds of wall-clock time** per search, then an exception [GV].

---

## 5. Implementation traps / implications for our language

### Grammar and ambiguity

1. **`<` means four things.** In SenseTalk, `<` can be less-than, a Text Pattern `<…>`, a hex **binary literal** `<3f924618>` [V][CT], or the start of `<<…>>` text. Our sketch uses `<…>` for Text Patterns, so we must either drop binary literals or tell them apart by lexical context, *not* by guessing from the content.
2. **Unit names clash with keywords.** `in` (inches, and also the chunk/`is in` keyword), `min`, `s`, `m`, `g`, `ft`, `hr` and `$` are all units. `put 9 sq in` and `6 ft 3 in` parse only because the parser knows unit names [U]. Decide early whether unit suffixes are a closed, lexer-level set, whether they need a marker (e.g. `5'kg`, `5 kg` only directly after a numeral), or whether they're a Host-extensible table. The last option means the grammar depends on configuration, which hurts LSP and formatter tooling.
3. **Number words** (`six hundred thirty-four`, `four grams`) and **ordinal words up to `millionth`** [V] add a lot of lexer surface for little gain. Pick a small closed set.
4. **`item` means different things at runtime.** `item` is a list item or a text item depending on the *value* at runtime [CT], and `put 2 into item 2 of x` builds either `"1,2"` or `[1,2]`. This defeats static analysis. Consider making `item` strictly structural and `field`/`text item` strictly textual.
5. **Chained units and `and`:** `2 pounds and 3 ounces` reuses the logical `and` [U]. Restrict chained units to adjacent numeral–unit pairs.
6. **Braces are already taken.** SenseTalk uses `{name: sub}` for captures [PC]. Our sketch writes captures bare, as `num: 4 digits`, and uses `{…}` for map **Destructuring**. That's consistent, but we must say so explicitly and handle `name:` inside `<…>` in the grammar. Note too that SenseTalk has no bare `word` element; it uses `word chars` together with anchors [PE][PA].

### Semantics to decide deliberately

7. **Hidden dynamic state.** `itemDelimiter`, `lineDelimiter`, `wordDelimiter`, `wordQuotes`, `numberFormat` and `caseSensitive` are **handler-local but seeded from mutable globals**. Fillers, `strictUnits` and `matchesCanOverlap` are global [GP][GV][U]. So the same expression can give different results depending on who set what, as in the `((1+2)&4)+5` example [CV]. Prefer explicit arguments (`item 2 delimited by tab of x`, `x as text using "0.00"`) and make any defaults immutable per Script. Under multi-tenancy, these must never live in process-wide state.
8. **Implicit number↔text round-trips lose precision.** Display rounds to 6 decimal places by default [GV], and `&` forces text [CV]. Keep numbers numeric. Use exact decimal or rational arithmetic, or at least make number-to-text conversion canonical and independent of locale.
9. **"Looks numeric" comparison.** `"007" = "7.0"` being true [MO] is a classic HyperTalk behaviour that surprises experienced users. Decide whether our `=` compares by representation, with an explicit numeric compare.
10. **Pick a result unit rule.** In SenseTalk, the result unit of `+` comes from "internal ordering" [U], which is undocumented. Specify one: for example, the left operand's unit, or the unit named in an explicit `as`. Also decide how *equality* works across units given floating-point conversion (`1 in = 2.54 cm`).
11. **Unit catalogue scope.** SenseTalk leaves out absolute temperature and keeps calendar durations as a separate kind [U][V]. That's a good model to copy. Dimensional-analysis units (compound `mi/hr`, `^2`) need a canonical normal form for printing and equality. Currency with no exchange rates should be a "same currency only" kind.
12. **Writing past the end is a memory bomb.** `put "z" into character 1000000000 of x` pads with filler [WC]. Growth through chunk writes, `repeated`, list padding (`item 7 of pets` pads with empties) and text conversion must all go through the Script's memory meter. SenseTalk's only guard is a global 10M-character `asTextLimit` [GV].
13. **Sandbox leaks inside "value" features:**
    * `as list`/`as object` **evaluate text as code** via `value()` [MO], so data becomes code. Our version should parse literals only (JSON-like), never evaluate.
    * `is a file`/`is a folder` touch the filesystem [MO]. `url … as tree` touches the network [XML]. `today`/`now` read the clock [V]. `any` uses randomness [CS].
    * Each of these must be a Capability or a seeded, deterministic source.
14. **Case-insensitivity and Unicode.** Case-insensitive comparison by default [E] needs a defined case-folding rule, not the Host's locale; Turkish dotless i is the classic example. SenseTalk inherits Cocoa/ICU behaviour [V][PB]. The docs never say what a `character` is (UTF-16 unit, code point or grapheme). Go strings are UTF-8 bytes and JS strings are UTF-16, so we must define **character = grapheme cluster** or **code point** ourselves and specify index semantics (including `text_range`), or Go and TS results will differ.
15. **Line and word definitions.** SenseTalk's default line delimiters include U+2028/U+2029, tried in order with CRLF first [GP]. Words are split on ASCII whitespace but a `"…"` quoted phrase is one word [CT]. Both are cheap to copy exactly. Leave word quoting out or make it opt-in, because it surprises people.
16. **Date and locale inference.** Implicit date parsing goes through a configurable list of formats, including a "Natural" format, and reads bare numbers as seconds since 2001 [GV]. Locale-dependent parsing breaks cross-host parity, so require explicit `as date` with ISO 8601 as the only implicit format.

### Text Pattern engine

17. **Go's `regexp` can't run the full Pattern Language.** RE2 does not support back-references or any lookaround [RE2]. SenseTalk needs both (`{:name}`, `preceded by`) [PC][PA]. JS `RegExp` supports them, but it is a backtracking engine with no step metering, so a hostile pattern can pin a CPU. SenseTalk's only defence is a **30-second wall-clock `patternTimeout`** [GV], which fails our deterministic-budget rule. **Implication:** Text Patterns should compile to **our own IR and run on our own matcher in both Go and TS**. That could be a Pike VM or a metered backtracker, charging fuel per step. Don't delegate to a host regex engine. An alternative is to leave back-references and lookaround out of the beginner layer.
18. **Raw regex escape hatch.** `pattern "…"` exposes ICU syntax [PB]. If we offer one, it must be a documented subset that our engine implements identically on both hosts, and never "whatever the host supports".
19. **Lazy by default.** Lazy quantifiers are the default and `matches` means "can match the whole string" [PE][UP]. Keep both, since they are the friendlier reading, but spec them precisely, including overlap (`matchesCanOverlap`) and the default `patternCharacterMode`.
20. **Match results are property lists.** They hold `text`, `text_range`, `name` and `name_range`, and omit groups that didn't take part [PF][PC]. This lines up with our Destructuring: a `match … when <…>` branch can bind captures straight to names. Decide what an unmatched optional group binds to (nothing, or `empty`), because Destructuring and Guards will need it.

---

## Sources

All pages are at `https://docs.eggplantsoftware.com/epf/<slug>/` (SenseTalk reference, v26.3).

* [CT] Chunk Types: `stk-chunk-types`
* [CS] Chunk Syntax: `stk-chunk-syntax`
* [WC] Working with Chunks: `stk-working-with-chunks`
* [GP] Local and Global Properties for Chunk Expressions: `stk-global-properties-chunk-expressions`
* [U] Using Numbers with Units: `stk-using-numbers-with-units`
* [UF] Unit Formats: `stk-using-unit-formats`
* [UT] `unitTypes` (dictionary entry): `dict_unitTypes`
* [V] Values in SenseTalk: `stk-values`
* [E] Expressions: `stk-expressions`
* [CV] Conversion of Values: `stk-conversion-of-values`
* [MO] Miscellaneous Operators (`is a`, `as`): `stk-miscellaneous-operators`
* [GV] Local and Global Properties for Working with Values: `stk-global-properties-values`
* [L] Lists: `stk-lists`
* [PL] Property Lists: `stk-property-lists`
* [TDM] Text and Data Manipulation (`delete`, `insert`, `replace`): `stk-text-data-manipulation`
* [XML] Using XML and Tree Structures: `stk-using-xml-tree-structures`
* [PB] SenseTalk Pattern Language Basics: `stk-pattern-language`
* [PE] Elements of the SenseTalk Pattern Language: `stk-elements-pattern-matching`
* [PA] Anchors with SenseTalk's Pattern Language: `stk-anchored-elements-patterns`
* [PC] Using Capture Groups with Pattern Definitions: `stk-pattern-capture-groups`
* [UP] Using Patterns in SenseTalk: `stk-using-pattern-language`
* [PF] Pattern Matching Functions: `stk-pattern-matching-functions`
* [TO] Text Operators: `stk-text-operators`
* [RE2] RE2 syntax (Go `regexp`): https://github.com/google/re2/blob/main/doc/syntax.txt. Lookaround and `\1`/`\k` back-references are marked "NOT SUPPORTED". See also https://pkg.go.dev/regexp (linear-time guarantee).
