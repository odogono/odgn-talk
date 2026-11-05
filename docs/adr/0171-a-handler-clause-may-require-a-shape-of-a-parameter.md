---
status: accepted
---

# A Handler Clause may require a Shape of a parameter

Since [ADR 0168](0168-scripts-declare-named-shapes-in-an-english-spelling.md), a Clause can already test a named Shape in its Guard: `on handle inv where inv is an Invoice`. The test is buried in an expression, though, so tooling can't read a Script's message interface off its heads, and reply Shapes ([#2058](https://github.com/odogono/odgn-talk/issues/2058)) have no head form to follow ([#2054](https://github.com/odogono/odgn-talk/issues/2054), [#2056](https://github.com/odogono/odgn-talk/issues/2056)). A parameter may now carry its Shape in the head.

```talk
shape Invoice is {type: text, amount: GBP, ...}

on handle inv is an Invoice where the amount of inv > 1000 GBP
  send review with inv to approvals
end handle

on handle other
  pass handle
end handle
```

**Form**

- After a parameter's Destructuring pattern, `is a` or `is an` and a kind or a Shape name in scope is that parameter's Clause Shape. What may follow `is a` is exactly what the expression `is a` takes.
- Each parameter may have one, before its Argument Label: `on move item is a Thing to place is a Place`. `is` is a Reserved Word, so it is never a label, and the Selector stays `move:to:` ([ADR 0055](0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md)).
- After a pattern, the Shape tests the whole argument: `on handle {amount: a} is an Invoice`.
- A Fallback Clause takes one on its message-map pattern by the same rules.
- `is not a` in a head is the load error `negated shape`, which says to write it as a Guard. A negated Shape says what a message isn't, which describes no interface.

**Meaning: a Guard, not a contract**

- A Clause Shape is a Guard. A mismatch means the clause doesn't match, so dispatch tries the next clause, then the Fallback Handler ([ADR 0064](0064-a-fallback-handler-receives-messages-no-clause-matches.md)), and a plain call raises `no match`.
- A clause matches by checking the number of arguments, then the patterns, then the Clause Shapes from left to right, then the written Guard. Each Clause Shape lowers to what a Guard of only `where p is a S` lowers to, and charges the same Fuel. Chaining several with `and` in a Guard costs a little more, for the `and`s. It needs no new instruction or cost row, and doesn't touch save, restore or Reload.
- We deferred contract semantics, in which a mismatch is an error that blames the sender, like Kit's `@pre`. That needs answers about whose Fuel pays, where the error goes for a `send` that doesn't wait, and whether the Fallback Handler still sees the message. Host-enforced Shapes at admission ([#2057](https://github.com/odogono/odgn-talk/issues/2057)) is where to settle them.

**Not changed**

`wait for … where` and `match … when` take no Clause Shape: their conditions already accept `is an X`, and they describe no interface.

**Consequences**

- Grammar: `HeadParam` in `HandlerHead` and `FallbackHead`; the load diagnostic `negated shape`.
- Tooling ([#2138](https://github.com/odogono/odgn-talk/issues/2138)) highlights, formats, hovers and completes the Shape name in a head. A Script's message interface and mismatch explanations are [#2059](https://github.com/odogono/odgn-talk/issues/2059).
- Delivery is staged as ADR 0168's was: the Spec, grammar and reference parser land first, with parser cases in `tools/grammar/staged.talk`. The Core PRs ([#2136](https://github.com/odogono/odgn-talk/issues/2136), [#2137](https://github.com/odogono/odgn-talk/issues/2137)) bring the corpus cases and move the staged cases into `broken.talk`.
