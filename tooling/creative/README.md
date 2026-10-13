# NorthTalk creative tool

The browser creative tool planned in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. "Creative tool" is a working name until the application is named.

The page is the Stack editor shell ([#749](https://github.com/odogono/odgn-talk/issues/749)) on the last Project used, autosaved in the browser ([#752](https://github.com/odogono/odgn-talk/issues/752); see [Saving](#saving)). The Page sits on a desk at the Project's design width, scaled down to fit narrower windows. The Tools window adds text, image, button, rectangle, ellipse and line Elements; images are placeholders until image assets arrive. The Info window edits the selected Element's name, position, size and kind's properties, or the Page's and Project's when nothing is selected. It refuses a name that isn't an identifier or that another Element on the Page already has, and offers one instead, including one from a button's label. Click selects an Element, Shift-click selects several, and clicking empty space selects the Page. Drag Elements to move them, drag a handle to resize, and use the arrow keys to nudge, with Shift for 10 px. The strip of Pages adds, shows and reorders Pages by dragging. Windows are dragged by their title bars and stay where they're put. The Edit menu duplicates the selected Elements, or the Page when no Elements are selected, deletes the selected Elements, or the Page only once it is selected (click empty space, press Escape or choose it in the strip), and changes Element layer order. Element copies have fresh names and move 20 px down and right; Page copies keep their layout, with independent Elements and Scripts. The last Page cannot be deleted. Undo and redo cover every authored edit, including a whole drag or Info field change as one step, and restore the Project and selection exactly. Use ⌘D to duplicate, Delete or Backspace to delete, and ⌘Z / ⇧⌘Z to undo / redo (Control also works). Shortcuts leave inputs and editable text to their own keyboard handling. The selection and edits live in [`src/editing.ts`](src/editing.ts), which is tested without a DOM, and the shell that draws them in [`src/stack.ts`](src/stack.ts). A sample Script window on the [shared editor](../editor/) shows the language server's diagnostics, completion and hover; Script windows for the Project's own Scripts come with stage 2.

The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The editor layout and Script windows: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

## Saving

Edits autosave to IndexedDB only, about a second after the last edit (at
most every five seconds during a continuous drag) and at once when the page
is hidden. One transaction writes the model and any new assets together, so
a crash mid-save leaves the previous version intact; the Project in memory
stays the master copy until a write succeeds. The header says **Saved**,
**Unsaved changes** or **Couldn't save**. The last twenty versions, plus one
an hour for the last day, are kept, sharing assets by SHA-256 hash.
**Earlier versions** lists each kept version's time and Page count:
**Preview** shows it read-only on the desk, and **Restore this version**
writes it as the newest version, so the restore can itself be undone by
restoring the version that was newest before it.

**Projects** lists every stored Project, most recently changed first, and
creates, opens, renames, duplicates and deletes them. The app opens the
last Project used. One tab edits a Project at a time, held by a Web Lock:
other tabs open it read-only with **Edit here instead**, which asks the
editing tab to save and give up the lock, and `BroadcastChannel` tells
read-only tabs and Project lists about new saves. A Project stored by a
newer app version is refused, never overwritten; the author is told why and
a new Project opens instead.

After the first saved edit the app asks `navigator.storage.persist()` and
the Projects window says whether the browser granted it ("Kept by the
browser until you clear it" or "The browser may clear this"), shows about
how much space this site uses, and reminds the author to export when
persistence wasn't granted and the Project changed since its last export —
local storage is not a backup, and Safari deletes the data of sites that
aren't installed. A failed or over-quota save shows a lasting banner with
the browser's error name under **Details**, plus **Free space** (keep only
each Project's newest version and unused assets), **Show storage use** and
**Export now**. The in-memory Project is never discarded by a failure: if a
Project couldn't be saved, opening another refuses until it is exported.
If the browser won't keep data at all, a banner says so and editing still
works in memory. Export now downloads a Project file as `.zip` until the
application is named and gets its own extension; image assets and importing
files come with [#753](https://github.com/odogono/odgn-talk/issues/753), so
there are no asset bytes to write from the editor yet.

The design is sections 4–6 of
[the storage research](../../docs/research/creative-tool-project-storage.md).
The stores are [`src/storage.ts`](src/storage.ts), the scheduling
[`src/autosave.ts`](src/autosave.ts), one-editor-per-Project
[`src/edit-lock.ts`](src/edit-lock.ts), and the windows and banners
[`src/projects.ts`](src/projects.ts). Beside each stored version, a
`summaries` record keeps its time, Page count and asset hashes, so listing,
trimming and freeing unused assets never read whole models. All but the windows are tested
without a DOM against `tests/fake-indexeddb.ts`, a small in-memory
IndexedDB whose transactions stage and discard writes like the real ones;
`tests/storage.browser.ts` checks the same behaviour against the real
IndexedDB, Web Locks and BroadcastChannel:

```sh
bun build tooling/creative/tests/storage.browser.ts --outdir tooling/creative/dist --target browser
```

Then run `await import('/storage.browser.js').then(m => m.runBrowserTests())`
in the browser console on the creative tool page. Every result must have
`passed: true`. As with the rich-text bundle below, rebuild it after the
watch server rebuilds the app.

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
