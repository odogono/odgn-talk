# Folio stops Runs at Breakpoints as a Pause

[ADR 0141](0141-folio-opens-projects-from-urls.md) moved the Playground's useful features into Folio and dropped the Replay debugger and Fix and Continue, but said nothing of the Playground's live debugger. Folio gets one, built on the Pause it already has ([ADR 0128](0128-folio-pauses-a-play-session-on-a-virtual-host-clock.md)) rather than beside it ([#1665](https://github.com/odogono/odgn-talk/issues/1665)).

A Run that reaches a Breakpoint Pauses the Play Session partway through that Run. Everything ADR 0128 and [ADR 0129](0129-folio-evaluates-watches-only-while-a-play-session-is-paused.md) say of a Pause holds: the Play clock stops, reader input is dropped, and Watches are evaluated. What differs:

- The whole Play Session stops, as chapter 12 pauses the whole Group: no other Run, frame Handler or timer moves on. Stepping over a Suspension Point lets other Runs execute, and a Breakpoint in any of them stops the Play Session again.
- Step In, Step Over and Step Out (Statement Steps) move the stopped Run on. The frame Step is disabled until the stopped Run finishes, since no frame can advance before then.
- The Variables window shows the stopped Run's frames and their locals. The selected frame, the top one by default, is a context Watches, `:inspect` and Message Box lines can choose, beside those of [ADR 0108](0108-folio-message-box-commands-can-extend-a-chosen-script.md). Locals are read-only; Script Variables can still be set.
- Returning to Edit, or ending the Play Session, abandons the stopped Run without asking.

Breakpoints are set in the Code Browser's gutter and belong to the author's workspace, not the Project: they are never saved in a `.folio` file or a Shared Link. They trigger only while browsing. Present ignores them, so a forgotten Breakpoint never stops a reader. A Breakpoint in a Script edited since the Play Session loaded it is shown faded and does not trigger; while stopped, the Code Browser shows the paused line in the loaded source.

## Considered Options

- **A separate debugger state** with its own clock and input rules: it would repeat ADR 0128's decisions and give Watches two meanings of paused.
- **Breakpoints saved in the Project**: a shared Project or Shared Link would open with someone else's Breakpoints, and could stop a reader.
- **Mapping Breakpoints onto edited source**: wrong as soon as lines are inserted, and the edits do not run until the next session anyway.
- **A separate Debugger window**: the author is already looking at the Variables window while paused, and Watches already have a chosen context for a frame to join.
- **Writable locals**: they need new Core support, and changing a Run partway through is hard to reason about.

## Consequences

- The Group refuses every call while a Run is stopped, so a Watch, `:inspect` or Message Box line there runs through the TS Core's `evaluate` debug hook instead ([#1769](https://github.com/odogono/odgn-talk/issues/1769)): at once, alone, and without the Trace. A send, wait, random draw or Operation call fails it, which an ordinary Message Box line allows.
- Statement Step and the frame Step are different actions; neither is ever labelled a bare "Step" for statements.
- Pausing on an uncaught error reuses this stopped-Run state, but needs the Core to stop before the error unwinds, and is left to its own issue.
