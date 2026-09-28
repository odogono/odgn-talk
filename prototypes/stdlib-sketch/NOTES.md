# Stdlib sketch

Throwaway Scripts written against the stdlib outline in ADR 0021 (issue #42). They show call shapes and where each name lives. They don't pin any function's contents.

- `report.talk`: the syntax sketch's `summarise`, using `list` and `text`. `the average of` becomes `average(…)` from `list`, `the max of` becomes the Built-in `max(…)`, and grouping waits for the `grouped by` follow-up.
- `json.talk`: `decodeJson`/`encodeJson`, `null` as Nothing, and converting kinds that have no JSON form.
- `sensor.talk`: a Binary Pattern whose float32 field is read with the Built-in `fromFloat32`, plus `toHex` from `bytes`.
- `guards.talk`: Built-ins in Guards, why a Library function can't be in one, and Script functions called only as `f(x)`.

## What writing them showed

- `max` is ambient but `average` needs a `use` line. A reader can't tell them apart at the call site. That's the price of keeping Built-ins to what Guards and the Cores' internals need.
- Two names had to change to stay out of existing syntax. `character(n)` would read as the chunk `character (n) of s`, so it is `fromCodePoint(n)`. `repeat` is a Reserved Word, so `text`'s repeat is `repeated(s, n)`.
- The draft `grammar.toml` on `prototype/parser-sketch` still lists `json`, `average`, `max`, `min` and `sum` as built-in properties. ADR 0021 drops them from that list.

## Open

- Should Quantities have a JSON form, or must a Script always convert first?
- The `grouped by` clause and a join over concurrent Runs are follow-up tickets.
