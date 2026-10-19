# An `ask` may name a Result Target

An `ask` may end its arguments with `into` and a Name, before any `and wait`: `ask world to lies item into location`, or `ask storage to load key into saved and wait`. Before this ([#1340](https://github.com/odogono/odgn-talk/issues/1340)), a Script that kept a result followed the call with `put it into location`. Mercenary's Scripts, and 28 of the 396 `ask`s in this repository, do that, and inserting another call before the `put` silently changes which result it keeps.

The Result Target means `put it into x` straight after the call. `x` is a Script Variable of that name, or else a local, and the result is put in `it` as well, so the `it` rule for `ask` has no exception. Both are written once the result arrives, with nothing between that can suspend or raise, and a call that fails, runs out of time or is abandoned writes neither. The lowering adds `move 0 x`, or `load 0` `store-var x`, after the `store 0` it already had, so no instruction, cost or save format changes: a pending call resumes at `store 0`, and the target's write follows it. `into` was already reserved and ends an expression, so the arguments parse as before. A Join Member can't have one, since its answer is in the Join's list.

## Considered Options

- **Binding semantics, as a collecting target.** The target would always be a new local, and a Script Variable's name would be `name clash`. It is a second rule for what a written Name means, and keeping a result in a Script Variable would still need `put`.
- **Any Container.** `into item 1 of xs` would evaluate a Container between the result and its write, where it could raise after the call had succeeded.
- **`and wait into x`.** `and wait` would no longer always end its statement, and the waiting would no longer be the last thing read.
- **Leave `it` unchanged.** One Fuel cheaper, but `ask` would set `it` except when it didn't.

## Consequences

- `Ask` in `grammar.ebnf` takes `ResultTarget?` before `AndWait?`. The reference parser and lowering, each Core's parser, checker and lowering, the formatter and the LSP take it.
- A Result Target on a Join Member is `not in a join` at its `into`.
- The other calls that set `it` (`tell` block lines, Command Calls, call statements, `send … and wait`) and per-member Join targets are [#1350](https://github.com/odogono/odgn-talk/issues/1350).
