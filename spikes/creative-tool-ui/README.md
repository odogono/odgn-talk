# Creative tool editor UI (prototype)

A throwaway UI prototype for [#154](https://github.com/odogono/odgn-talk/issues/154), asking what the browser creative tool's editor should look like. It lives on this branch only, not on `main`.

Open `index.html` in a browser. Switch layouts with the bar at the bottom, the ← / → keys, or `?variant=A|B|C`. Nothing persists, and the NorthTalk source in the Scripts is illustrative.

- **A, Workbench:** a Page rail, the Page, and a Design / Script inspector.
- **B, Stack:** the Page on a desk, with floating Tools, Info and Script windows and a strip of Pages.
- **C, Outline:** a Project tree, a context bar above the Page, and a docked Script editor with a Problems list.

All three share a simulated Play view, which counts Play State changes, has Stop and Back to Edit, and previews the Page at phone width.

## Verdict

**B.** It suits the tool's HyperCard heritage. Like HyperCard's script windows, each Script opens in a window of its own: double-click an Element, Shift-double-click a text Element, or ⌘⌥-click any Element. Clicking a step in a window's Message Path opens that owner's Script too, so a message's route from Element to Page to Project can be followed across windows.

Authoring is desktop only in v1. Phones and tablets get the player, which scales the Page to fit and scrolls vertically, as #154 already defers mobile authoring.
