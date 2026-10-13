# NorthTalk creative tool

The browser creative tool planned in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. "Creative tool" is a working name until the application is named.

The page is the Stack editor shell ([#749](https://github.com/odogono/odgn-talk/issues/749)) on a new, unsaved Project. The Page sits on a desk at the Project's design width, scaled down to fit narrower windows. The Tools window adds text, image, button, rectangle, ellipse and line Elements; images are placeholders until image assets arrive. The Info window edits the selected Element's name, position, size and kind's properties, or the Page's and Project's when nothing is selected. It refuses a name that isn't an identifier or that another Element on the Page already has, and offers one instead, including one from a button's label. Click selects an Element, Shift-click selects several, and clicking empty space selects the Page. Drag Elements to move them, drag a handle to resize, and use the arrow keys to nudge, with Shift for 10 px. The strip of Pages adds, shows and reorders Pages by dragging. Windows are dragged by their title bars and stay where they're put. There is no undo, deletion or autosave yet: reloading the page loses the Project. The selection and edits live in [`src/editing.ts`](src/editing.ts), which is tested without a DOM, and the shell that draws them in [`src/stack.ts`](src/stack.ts). A sample Script window on the [shared editor](../editor/) shows the language server's diagnostics, completion and hover; Script windows for the Project's own Scripts come with stage 2.

The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The editor layout and Script windows: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

## Running it

From the repository root, with Bun 1.4.2:

```sh
bun install
bun run creative                       # serves at http://127.0.0.1:3928/ and rebuilds on change
bun run --cwd tooling/creative build   # a static dist/ any web server can host
bun test tooling/creative/tests
```
