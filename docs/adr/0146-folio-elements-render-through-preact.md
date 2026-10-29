# Folio Elements render through Preact

Folio's Elements are a Preact component, `ElementView`, which Edit's desk, the Page strip's miniatures and Play all render. Preact keeps each Element's node across renders and writes only the attributes, styles and children that changed. Two kinds of content stay as direct DOM inside the component. Rich text is painted by `renderRichText` unless an in-place editor owns it, because `contenteditable` edits those nodes itself. Canvas pixels are painted through a ref, because the painter draws only a Drawing's additions. Pointer gestures on the desk, selection handles and CodeMirror stay as direct DOM, outside Preact's layer.

This revises [ADR 0101](0101-folio-editor-state-is-an-immutable-value-observed-through-signals.md), which kept the Page and its Elements as direct DOM, with Play updating `renderElement` on every frame. That renderer built a new node for every Element on each render and copied it onto the existing one. An animated Page rewrote every Element about fifteen times a second. Sonar wrote 600 unchanged attributes every two seconds, and Tetris restyled all 244 cells to move four of them. Replacing a button's label between a press and its release also cost the reader the click (#1756). Folio now uses Preact wherever a library doesn't own the DOM, and the two content kinds above are where one does.

We considered:

- **Comparing by hand in the existing renderer.** Keep a map from Element to node and write only differing values. It is a smaller change, but every Element kind and property would need its own comparison, kept in step as Elements gain features.
- **Memoising unchanged Elements.** Play's tree is mutated in place under [ADR 0106](0106-folio-edit-and-play-share-a-mutable-project-tree.md), so an Element's identity doesn't show whether it changed. Preact compares the rendered properties instead, which costs little for a Page's Elements.
