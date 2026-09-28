# Libraries sketch

This is throwaway source for [#40](https://github.com/odogono/odgn-talk/issues/40) and ADR 0020. It isn't run or parsed by anything.

| File | Shows |
| --- | --- |
| `damocles.talk` | The Damocles `epilogue` as a Library: a `constant`, a `private` helper, and suspending Handlers. |
| `tolosa.talk` | The `??` race from the Example Hosts sketch, fixed with `use epilogue from damocles` and `epilogue and wait`. |
| `session.talk` | The call sites that change, a clash with a local Handler, and imported Handlers not being entry points. |
| `text.talk` | A stdlib-style Library with pure functions, Constants and a `private` helper. |
| `report.talk` | `put report(…) into` from 09-http-fetch, which becomes a load error and is rewritten as `report … and wait`, then `it`. Also shows a rename on import. |
| `case.toml` | `[[libraries]]` in a Trace Case setup, and a Library checked against the importer's Grants. |

## What writing it turned up

- `and wait` on Command Calls spreads. Once `epilogue` is marked, so is every Handler that calls it (`landed`, `taken`). That's the point, but most Damocles Handlers end in a visible wait now.
- `sayAll ids and wait` reads well. `put it into …` after a suspending Command Call is HyperTalk-familiar, but it's two lines where `put report(…) into` was one.
- `the landingLines of body` as an argument is fine: the Script reads the Host property and passes it in, and the Library never sees `body`.
- `trim` wants `start` and `end` anchors in Text Patterns. `end` is a Reserved Word, so inside `<…>` it has to work as a pattern keyword. That needs confirming with the pattern catalogue.
- A Constant holding a Text Pattern is spliced as `(blank)` (ADR 0019), even inside the Library that defines it.
