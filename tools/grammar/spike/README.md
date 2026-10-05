# Spike: Argument Labels (#338)

A throwaway parser spike for [#338](https://github.com/odogono/odgn-talk/issues/338). It isn't a design and isn't normative. `bun run grammar:check` ignores it. The spike runs with:

```sh
bun tools/grammar/check.ts --labels            # everything, with labels on, plus this directory
bun tools/grammar/check.ts --labels --tree tools/grammar/spike/labels.talk
```

`--labels` turns on, in `parser.ts`:

- **Handler heads:** `on move piece to square where …, queued`.
- **Command Calls:** `move knight to "e4"`.
- **Target-first `send`:** `send to board: move knight to "e4" [and wait]`.
- **`pass`:** `pass move to`.
- **`wait for`:** `wait for move p to sq`.

Each labelled form gets the Selector `move:to:`. The words that may be labels:

- any non-reserved Name, except `with`;
- the Reserved Words `to`, `from` and `by`.

| File | What it is |
| --- | --- |
| `labels.talk` | valid source that must parse with labels on |
| `labels-broken.talk` | broken sources and their first errors, in the `broken.talk` format |

## Findings

- **No new two-token decisions.** Each choice reads one token in operator position, right after a complete parameter or argument:
  - a label versus the end of the statement, a `,`, `where` or `and wait`;
  - `send to` versus `send <message name>`, which works because `to` is reserved;
  - `:` after the target.

  `grammar.toml` needs no new `[[decision]]`. The `--report` counts don't change, and there are no relexes.
- **Existing valid source is unaffected.** With labels on, the sketch, every `talk` block in `docs/` and `spec/`, `spec/stdlib/` and `corpus/` all parse. Today a word in operator position after a complete argument is always a syntax error, so labels only claim source that was invalid.
- **Error quality regresses where the open vocabulary turns a mistake into a labelled call.** These are the cases ADR 0019 reserved `to` to protect:
  - `broken.talk`'s "keyword-shaped Command Call arguments" (`log error rest`) now fails at the end of the line, not at `rest`.
  - `say total count` now fails at the end of the line, not at `count`.

  In both, the error moves to the token after the would-be label.
- **A label at the end of a line doesn't continue the line.** An open set can't join `CONTINUING_WORDS`, because operator-position words such as `times` validly end lines (`repeat 3 times`). So `move knight to` followed by `"e4"` on the next line is an error. Use brackets to split a long call.
- **`from` in `wait for` stays the event's source.** In `wait for move p from a to b`, `from a` is read as the source. So a Selector with a `from` label can't be waited for in labelled form. That needs a decision: drop `from` from the label words, or give the source a different spelling.
- **Hazards behave as D8 says.**
  - `move word toward x` reads `word toward …` as a Chunk Expression and fails at `x`.
  - `scale 3 m 4` lexes `3 m` and fails at `4`.
  - `scale (3) m 4` parses.
  - `move word to x` is safe because `to` is reserved, so it doesn't start a chunk index.
- **Head errors with open labels can be confusing.** In `on go toward x`, `toward` is read as the parameter and `x` as a label, so the error lands at the end of the line.
- **The Go and TS Cores report the same position with different messages.** Go parses Command Call arguments unless the next token is a line end, `else` or `and wait` (`impl/go/internal/syntax/parser.go:413`). TS checks `startsExpr` first (`impl/ts/src/parser.ts:1064`). For a label-first call such as `move to x`, both fail at `to`: Go expects an expression, TS (and this checker) expects the end of the line. Valid code is unaffected.
- **The colon after `send to <target>` doesn't collide with anything.**
  - Time literals have no `:`.
  - Map keys and Binary Pattern fields only read `:` inside their brackets.
  - `:` already doesn't continue a line.
  - A Lambda target (`send to given x: …`) would take the `:` as its own. That is not a realistic target.
