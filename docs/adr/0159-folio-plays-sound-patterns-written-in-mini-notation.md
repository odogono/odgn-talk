---
status: accepted
---

# Folio plays Sound Patterns written in Mini-Notation

Strudel's immediacy comes from one line of Mini-Notation: `loop "bd hh sd oh"`. Sequencing each note from a Script would cost a Run and Fuel per note, would time each note to a Pump, and would read worse ([#1887](https://github.com/odogono/odgn-talk/issues/1887)). So Folio plays Sound Patterns itself, and Scripts orchestrate them.

```text
loop "bd [hh hh] sd hh"                  -- default kit, from the next bar
loop "hh*8, - cp" on tr909 with {gain: 0.8}
loop "<c3 e3 g3>*4" on bass

on click
  loop "bd*2, hh*4, - cp"               -- changes the groove on the next bar
end click
```

The `on` and `with` clauses aren't in the grammar yet, so this block is marked as text. Adding them is a language change that [#1896](https://github.com/odogono/odgn-talk/issues/1896) makes.

- **Folio schedules every step** of a Sound Pattern on the Transport itself. No Run is started and no Fuel is spent per note.
- **One cycle is one bar.**
- **`play` sounds straight away**, spread over one bar. **`loop` starts on the next bar** and repeats every bar. **`stop` ends them.** All three can be written as Host Commands ([ADR 0094](0094-host-commands-are-command-call-spellings-of-granted-operations.md)), with `on <Instrument>` and `with {gain, pan, speed}`. Without `on`, they play the default kit.
- **Ownership:** a Sound Pattern belongs to the Script that started it, with at most one per Instrument per Script. A second `loop` on the same Instrument replaces the first on the next bar. Stopping the Script, leaving its Page or releasing its Grant stops its Sound Patterns, as they already stop its sounds.
- **Folio's own parser** reads Mini-Notation, written from Strudel's documented syntax with none of its AGPL code. Milestone 1 covers sequences, `-` rests, `[ ]`, `< >`, `*n`, `/n`, `,`, `name:n` and note names. Each event keeps its place in the text, to highlight the playing step and trace it later.
- **Checked at load:** a pattern text written in a Script is checked when the Script loads. Syntax errors and unknown sample or Instrument names are reported against the Script and line, and underlined in the editor.
- **The Message Box:** during Play, a pattern belongs to the targeted Script. In Edit, `play` is only a preview, and `loop` says that it starts in Browse.

**`tell sound to loop` changes meaning.** Its text is now Mini-Notation. Format 6 rewrites every older `loop "name"` of a Project sound to `play "name" with {repeat: true}`, which repeats the whole sound end to end, free of the bar, as `loop` used to.

## Considered Options

- **Scripts sequence every note**, with `on beat` and `play`: this costs a Run per beat, ties notes to Pump timing, and loses the one-line immediacy.
- **Run Strudel itself:** it is AGPL and brings its own scheduler, clock and evaluation, which would bypass the Play Session.
- **A new Operation name for patterns, leaving `loop` as it was:** `loop` is the word every Strudel lesson teaches, and old Projects can be migrated.
- **Several patterns per Instrument per Script:** layers already go in one pattern with `,`, and one per Instrument makes replacement on the bar unambiguous.

## Consequences

- A long Project sound that used to loop now needs `with {repeat: true}`. Older Projects get it from the migration.
- The sampler gains a `repeat` option.
- The Trace can link each note to the character range of the pattern that played it.
