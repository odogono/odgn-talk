---
status: accepted
---

# A Handler Clause may require a Shape of its arguments

A Handler Clause picks its message with Destructuring and a Guard, so asking that an argument fit a named Shape ([ADR 0168](0168-scripts-declare-named-shapes-in-an-english-spelling.md)) takes a Guard: `on handle inv where inv is an Invoice`. A Clause Shape says it in the head instead, where the reader looks for what a clause accepts ([#2056](https://github.com/odogono/odgn-talk/issues/2056)).

```text
on handle inv is an Invoice where the amount of inv > 1000
  send review with inv to approvals
end handle

on handle other
  pass handle
end handle
```

**Guard semantics**

- A Clause Shape is a Guard. A message that doesn't fit means the clause doesn't match: dispatch tries the next clause, then the Fallback Handler ([ADR 0064](0064-a-fallback-handler-receives-messages-no-clause-matches.md)), and a plain call raises `no match`. There is no new run-time behaviour, and nothing changes for save, restore or Reload.
- We deferred contract semantics, where a mismatch raises an error that blames the sender, like Kit's `@pre`. It needs answers to whose Fuel pays, where the error goes for a `send` that doesn't wait, and whether the Fallback Handler still sees the message. That is [#2057](https://github.com/odogono/odgn-talk/issues/2057)'s question, and a Clause Shape keeps its Guard meaning whatever it decides.

**The form**

- `is a` or `is an` and a name may follow any parameter, before the Argument Label that follows it, if any: `on move item is a Thing to place is a Place where …`. The Selector is unchanged, `move:to:` ([ADR 0055](0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md)).
- The name is what `is a` takes everywhere else: a kind, `integer`, a Unit or a named Shape in scope. Any other name is `unknown kind`.
- A Shape may follow a Destructuring pattern, `on handle {amount: a} is an Invoice`, and tests the whole argument, not the names the pattern binds. The lowering keeps the argument in its own slot, which a pattern leaves unnamed.
- A Fallback Handler's clause takes a Shape on its message-map pattern by the same rules.
- `is not a` in a head is the load error `negated shape`. A clause that takes everything but one Shape is clearer as a Guard, `where m is not a Ping`, and the error says so.

**Order and cost**

- A clause matches by checking the number of arguments, then the Destructuring patterns, then the Shapes from left to right, then the written Guard.
- The Shapes lower as `<argument> is a S and …` in front of the Guard, in one guard region. So a clause costs exactly what the same Guard written out costs, a Shape that raises skips the clause as a Guard's error does, and the Trace records the same `guard-skip`.

**No change elsewhere**

`wait for … where` and `match … when` take no head Shape, because `is an X` already works in their conditions.

**Consequences**

- Grammar: a parameter is a `Pattern` followed by an optional `ClauseShape`, `'is' 'not'? Article Kind`. `is` is reserved, so after a parameter pattern it always starts one, and no new second-token decision is needed. A head with `is` after a parameter was a syntax error before.
- Diagnostics: the new load diagnostic `negated shape`, at `not`.
- Delivery is staged, as ADR 0168's was: the Spec, grammar, reference parser and reference lowering land first, with the parser cases in `tools/grammar/staged.talk` and the Spec's examples in `text` fences. The Core PRs also add the form to the tour's Handler Clause section, since the Cores' tests parse the tour. The TS Core ([#2136](https://github.com/odogono/odgn-talk/issues/2136)) and Zig Core ([#2137](https://github.com/odogono/odgn-talk/issues/2137)) bring the corpus cases and move the staged cases into `broken.talk`; tooling ([#2138](https://github.com/odogono/odgn-talk/issues/2138)) brings highlighting, formatting, hover and completion after `is a` in a head. Elixir picks it up at the next reactor re-pin.
