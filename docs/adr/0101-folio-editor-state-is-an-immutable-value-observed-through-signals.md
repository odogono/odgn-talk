# Folio's editor state is an immutable value observed through signals, and its panels are Preact components

Superseded in part by [ADR 0106](0106-folio-edit-and-play-share-a-mutable-project-tree.md): Edit and Play now own persistent mutable trees with readonly live views, explicit change notifications and forward/inverse history. The Preact/direct-DOM split and stable-ID policy below stand.

Folio's editor used to hold one mutable Project and edit it in place. Its identity had to be preserved across loads, so changes were detected by comparing JSON, undo kept `structuredClone` snapshots, and every edit redrew every panel from scratch. That forced workarounds: restoring focus in the Info panel after each rebuild, skipping redraws while a field is typed in, and re-rendering every Page's thumbnail on every keystroke. The editor's state is now one immutable value holding the Project, the showing Page, the selection and whether the Page itself is selected. Each edit produces a new value with Immer, which shares every Page and Element that did not change and freezes the result. The editor holds the value in a `@preact/signals-core` signal, and the current Page, the selected Elements and whether undo or redo is possible are computed from it. Undo keeps earlier values. A live edit such as a drag produces a new value on every change and records one undo step when it finishes. A change is detected by comparing references.

The signal is the only place the current Project lives. The editor copies and freezes any Project it is given, and the rest of the page reads the Project from the signal each time it needs it. Pages and Elements carry a session-local id, assigned when a Project loads and never written to a `.folio` file or browser storage. Script windows find their owner by this id, so it survives undo, redo, renames and the Message Box write-back.

The panels that are rebuilt from state, starting with the Info panel and the Page strip, are Preact components written in JSX. The Page and its Elements on the desk, pointer gestures, the CodeMirror Script windows and in-place rich text stay as direct DOM code that follows the signal through effects. `renderElement` is shared with Play, which updates it on every frame. CodeMirror and `contenteditable` own their DOM, so a virtual DOM would fight them. Play is unchanged: a Play Session keeps its own mutable copy of the Project, as [ADR 0041](0041-authored-projects-are-separate-from-temporary-play-state.md) already separates Play State from authored work.

## Considered Options

- **A state library over the mutable Project** (Jotai, or signals alone): atoms notice changes by reference, so an object edited in place would need a version counter bumped by hand, which is the old change callback again.
- **Hand-written immutable updates**, with no Immer: every edit rewritten as spreads, and nothing to catch a mutation that was missed. Immer lets the existing editing code run on a draft, and its frozen results make a missed mutation throw.
- **Immer patches for undo**: smaller history entries, but the selection and showing Page would need patches too. Earlier values are cheap once they share structure.
- **Jotai for the state layer**: React-first, so Preact would need its compatibility layer. Signals are native to Preact and also work outside components, which the direct DOM code needs.
- **Keeping the map from objects to session ids**: every edit that replaced a Page or Element would have to copy its id across by hand.
- **Rewriting the whole editor in Preact**: most of the gain is in a few panels, and the riskiest parts (gestures, `contenteditable`, Play) gain nothing.
- **Tidying the direct DOM code**, with no new dependencies: updating Info controls in place and caching thumbnails fixes today's symptoms. Each new panel would need the same care again.

## Consequences

- Narrows [ADR 0093](0093-folio-browses-in-place.md): when the Message Box writes a session back, "Authored Pages and Elements keep their identity" means they keep their session-local ids. The written-back Project is a new value.
- The editor's state is typed as immutable, so changing it outside an edit fails to compile, and the frozen value makes it fail at run time too. The Project type stays mutable for Play and for building test fixtures.
- Folio depends on Preact, `@preact/signals` and Immer. Its TypeScript configuration compiles JSX with Preact as the JSX import source.
