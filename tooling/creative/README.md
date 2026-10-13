# NorthTalk creative tool

The browser creative tool planned in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. "Creative tool" is a working name until the application is named.

The page is the Stack editor shell ([#749](https://github.com/odogono/odgn-talk/issues/749)) on a new, unsaved Project. The Page sits on a desk at the Project's design width, scaled down to fit narrower windows. The Tools window adds text, image, button, rectangle, ellipse and line Elements; images are placeholders until image assets arrive. The Info window edits the selected Element's name, position, size and kind's properties, or the Page's and Project's when nothing is selected. It refuses a name that isn't an identifier or that another Element on the Page already has, and offers one instead, including one from a button's label. Click selects an Element, Shift-click selects several, and clicking empty space selects the Page. Drag Elements to move them, drag a handle to resize, and use the arrow keys to nudge, with Shift for 10 px. The strip of Pages adds, shows and reorders Pages by dragging. Windows are dragged by their title bars and stay where they're put. The Edit menu duplicates the selected Elements, or the Page when no Elements are selected, deletes the selected Elements, or the Page only once it is selected (click empty space, press Escape or choose it in the strip), and changes Element layer order. Element copies have fresh names and move 20 px down and right; Page copies keep their layout, with independent Elements and Scripts. The last Page cannot be deleted. Undo and redo cover every authored edit, including a whole drag or Info field change as one step, and restore the Project and selection exactly. Use ⌘D to duplicate, Delete or Backspace to delete, and ⌘Z / ⇧⌘Z to undo / redo (Control also works). Shortcuts leave inputs and editable text to their own keyboard handling. There is no autosave yet: reloading the page loses the Project. The selection and edits live in [`src/editing.ts`](src/editing.ts), which is tested without a DOM, and the shell that draws them in [`src/stack.ts`](src/stack.ts). A sample Script window on the [shared editor](../editor/) shows the language server's diagnostics, completion and hover; Script windows for the Project's own Scripts come with stage 2.

The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The editor layout and Script windows: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

## Rich text

Double-click a text Element, or choose **Edit formatted text** in Info, to edit
it on the Page. Formatting controls head the Info window whenever one text
Element is selected, as a text layer's properties do in a design tool's
inspector. Without editing, they apply to all of the Element's text; while
editing, select text and use them for bold, italic, underline and selection
colour. Clicking an active mark
removes it; **Clear** removes
all selection marks so the Element's colour applies again. **Paragraph** inserts
a paragraph break at the selection, as Enter does. Formatting requires a text
selection. Font, size, whole-Element colour and **Reader can edit** remain in Info;
the reader flag is stored for future Play Sessions.

**Done**, Escape, selecting another Element or changing Page finishes editing.
The toolbar's Undo and Redo, or ⌘/Ctrl-Z and ⌘/Ctrl-Shift-Z (also Ctrl-Y), are
the Edit menu's: each text change or formatting step is one entry in the same
history as every other authored edit.

Pasting HTML keeps paragraphs, bold, italic, underline and text colours from
semantic tags and inline styles. Links become text; images, scripts, embedded
content, stylesheet/class formatting, fonts, sizes and backgrounds are dropped.
Plain text paste keeps its paragraph breaks. Dragging external content into text
is disabled. The authored model holds paragraphs of styled runs, and the Project
file round-trip preserves them; the editor never stores raw HTML.

The model's `textOf(element)` reads paragraphs joined by newlines;
`replacePlainText(element, text)` replaces them and clears mixed formatting,
even when the plain text is unchanged. These are the plain-text operations the
Play Host can use for `the text of` in stage 2. Info's plain text field also
clears mixed formatting when its text is changed.

Browser regression checks use the real DOM, including clipboard HTML, selections,
IME composition and the toolbar. With the creative tool server running, build:

```sh
bun build tooling/creative/tests/rich-text.browser.ts --outdir tooling/creative/dist --target browser
```

Then run `await import('/rich-text.browser.js').then(m => m.runBrowserTests())`
in the browser console on the creative tool page. Every result must have
`passed: true`. Rebuild this test bundle after the watch server rebuilds the app.

## Running it

From the repository root, with Bun 1.4.2:

```sh
bun install
bun run creative                       # serves at http://127.0.0.1:3928/ and rebuilds on change
bun run --cwd tooling/creative build   # a static dist/ any web server can host
bun test tooling/creative/tests
```
