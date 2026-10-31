# The Standard Library

Everything a Script can call without its Host writing it comes in three parts:
the Built-ins, the seven stdlib Libraries and the Standard Capabilities. This
page says how each is reached. Each part's reference pages list every function
and Operation, and [chapter 7](../spec/07-libraries-and-the-standard-library.md)
of the Specification holds the full rules.

## Built-ins

A Built-in is always there: a Script calls it with no `use`. Built-ins are the
functions that need the Core itself, such as Unicode tables or a value's
representation, and the only functions a Guard may call.

```talk
on bitsAndNumbers x
  put round(2.345, 2, "half even") into cents      -- 2.34
  put upper("straße") into shout                   -- "STRASSE"
  put max(6, 3, 9) into biggest                    -- 9
  put bitAnd(12, 10) into eight                    -- 8
  put kindOf(x) into kind                          -- "number", "text", …
  put the length of "hello" into five              -- a Built-in property
end bitsAndNumbers
```

A Script's own variable or function may take a Built-in's name, and then the
Script's name wins inside it.

Reference: [Built-ins](stdlib/built-ins.md), grouped as values, numbers, bits,
floats, dates and constants, with the Built-in properties.

## Libraries

The seven stdlib Libraries are written in NorthTalk itself, and every Group
holds them. A Script imports the names it uses, and only those:

```talk
use pad, split from text
use trim from text as tidy                         -- renamed as it comes in

on tidyUp line
  put split(tidy(line), ",") into parts
  put pad(item 1 of parts, 8) into label           -- "a       " for " a,b "
end tidyUp
```

Their names are reserved, so a Host can't register a Library called `text`.

Reference: [`text`](stdlib/libraries/text.md), [`list`](stdlib/libraries/list.md),
[`map`](stdlib/libraries/map.md), [`bytes`](stdlib/libraries/bytes.md),
[`json`](stdlib/libraries/json.md), [`date`](stdlib/libraries/date.md) and
[`units`](stdlib/libraries/units.md).

## Standard Capabilities

A Script has no ambient I/O. The time, the calendar, a Store and the console
are Standard Capabilities: the Host grants them, and the Script calls their
Operations with `ask` for an answer or `tell` for none. A suspending Operation
says `and wait`.

```talk
on note key
  ask clock to now                                 -- the answer lands in `it`
  put it into started
  ask store to get key
  tell console to write "seen " & key
  ask console to read and wait                     -- suspends for a line
end note
```

A call the Script's Grants don't allow fails to load, so a missing Capability
is found before anything runs. `sqlite`, `user` and `http` are optional: a Host
may not offer them.

Reference: [`clock`](stdlib/capabilities/clock.md),
[`calendar`](stdlib/capabilities/calendar.md),
[`locale`](stdlib/capabilities/locale.md),
[`timer`](stdlib/capabilities/timer.md),
[`console`](stdlib/capabilities/console.md),
[`store`](stdlib/capabilities/store.md),
[`sqlite`](stdlib/capabilities/sqlite.md),
[`user`](stdlib/capabilities/user.md) and
[`http`](stdlib/capabilities/http.md).

## Errors

A stdlib function checks its arguments before it does any work:

- **`wrong kind`**: an argument of the wrong kind, such as text where a number
  belongs. Every function and Operation can raise it, so the reference pages
  don't list it.
- **`out of domain`**: the right kind, but a value the function can't take,
  such as `bitNot(256, 8)`. Its `function` field names the function and its
  `value` field the argument.

An error is a map with a text `code`, caught like any other:

```talk
on safeShift x
  try
    return bitShiftLeft(x, 1)
  catch {code: "overflow"}
    return 0
  end try
end safeShift
```

The [error-code catalogue](../spec/06-errors-and-limits.md#the-error-code-catalogue)
lists every code and its fields.
