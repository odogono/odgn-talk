# NorthTalk creative tool

The browser creative tool specified in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. "Creative tool" is a working name until the application is named.

The page is the Stack editor shell ([#749](https://github.com/odogono/odgn-talk/issues/749)) on the last Project used, autosaved in the browser ([#752](https://github.com/odogono/odgn-talk/issues/752); see [Saving](#saving)). The Page sits on a desk at the Project's design width, scaled down to fit narrower windows. The Tools window adds text, image, button, rectangle, ellipse and line Elements; Image opens a file picker; dropping image files on the Page adds them at the drop position (see [Images and portable Projects](#images-and-portable-projects)). The Info window edits the selected Element's name, position, size and kind's properties, or the Page's and Project's when nothing is selected. It validates names against Script bindings and Page/Element names (see [Script Recipes](#script-recipes)), and offers an available name instead, including one from a button's label. Click selects an Element, Shift-click selects several, and clicking empty space selects the Page. Drag Elements to move them, drag a handle to resize, and use the arrow keys to nudge, with Shift for 10 px. The strip of Pages adds, shows and reorders Pages by dragging. Windows are dragged by their title bars and stay where they're put. The Edit menu duplicates the selected Elements, or the Page when no Elements are selected, deletes the selected Elements, or the Page only once it is selected (click empty space, press Escape or choose it in the strip), and changes Element layer order. Element copies have fresh names and move 20 px down and right; Page copies keep their layout, with independent Elements and Scripts. The last Page cannot be deleted. Undo and redo cover every authored edit, including a whole drag or Info field change as one step, and restore the Project and selection exactly. Use ⌘D to duplicate, Delete or Backspace to delete, and ⌘Z / ⇧⌘Z to undo / redo (Control also works). Shortcuts leave inputs and editable text to their own keyboard handling. The selection and edits live in [`src/editing.ts`](src/editing.ts), which is tested without a DOM, and the shell that draws them in [`src/stack.ts`](src/stack.ts). Each authored Script opens in its own floating window on the [shared editor](../editor/); see [Scripts](#scripts).

The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The editor layout and Script windows: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

## Scripts

Double-click an Element to open its Script. For text, Shift-double-click opens
its Script and plain double-click edits the text. ⌘⌥-click opens any Element's
Script, including text being edited. Info also offers **Edit Script**, or
**Edit Page Script** and **Edit Project Script** when nothing is selected.
Opening a Script already on the desk brings its window forward. Each window's
Message Path links to its Page and Project Scripts.

Edits change the authored Project immediately and share its undo/redo,
autosave and portable export/import. The Script editor's ⌘/Ctrl-Z and redo
shortcuts use the same history as the Edit menu. Closing a window keeps its
Script. Renaming or reordering an owner keeps its window attached, including
through undo; deleting the owner closes its window. Opening another Project
or a stored version closes the previous Script windows. Read-only Projects
also have read-only Script editors.

Each window has a separate language-server workspace with a live Host Manifest
from [`src/script-manifest.ts`](src/script-manifest.ts). Page and Element
Scripts bind that Page's Elements, `thisPage` and `project`; every Script
also binds every Page name. The Manifests describe the planned `pages`, `elements` and `sound` Grants
from ADR 0084; `pages` is available during Play; `elements` and `sound` are not yet implemented. Renames refresh open windows' Manifests and diagnostics. Problems
show their lines below the editor and in its gutter. Completion and hover use
the Manifest; property completion for a named receiver uses its Object Kind.
The Manifest cannot yet describe `me`'s kind, so it cannot offer `me`'s
properties. Scripts execute only in Play.

### Script Recipes

Choose **Add action…** in a Script window or Info to insert a click action:
**Go to a Page**, **Show an Element**, **Hide an Element**, or **Change text**.
Navigation offers every Page. Element actions offer only the Script's own
Page; change-text targets are buttons (`label`) and text Elements (`text`).
The owning Element is the default target and is written as `me`. Project
Scripts offer navigation only. Page and Project handlers receive clicks
passed up the Message Path. Replacing text clears mixed formatting.

The picker previews ordinary NorthTalk source, highlighting the insertion.
With no click handler it creates one. For a simple existing handler, choose
**Start of handler** or **End of handler**, then preview: property changes
default to the start and navigation to the end, since navigation stops the
outgoing Page's Scripts. Guards, multiple clauses, control flow and malformed
source require placing the editor cursor explicitly and choosing **Use current
cursor and preview**. No duplicate handler is added. **Insert action** applies
one undoable edit and selects the inserted source; it remains freely editable,
with no connection to the picker. Changing the Script after preview requires
another preview.

Page names are unique across the Project. Element names are unique on their
Page and cannot collide with any Page name. Both avoid reserved words and Host
bindings (`me`, `it`, `thisPage`, `project`, `pages`, `elements`, `sound`).
Creation and rename enforce this policy. Existing conflicting Projects stay
editable and retain their names and source; Play and Recipes identify the
owners to rename in Info before continuing. Renaming does not rewrite Scripts.
Audio, timers and creating Elements are not yet offered as Recipes.

Recipe unit tests check source, literal values, target filtering, placement,
names and execution through the Play Host. Browser checks cover Info, previews,
explicit placement, selection, undo/redo, stale previews and read-only windows:

```sh
bun build tooling/creative/tests/recipes.browser.ts --outdir tooling/creative/dist --target browser
sed '/src=".\/main.js"/d' tooling/creative/dist/index.html > tooling/creative/dist/recipes-test.html
```

Open `/recipes-test.html` and run
`await import('/recipes.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`; reload before repeating.

Unit tests cover each owner's Manifest and language-server diagnostics and
completion. Browser regression checks exercise real editor windows, workers,
history, IndexedDB and portable files. With the server running:

```sh
bun build tooling/creative/tests/scripts.browser.ts --outdir tooling/creative/dist --target browser
sed '/src=".\/main.js"/d' tooling/creative/dist/index.html > tooling/creative/dist/scripts-test.html
```

Open `/scripts-test.html` and run
`await import('/scripts.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`. Reload before repeating and rebuild the
test files after an app rebuild.

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
application is named and gets its own extension, and reports the file size.
**Import Project…** in Projects opens a file picker; dropping a Project file
onto that window also imports it. Import always creates a fresh Project,
including when a copy already exists. Damaged files and newer formats report
why they cannot open and leave the current Project intact.

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

## Images and portable Projects

Choose **Image** in Tools or drop files onto the Page. PNG, JPEG, WebP, GIF
and SVG are accepted; AVIF carries a warning about older browsers. The app
identifies the format from bytes and decodes every image before changing the
Project, regardless of its extension. Files above 10 MB warn, and above
50 MB are refused. Audio import waits for sound playback.

Select an image and choose **Replace image…** in Info to change it without
changing its position or size. Adding and replacing images are undoable.
Identical bytes share one SHA-256 asset, even under different file names.
SVG is decoded and displayed only through `<img>`; image dragging and the
image context menu are disabled. The app shell also has a Content Security
Policy that disallows embedded documents and inline scripts.

Autosave writes image bytes and the model in one transaction. The session
retains bytes for undo and export after a failed save. Export drops unused
image assets without changing the editor; Projects containing Scripts retain
all assets because a Script can choose an asset by name dynamically. Import
checks image decoding too: missing or undecodable images open as named
placeholders with **Replace…**, and a notice explains the problem. Exporting
such a Project keeps its missing references so it can still be shared or
repaired.

[`src/images.ts`](src/images.ts) owns image intake and the session's bytes;
[`src/editing.ts`](src/editing.ts) records the authored image edits. Unit tests
cover detection, decode rejection, size boundaries, deduplication and undo.
Browser checks exercise real decoders, the picker and drop handlers, and an
export/delete/import round trip. Run the server, then create a dedicated test
page without the normal app boot (the suite mounts the real UI itself):

```sh
bun build tooling/creative/tests/images.browser.ts --outdir tooling/creative/dist --target browser
sed '/src=".\/main.js"/d' tooling/creative/dist/index.html > tooling/creative/dist/images-test.html
```

Open `/images-test.html` and run
`await import('/images.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`. Reload before repeating, and rebuild
both files after an app rebuild. The suite creates and removes only its own
Projects. iOS's native file picker still needs a device check; the Project
picker deliberately has no extension filter.

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
the reader flag allows plain-text input during Play Sessions.

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
Play Host uses for `the text of`. Info's plain text field also
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

## Play

Choose **Play** to start on the selected Page. Each session uses a fresh Core
Group and a disposable copy of the Project. The Project receives `startPlay`,
and the Page receives `openPage`. Click and pointer messages follow the Core's
Element → Page → Project Message Path. A touch tap sends `pointerEnter`, `click`,
then `pointerLeave`. `keyDown` reports the browser key to focused editable text,
or to the Page, without preventing normal typing. Finishing reader text editing
sends `textChanged`. Script property writes update the reader view; setting
`text` clears mixed formatting.

**Stop** or Escape stops every Script and stays in Play. Execution uses the
Core's default limits with small Pump slices between browser turns. Errors
appear as non-blocking links to the authored Script and line; other handlers
continue. Script-sent unhandled messages warn, while unhandled Host messages
are ignored. **Back to Edit** discards Play State and restores the authored
Project, selection and history. Autosave and export use authored content only.
Script windows are read-only during Play.

Use `tell pages to show page2` to navigate. The departing Page receives
`closePage` and has up to one second to finish before its Page and Element
Scripts are stopped. Its visual changes remain for this Play Session.
Revisiting reloads those Scripts with fresh variables and sends `openPage`;
the Project Script keeps running and retains its variables. Showing the current
Page does nothing. While a Page is closing, reader messages and further
navigation requests are ignored. Requests in one Pump before closing begins
use the last destination. The Pages strip stays hidden during Play.

Only the current Page's and its Elements' Scripts run alongside the Project
Script. The `elements` and `sound` Grants are not implemented yet.

### Delays with `wait`

Use `wait` in a handler to pause its Run before changing what the reader sees:

```talk
on click
  set the label of me to "Wait for it…"
  wait 3 s
  set the label of me to "Ready!"
end click
```

The browser schedules the next Pump from the Core's earliest deadline; a wait
does not block reader input, other handlers or other Scripts. A handler can
repeat an effect by waiting and then sending itself another message. No timer
Capability or additional Grant is needed.

Leaving a Page cancels its Page and Element Scripts' pending waits, including
`closePage` if it exceeds the one-second navigation deadline. The Project
Script's waits keep their deadlines across navigation. Stop, Escape and Back
to Edit cancel every Script's waits, so none can produce a late property write
or message. Revisiting a Page reloads its Scripts; returning to Play starts a
fresh session. Timers are subject to browser suspension and may resume later
than their deadline.

Play unit tests use an explicit Clock to check exact deadlines, concurrent
handlers, Page cancellation and Project continuity. The browser checks below
exercise visible delayed writes and cancellation through navigation, Stop,
Escape and Back to Edit with the real scheduler.

### Browser checks

Browser regression checks run on a dedicated page without `main.js`:

```sh
bun build tooling/creative/tests/play.browser.ts --outdir tooling/creative/dist --target browser
sed '/src=".\/main.js"/d' tooling/creative/dist/index.html > tooling/creative/dist/play-test.html
```

Open `/play-test.html` and run
`await import('/play.browser.js').then(m => m.runBrowserTests())`.
Reload before repeating; the result must have `passed: true`.
