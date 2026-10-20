# A Canvas Element keeps a retained Drawing across Play and Edit

Folio gains a `canvas` Element kind, drawn on through a `canvas` Grant, so that a game like Tetris can redraw itself every `frame` instead of recolouring hundreds of pre-placed Elements ([#1144](https://github.com/odogono/odgn-talk/issues/1144)). Each Canvas Element keeps its Drawing: the list of commands made since its last `clear`. The Drawing is one continuous surface. Play starts from what is on it, Scripts and the Message Box add to it in Play and in Edit, and on return to Edit each Canvas's Drawing is committed into the Project as one undoable edit. This is a deliberate exception to [ADR 0041](0041-authored-projects-are-separate-from-temporary-play-state.md). An author thinks of a canvas as a surface that holds what was last drawn on it. What is saved is what they see, and Undo is the way back to the Drawing from before Play.

Unlike the Playground's canvas ([ADR 0052](0052-canvas-is-a-deterministic-host-capability.md)), where the Trace is the record and a lifetime count of 10,000 commands ends drawing until a fresh run, a Folio Drawing is a retained list. `clear` empties it, and the 10,000 cap applies to its length. Folio does not keep a Trace for drawing, and its Play worker has to publish a view to the page, so it needs the list itself.

## Considered Options

- **A lifetime count reset by `clear`, with no list**, as in the Playground. A game could redraw forever, but nothing could rebuild the picture for the page, for Edit or for the Project file.
- **Play Drawing discarded on return to Edit**, as ADR 0041 does for other Play State. Consistent, but an author who drew a board and played would lose sight of what the game drew.
- **The last Play frame kept as an unsaved view in Edit.** What the author sees would differ from what is saved, and drawing on it from the Message Box would either silently save the Play frame or draw on content that vanishes on reload.
- **Saving only what was drawn in Edit.** A reload would show Edit lines without the Play frame they were drawn over.
- **An authored logical resolution scaled to the frame**, as the Playground's `size`. The Canvas's own width and height are its coordinates instead, one unit to one Page pixel, so there is no `size` Operation and resizing clips or reveals rather than scales.
- **A Grant bound to the Canvas's Owning Script, or a "current canvas" selector.** Each Operation takes the target Canvas Element as its first argument instead, as `elements` takes Elements, so a Page Script can draw into any Canvas it can name without a message each frame or hidden state.

## Consequences

- The Drawing is stored in the Project file as `{op, args}` commands, checked with the same signatures, validation and limits as the Playground's canvas, which move out of `tooling/stack/src/canvas.ts` into shared exports. Folio's Grant does not use `canvasCapabilities()`.
- Each canvas Operation is `immediate` and costs 1 Fuel. Commands are not Segment-bound, so a Play stopped part-way through a frame commits the half-drawn Drawing as shown.
- All other Play State is still discarded on return to Edit. Scripts cannot read a Drawing back, and cloning or duplicating a Canvas copies its Drawing.
- Each Message Box line in Edit that draws is one undoable edit. Only `clear`, or the Info panel's Clear drawing action, removes commands. Nothing marks a Canvas whose Drawing came from Play.
- Tests check the retained list from a headless Play Session, not pixels or a Trace.
- Narrows ADR 0041: a Canvas Element's Drawing is kept on return to Edit, not discarded with Play State.
