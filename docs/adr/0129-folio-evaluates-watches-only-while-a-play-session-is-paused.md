# Folio evaluates Watches only while a Play Session is paused

While browsing, an author can add Watches to the Variables window ([#1210](https://github.com/odogono/odgn-talk/issues/1210)). A Watch is one expression, and its latest value is shown beside the Script Variables. The Variables window reads Script Variables through `inspect()`, which costs no Fuel and leaves the Trace unchanged. An expression cannot be read that way: it must run as a Run, which spends Fuel, appears in the Trace and can have effects.

So Folio evaluates Watches only while the Play Session is paused ([ADR 0128](0128-folio-pauses-a-play-session-on-a-virtual-host-clock.md)):

- when a Watch is added or edited, and after every Step and every Message Box line, once that Pump has finished;
- all Watches start together in one more Pump, and the Variables window refreshes after it, so values and Script Variables agree;
- while Play runs, Watches keep their last values, marked as paused-only.

Each Watch picks its context as the Message Box does ([ADR 0108](0108-folio-message-box-commands-can-extend-a-chosen-script.md)): the default ownerless context or one loaded Script, with that Script's Grants. When the Script unloads, the Watch shows "(unavailable)" until the author picks again. A Watch uses the Message Box's generated Handlers: the same text in the same Script reuses one Handler, and Watches count toward the 1,000-Handler cap. This amends ADR 0108, whose generated Handlers were only for commands.

The input is one expression. Statements are refused. Effects are not prevented, because the Core cannot evaluate an expression without them: a Watch that sends a message or calls an Operation does so, and its row warns that it did. A Watch that does not finish in its Pump shows "(waiting)" and runs on as an ordinary Run. Its row updates when it ends, and no new evaluation of it starts until then. A Watch that raises shows the error in its row, not in the Errors window.

Watches exist only in Browse. They stay across Play Sessions of the same Project and are cleared when another Project opens. After a session ends, their values keep the Variables window's note that they come from the ended session.

## Considered Options

- **Every frame, or every Variables window refresh**: each would spend Fuel and change the Trace while Play runs, and race the game's own Runs.
- **A context with no Grants**: it blocks Operations but still lets a Watch set properties on Host Objects, and it cannot see a Script's Script Variables, which is what most Watches read.
- **A separate evaluation mechanism**: ADR 0108 already chose Extend over one, for the same scope and execution rules.

## Consequences

- Running Play costs nothing extra, however many Watches there are.
- A Watch is only current while paused. Seeing a value change live means watching a Script Variable instead.
