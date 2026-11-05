# Sessions add Scripts, so Documentation Examples reach a Script's Handlers by message

A session may hold Scripts beside the Session Script. `:script add <name>` loads one into the session's Group, and an Entry reaches it by message, as in `send increment to counter and wait`. `northtalk test` uses it to replay the Documentation Examples (ADR 0169) in a `--|` block before a Script's Handler: the runner adds the documented Script as hidden setup, as it adds Libraries, and the example reaches it only by message, as ADR 0056 requires. We chose this because an example of a Handler should be a true Session Transcript, replayed by the normative Session Host, and a session that can hold a second Script is useful at the REPL too. Implementation is tracked in #2113.

```
--| Adds 1 to the count, and gives the new count
--|
--| > send increment to counter and wait
--| > it
--| 1
on increment
```

## Considered Options

- **A Group beside the session, joined by a Peer or bridge, built by the runner:** no spec change, but the example would no longer replay through the Session Host alone, against ADR 0169's "the replay is the Session Host's own".
- **No examples on Script Handlers:** Test Scripts and `*.transcript` files already test them, but a Script's `--|` blocks would be left to drift.
- **Every Script in the documented Script's directory**, as Test Scripts get them: an example would depend on its siblings. A message to another Script goes unhandled, and the example shows that.
- **The manifest's Grants as mocks**, as Test Scripts get them (ADR 0139): hidden setup that hover wouldn't show.
- **`:script replace`:** left out until the REPL wants it.

## Consequences

- **The session:** chapter 12's one Group holds the Session Script and any Scripts `:script add` added, each loaded under `GrantsAsUsed` with the Session Script's Grants, owning no Host Object.
- **`:script add <name> <path>`** comes after `:grant` and `:mock` and starts the session. A Transcript records it as `> :script add <name>` followed by the source as `|` lines, as for `:library`. It is refused as `name reused` for a name already in the Group or `session`, and a Script that doesn't load prints its `! <code> at <unit>:<line>:<col>` lines and isn't added.
- **Other commands:** `:save` and `:restore` include added Scripts. `:fix`, `:vars` and Declarations act on the Session Script only. `:runs` and `:mailbox` list every Run in the Group, so they show the added Scripts' Runs.
- **Which declarations:** only a Script's Handlers carry tested examples; a `>` block on a Script's function or Constant is ignored, the white-box testing ADR 0056 rejected. Scripts are the `.talk` files `northtalk test` walks, not `.test.talk`, and each example is named `<stem>.<handler> example <n>`.
- **Grants:** only what the example's own `:mock` and `:grant` lines declare, which apply to the added Script too.
- **Refused in an example:** `:script`, with the commands ADR 0169 already refuses.
- **Cores:** both Session Hosts (TS and Zig) implement `:script`, with corpus cases in `corpus/sessions/`.
- Narrows ADR 0169: Documentation Examples cover a Script's Handlers as well as Library exports.
