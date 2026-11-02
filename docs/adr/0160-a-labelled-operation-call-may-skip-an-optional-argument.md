# A labelled Operation call may skip an Optional argument, and `on` and `with` may be labels

Folio's Sound Patterns are written `loop "hh*8, - cp" on tr909 with {gain: 0.8}`, and a whole Project sound repeats with `play "rain" with {repeat: true}` ([ADR 0159](0159-folio-plays-sound-patterns-written-in-mini-notation.md), [#1896](https://github.com/odogono/odgn-talk/issues/1896)). Neither could be written before. `on` is a Reserved Word and `with` was excluded from the [Argument Label words](../../spec/02-grammar.md#argument-label-words). And a labelled call wrote a prefix of its Operation's labels ([ADR 0115](0115-operation-declarations-may-declare-argument-labels.md)), so `play "rain" with {…}` couldn't leave out the `on` argument before `with`.

So `on` joins `to` as a Reserved Word that may be a label, and `with` is no longer excluded. A labelled Operation call may also leave out any Optional argument after the first, along with its label. The argument it leaves out is Nothing. `play "rain" with {repeat: true}` is the call `play "rain", nothing, {repeat: true}`, and it has the same argument count, cost and Trace.

Neither word was needed where [ADR 0055](0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md) feared a clash:

- **`on`** starts a Handler only at the start of a statement. After a complete argument, a word in operator position was always a syntax error, so a label there can't be read any other way.
- **`with`** after a complete argument already continues a line, as it does after `replace … with`, and nothing reads it there. `send m with … to t` reads its `with` straight after the message name, before any argument, and a labelled message is sent only in the target-first form, so the receiver-last form is unchanged. `begins with` and `ends with` read `with` only after their first word, and a `replace` operand takes its own `with` before the argument ends.

## Considered Options

- **Always write the skipped label's argument**, as `play "rain" on nothing with {…}` or `on kit`. This needs no rule, but it puts noise in the calls musicians write most.
- **Fold the middle argument into the map**, as `loop "…" with {on: bass}`. This needs no skipping, but an Instrument then reads as an option rather than the target, and the Instrument name isn't checked as an argument.
- **Let labels come in any order**, as keyword arguments do in other languages. Labels are a reading aid over positional arguments, so a fixed order keeps one spelling for each call and keeps Selectors finite.

## Consequences

- **Matching:** the call's labels are matched left to right. Each takes the first declared position after the previous argument's with that label word. A label with no such position, or one that skips a required argument, is `wrong labels` at that label. The argument count is checked first, as before.
- **Host Commands** answer one Selector for each set of labels a call may write, so `play` with `labels = ["on", "with"]` and two Optional arguments answers `play`, `play:on:`, `play:with:` and `play:on:with:`. Resolution, shadowing and clashes work on each Selector on its own, as in ADR 0115.
- **Handlers** are unchanged. A Handler's labels still join its Selector, and a call names exactly its Handler's labels. `on loop pattern on instrument` is now a valid head.
- **Declarations:** `DefineCapability` accepts `on` and `with` as labels. A save written with them can't be read by an older Core, as for any new declaration.
- Amends ADR 0055, whose label words excluded `with`, and ADR 0115, whose calls wrote a prefix of the labels.
