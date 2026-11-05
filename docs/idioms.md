# Common idioms

> Short answers to "how do I…" while writing a Script. Each one shows the shortest way the language already offers, with a link to the rule in [the spec](../spec/). Read [the tour](tour.md) first for the language as a whole.

Each example is a set of statements from a Handler body. A `-->` comment shows what the line before it says. A test runs every example on this page through `bun run northtalk`.

## Read a key that may be missing

Use `the optional k of x`, and `otherwise` for a default. An optional read gives Nothing for a missing key, or when `x` is itself Nothing, so there's no need to test `is not nothing` first. An ordinary read of a key on Nothing raises `wrong kind`.

```talk
put {name: "Ann"} into customer
say the optional city of customer otherwise "unknown"
--> unknown
say the optional city of the optional address of customer otherwise "unknown"
--> unknown
```

An optional read works the same on a Host Object, such as an entity whose components are properties: `the optional lockable of actor otherwise "none"` gives `"none"` when its Object Kind doesn't define `lockable`. So one spelling reads a key whether the Host models a thing as a map or as an object.

`otherwise` replaces only Nothing. False, `0` and `""` are kept. See [Nothing defaults](../spec/04-expressions-and-statements.md#nothing-defaults) and [optional key reads](../spec/04-expressions-and-statements.md#optional-key-reads).

## Write a computed key

To write to a key held in a variable, put the key expression in parentheses: `put v into the (k) of m`. Missing keys are added, so the map needs no `withPath`.

```talk
put {} into scores
put "red" into team
put 3 into the (team) of scores
add 2 to the (team) of scores
say scores
--> {red: 5}
```

See [keys and properties](../spec/04-expressions-and-statements.md#keys-and-properties) and [writing keys](../spec/04-expressions-and-statements.md#writing-keys).

## Fill a template

`replace p in c with e` runs `e` once per match, with the pattern's Captures bound. A template fill is one statement.

```talk
put {name: "Ann", place: "the docks"} into fields
put "Meet {name} at {place}." into note
replace <"{", slot: letters, "}"> in note with the (slot) of fields
say note
--> Meet Ann at the docks.
```

As an expression, `replace` gives the new text and leaves the original as it was. See [`replace`](../spec/04-expressions-and-statements.md#replace).

## Take the rest of a text

Negative indexes count from the end, so `-1` is the last chunk and `2..-1` is everything after the first. This works for every chunk kind.

```talk
say characters 2..-1 of "hello"
--> ello
say items 2..-1 of [10, 20, 30]
--> [20, 30]
say words -2..-1 of "one two three"
--> two three
```

Don't guard a range against running past the end. A range is clipped to the chunks there are, and a range whose start comes after its end gives empty text or an empty list.

```talk
put "hi" into t
say characters 3..-1 of t is empty
--> true
say characters 2..10 of t
--> i
```

There is no open-ended `2..` form. `2..-1` already says it, and every Core runs it ([#2090](https://github.com/odogono/odgn-talk/issues/2090)). See [reading chunks](../spec/04-expressions-and-statements.md#reading).

## Keep an answer

A later `ask` overwrites `it`. To keep an answer, name a Result Target with `into`. The answer goes into that name as well as into `it`.

```talk
ask clock to now into started
ask locale to compare "b", "a"
say started is not nothing
--> true
say it
--> 1
```

Result Targets also follow Command Calls, call statements and `send … and wait`. See [Result Targets](../spec/04-expressions-and-statements.md#result-targets).
