# A range's ends are read with two Built-ins

`rangeStart(r)` gives a range's first end, and `rangeEnd(r)` its second, exactly as written, for every range: integer, reversed or Quantity. So `rangeStart(5..4)` is `5` and `rangeEnd(3 m/s..7 m/s)` is `7 m/s`. They are Built-ins, so a Guard may call them. We chose this because nothing else could read a range's ends. An integer range reads like the list of its integers, counting up (ADR 0034), so the empty range `p..p-1` of an empty match has no items, and a Script couldn't tell where the match was. A Quantity range has no list reading at all. The `text` Library's `lastOffset` had to recover the start by printing the range and cutting the text at `..`. Settled while writing the stdlib source (#103).

## Considered Options

- **Letting `item 1 of (5..4)` be `5`:** a range would then have length 0 but a first item. Making reversed ranges count down instead (`5, 4`) would make `1..0` walk twice, which breaks the `1..(the length of xs)` idiom for an empty list, the off-by-one trap that ascending-only ranges avoid.
- **Built-in properties, such as `the start of r`:** they read better, but a Built-in property always wins over a map key (ADR 0019), so `the start of m` could no longer read a map's `start` key.
- **A Destructuring pattern, `let a..b be r`:** neat, but it is new grammar, and it would need its own check that the grammar stays within two tokens of lookahead.
- **A `start` field on every Match:** it would fix matches and Captures only, and leave Quantity ranges unreadable.

## Consequences

- **Built-ins:** narrows ADR 0021. `rangeStart` and `rangeEnd` join the value Built-ins. They take a range, and anything else raises `wrong kind`.
- **Unchanged:** a range's list reading, `is in`, `repeat for each` and its chunks stay as ADR 0034 and chapter 3 state them.
- **Names:** both names are new stdlib names, unique across the Built-ins and the seven Libraries, and a Script's own names may shadow them (ADR 0034).
- **The stdlib:** `text` reads a match's start with `rangeStart(the range of m)`.
