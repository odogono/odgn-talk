# Notes: what felt right, what felt wrong

Throwaway notes from writing the sketches in this folder. The lines tagged `??` in each file have the detail; this is the digest.

## Felt right

- **The reference flavour holds up.** Handler Clauses with Destructuring heads plus `where` Guards read well, with or without Text Patterns in the head (`on handle {ref: <"INV-", n: digits as number>}`). Captures and Destructuring names binding side by side in one clause felt natural.
- **`&` converting to text** removes nearly all the noise that strict typing would otherwise add to output code (`"Visit number " & visits`).
- **Typed Elements** (`qty: a number`, `d: a date`) are the nicest way to get typed data out of text, and they make `as number` rare in parsing code.
- **`as` as the single conversion word**, including units (`speed as km/hr`, `3 as kg`). It keeps `in` free for its preposition jobs.
- **`… ignoring case` as a trailing modifier** reads well on `is`, `contains`, `begins with`, `matches`, `match` and `offset`.
- **`the last character` and `character -1`** sit happily together: one for reading, one for computed positions.
- **`wait for` as a block**, mirroring `match` with an `after <duration>` branch, makes it obvious which branch fired. It beats both `if it is nothing` and `if the wait timed out`.
- **`can be a number`** says "conversion" out loud, generalises (`can be a date`, `can be kg`), and doesn't look like `is a`.
- **`let [a, b] be the items of l delimited by ";"`** keeps the `delimited by` noise in one line per loop, so losing `itemDelimiter` hurt less than expected.
- **Date literals with a lead word:** `date 2026-09-27`, `date 2026-09-27 at 14:30`, `instant 2026-09-28T09:00:00Z`.

## Felt wrong or ambiguous

1. **`it` is overloaded.** It means the whole message argument in a clause, the reply to `send … and wait`, the result of `ask`, and the event from `wait for`. Candidate: `it` for results only, and `as name` to bind the whole argument (`on handle {type: "refund"} as refund`).
2. **Handler queueing prefixes collide with commands.** `on replace search term` looks like a Handler for `replace`. Suffix participles (`, replacing` / `, dropping` / `, queued` / `, every time`) dodge that, and `, deciding` could mark decision mode the same way.
3. **Multi-word message names** (`before close`, `add up`) break the "name ends where the parameters start" rule. Either names are one word, or the Host declares multi-word message names.
4. **Capability call sites** are the biggest open question. Host-defined commands (`save value as key in storage`) are the most English but mean Hosts extend the grammar. `tell X to …` / `ask X for …` is a uniform alternative with no extension, and `ask` could mark a Suspension Point visibly.
5. **Writes to Host properties vs map keys** look identical (`put … into the state of d`), but one rebinds a local value and the other is a Host effect. Keeping `set` for Host properties would make that visible.
6. **`first`/`last` as Capture names** collide with the ordinals (`replace first <…>`, `the last word`).
7. **Splicing a Pattern value** by bare name inside `<…>` collides with pattern keywords (`word`, `digits`, `text`). Keywords would need to win, or splicing needs a marker.
8. **Whole-value `when <…>` as the default** will quietly fail to match a prefix (`when <"WARN">` on `"WARN: disk"`). It needs a lint.
9. **Precedence of trailing modifiers.** `as`, `delimited by` and `ignoring case` all attach to the right of an expression. Each needs a "nearest" rule, and `(item 2 of line 3 of report) as number * 2` needs parentheses.
10. **`to` is everywhere** (`add x to y`, `round x to 2 places`, `send m to o`, `repeat with i from 1 to 3`), which pushes ranges to `..`. But `items 2 to 4 of x` is the HyperTalk spelling people know.
11. **Keywords as variable names** (`line`, `word`, `item`, `m`, `s`, `min`). A number followed by a unit name is always a Quantity, so a variable called `s` can't follow a number. How big the reserved-word list gets is a beginner-layer concern.
12. **`is nothing` vs `is empty`.** A beginner will test a missing key with `is empty` and get false. That needs a lint.
13. **Expression-form `replace`** (no Container) has no good spelling yet.
14. **Script Variable initialisers** use `=`, which is equality everywhere else.
15. **Guard errors skip the clause.** `where p as number > 10` silently skips the clause on `"lots"`. That is consistent with Elixir destructuring and multi-clause dispatch, but it hides typos.
16. **"Now" is a Capability,** so `today()` doesn't exist. Honest, but date-heavy Scripts get verbose (`the date from clock in zone …`).

## Dropped while sketching

- `wait until <condition>`: it needs polling or re-evaluation on every event, which the execution model doesn't provide. Use `wait for` an event instead.

## For the grammar strategy

The sketches lean on the same grammar features again and again. Each needs a decision:

- trailing modifiers with a nearest-binding rule (`as`, `delimited by`, `ignoring case`, `lazily`)
- keyword-separated parameters and commands (`add x to y`, `round x to n places`, `send m with a to o and wait`)
- `<…>` as a Text Pattern literal next to `<` as less-than
- `name:` inside `<…>`, `{…}` and Destructuring
- Unit suffixes after numeric literals
- lead-word literals (`date`, `instant`)
- whether Hosts can add commands or predicates (`carries`, `save … in storage`)
