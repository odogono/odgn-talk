# Folio

Folio is the browser creative tool specified in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. It is named in [ADR 0087](../../docs/adr/0087-the-creative-tool-is-folio-and-projects-save-as-folio-files.md); the package and folder keep their `creative` names.

Implementers and agents: start with the [task map](NAVIGATION.md); to run Folio and its tests, see [Running it](#running-it).

The page is the Stack editor shell ([#749](https://github.com/odogono/odgn-talk/issues/749)) on the last Project used, autosaved in the browser ([#752](https://github.com/odogono/odgn-talk/issues/752); see [Saving](#saving)). The Page sits on a desk at the Project's design width, scaled down to fit narrower windows. The Tools window switches between **Browse** and **Edit** (see [Play](#play)) and adds text, image, button, rectangle, ellipse and line Elements; Image opens a file picker; dropping image files on the Page adds them at the drop position (see [Images and portable Projects](#images-and-portable-projects)). The Info window edits the selected Element's name, position, size and kind's properties, or the Page's and Project's when nothing is selected. It validates names against Script bindings and Page/Element names (see [Script Recipes](#script-recipes)), and offers an available name instead, including one from a button's label. Click selects an Element, Shift-click selects several, and clicking empty space selects the Page. Drag Elements to move them, drag a handle to resize, and use the arrow keys to nudge, with Shift for 10 px. The strip of Pages adds, shows and reorders Pages by dragging. Windows are dragged by their title bars and stay where they're put. Every window shares one title bar with a close box ([`src/windows.ts`](src/windows.ts)), and Info, Script windows and the Message Box resize from their bottom-right corner; the **Window** menu shows and hides Tools, Info, the Message Box and Errors, with a tick beside each one showing, and a closed Tools or Info window stays closed after a reload. The header's **Folio** menu opens About Folio, and the **File** menu holds **New Project**, **Import Project…**, **Projects…**, **Earlier Versions…** and, where the browser can save to disk, **Save** and **Save As…**. The Edit menu duplicates the selected Elements, or the Page when no Elements are selected, deletes the selected Elements, or the Page only once it is selected (click empty space, press Escape or choose it in the strip), and changes Element layer order. Element copies have fresh names and move 20 px down and right; Page copies keep their layout, with independent Elements and Scripts. The last Page cannot be deleted. Undo and redo cover every authored edit, including a whole drag or Info field change as one step, and restore the Project and selection exactly. Use ⌘D to duplicate, Delete or Backspace to delete, and ⌘Z / ⇧⌘Z to undo / redo (Control also works). Shortcuts leave inputs and editable text to their own keyboard handling. The selection and edits live in [`src/editing.ts`](src/editing.ts), which is tested without a DOM, and the shell that draws them in [`src/stack.ts`](src/stack.ts). Each authored Script opens in its own floating window on the [shared editor](../editor/); see [Scripts](#scripts).

The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The editor layout and Script windows: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

## Page size

Click empty space on the Page or desk, or press Escape, to select the Page.
Drag either side handle to change the Project's shared design width, the
bottom handle to change only this Page's height, or a bottom corner for both.
The Page stays horizontally centred with its top fixed; there are no top
resize handles. Existing Elements keep their positions and sizes.
The minimum is 240 pixels wide and 160 pixels high, in both handles and Info.
Each drag is one undoable edit and autosaves with the Project. Handles are
hidden while an Element is selected, in read-only Projects and during a Play
Session.
Focused handles also accept arrow keys, with Shift for ten pixels.

Browser regression checks cover handles, pointer and keyboard resizing,
centering, minimums, history and read-only states.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Open `/page-resize-test.html` and run
`await import('/page-resize.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`; repeat at a narrow viewport to check
scaled Pages. Reload before repeating and rebuild after an app rebuild.

## Scripts

Double-click an Element to open its Script. For text, Shift-double-click opens
its Script and plain double-click edits the text. ⌘⌥-click opens any Element's
Script, including text being edited. Info also offers **Edit Script**, or
**Edit Page Script** and **Edit Project Script** when nothing is selected.
Opening a Script already on the desk brings its window forward. Each window's
Message Path links to its Page and Project Scripts.
Drag the bottom-right corner to resize a Script window; the editor grows and
shrinks with it and scrolls long Scripts within the window.

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
also binds every Page name. The Manifests describe the `pages`, `elements` and `sound` Grants
from ADR 0084, the `user` Standard Capability, and the `folio` Grant of `hide` and `show` (see [Play](#play)); all five are available during Play (see [Sounds](#sounds) and [Asking the reader](#asking-the-reader)). Renames refresh open windows' Manifests and diagnostics. Problems
show their lines below the editor and in its gutter. Completion and hover use
the Manifest; property completion for a named receiver uses its Object Kind.
The Manifest cannot yet describe `me`'s kind, so it cannot offer `me`'s
properties. Scripts execute only in a Play Session (see [Play](#play)).
The Manifests include built-in events and each Script's authored message
handlers, so custom messages between Scripts do not produce unknown-message
hints. Editing handlers refreshes the Manifest alongside the source.

### Script Recipes

Choose **Add action…** in a Script window or Info to insert a click action:
**Go to a Page**, **Show an Element**, **Hide an Element**, **Change text**,
**Play a sound**, **Loop a sound** or **Stop a sound**.
Navigation offers every Page. Element actions offer only the Script's own
Page; change-text targets are buttons (`label`) and text Elements (`text`).
The owning Element is the default target and is written as `me`. Sound
actions offer the Project's sounds by the name Scripts use; **Stop a sound**
also offers all sounds the Script started. Project Scripts offer navigation
and sounds. Page and Project handlers receive clicks
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
Creating Elements is not yet offered as a Recipe; delays use `wait` in
source (see [Delays with `wait`](#delays-with-wait)).

Recipe unit tests check source, literal values, target filtering, placement,
names and execution through the Play Host. Browser checks cover Info, previews,
explicit placement, selection, undo/redo, stale previews and read-only windows.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Open `/recipes-test.html` and run
`await import('/recipes.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`; reload before repeating.

Unit tests cover each owner's Manifest and language-server diagnostics and
completion. Browser regression checks exercise real editor windows, workers,
history, IndexedDB and portable files.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

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
**Earlier Versions…** in the File menu lists each kept version's time and Page count:
**Preview** shows it read-only on the desk, and **Restore this version**
writes it as the newest version, so the restore can itself be undone by
restoring the version that was newest before it.

**Projects…** in the File menu lists every stored Project, most recently changed first, and
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
works in memory. Export now downloads a `.folio` Project file and reports
its size. Import reads the content, not the name, so `.zip` files exported
before the app was named still open.
**Import Project…** in the File menu opens a file picker; dropping a Project
file onto the Projects window also imports it. Import always creates a fresh Project,
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
IndexedDB, Web Locks and BroadcastChannel.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Then run `await import('/storage.browser.js').then(m => m.runBrowserTests())`
in the browser console on Folio's page, `/`. Every result must have
`passed: true`. As with the rich-text bundle below, rebuild it after the
watch server rebuilds the app.

## Offline, installing and files on disk

Once Folio has loaded, a service worker keeps the whole app — the page,
its styles, the editor and Play — so authoring and Play work with the
network off and no backend ([#823](https://github.com/odogono/odgn-talk/issues/823);
sections 7–8 of [the storage research](../../docs/research/creative-tool-project-storage.md)).
Projects themselves stay in IndexedDB as above, never in the cache. The
build stamps the worker with its shell list and a version hashed from
the shell's contents, so an unchanged rebuild keeps the installed
worker. A changed shell installs beside the running one and waits: a
banner offers **Reload to update**, which flushes autosave before the
page reloads, so an update never lands mid-edit. While the network is
off a banner says so; work keeps saving in the browser.

The web app manifest ([`static/folio.webmanifest`](static/folio.webmanifest))
carries the names from [ADR 0087](../../docs/adr/0087-the-creative-tool-is-folio-and-projects-save-as-folio-files.md)
and icons the build draws from [`tools/icons.ts`](tools/icons.ts), so
browsers offer to install Folio. The Projects window explains
installing in the browser at hand — an **Install Folio** button where
the browser allows one, Share then Add to Home Screen on iPhone and
iPad — and says when Folio is already installed. Installing matters
beyond the icon: Safari keeps an installed web app's data, where an
uninstalled site's can be deleted after a week away (see
[Saving](#saving)).

The manifest also registers `.folio` files, with the media type
`application/vnd.odgn.northtalk-project+zip`, so an installed Folio
opens a Project file from the operating system (desktop Chrome and
Edge; the file handlers API is theirs today). Such a file imports like
any other, as a fresh Project that never overwrites the one on the
desk, and keeps its handle: where the browser has the File System
Access pickers, the File menu offers **Save** and **Save As…**. Save
writes back to the opened file — or to the file Save As chose — asking
for permission again when the browser kept only a prompt, and
refusing, with Save As suggested, when the file changed on disk since
it was opened. A file this app cannot open, such as a newer format,
never gains a handle, so it can never be overwritten. Handles are kept
in IndexedDB beside their Projects, with the stamp of what was on
disk. Files opened through **Import Project…** or dropped on the
Projects window keep their handles too, where the browser gives one.

Where none of that exists — Firefox and Safari today — nothing
pretends otherwise: there is no Save, **Export** downloads the `.folio`
copy and **Import** opens it, and the Projects window says exactly
that.

[`src/sw.ts`](src/sw.ts) is the worker, [`src/offline.ts`](src/offline.ts)
registers it and owns the update, offline and install UI, and
[`src/file-access.ts`](src/file-access.ts) owns the pickers, permission
and save checks. Their logic takes the browser objects it uses as
arguments, so unit tests drive it with fakes: precaching, updates
waiting, offline serving, permission prompts and refusals. The build
test checks the manifest, icons and stamped worker. Browser checks use
the real worker, cache and manifest, on the normal page.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Then run `await import('/offline.browser.js').then(m => m.runBrowserTests())`
in the browser console on Folio's page, `/`. Every result must have
`passed: true`. Accepting an actual update, tapping Install, opening a
`.folio` file from the OS and granting save permission still need a
person at a real browser — the checks above cannot press those for you.

## Images and portable Projects

Choose **Image** in Tools or drop files onto the Page. PNG, JPEG, WebP, GIF
and SVG are accepted; AVIF carries a warning about older browsers. The app
identifies the format from bytes and decodes every image before changing the
Project, regardless of its extension. Files above 10 MB warn, and above
50 MB are refused. Sounds have their own intake; see [Sounds](#sounds).

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
export/delete/import round trip, on a test page without the normal app boot
(the suite mounts the real UI itself).

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Open `/images-test.html` and run
`await import('/images.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`. Reload before repeating, and rebuild
both files after an app rebuild. The suite creates and removes only its own
Projects. The Project picker deliberately has no extension filter, so `.folio` files
stay pickable on iOS; the device checks behind that are recorded in
[the storage research](../../docs/research/creative-tool-project-storage.md#device-checks-from-739-recorded-for-822).

## Sounds

With no Element selected, Info lists the Project's sounds and offers
**Add sound…** and a **Preview** for each. MP3, AAC (`.m4a` or `.aac`) and
WAV are accepted, identified from their bytes and trial-decoded before the
Project changes, with the same size limits as images: warn above 10 MB,
refuse above 50 MB. WAV also warns that it is uncompressed. A sound's
Script name is its file name without the extension, so `waves.mp3` is played
as `"waves"`; identical bytes share one asset, and adding a sound is one
undoable edit. Sounds autosave and export like images: one zip entry per
SHA-256, kept on export whenever the Project has Scripts, which may choose a
sound by name dynamically. A missing or undecodable sound stays in the asset
table as a placeholder; importing reports it, and playing it in Play is a
Script error naming the sound.

Every Script gets the `sound` Grant during Play:

```talk
tell sound to play "waves"
tell sound to loop "rain"
tell sound to stop "rain"
tell sound to stop
```

A sound belongs to the Script that started it (#735), and `stop` reaches
only that Script's sounds — with no name, all of them. Playing a name the
Project has no sound for is an error against the Script and line. Leaving a
Page stops its Page and Element Scripts' sounds; the Project Script's sounds
carry on across navigation. Stop and Escape stop all audio at
once (ADR 0086), as does deleting an Element whose Script started a sound.
Replaying a name restarts that Script's voice for it. Script Recipes offer
**Play a sound**, **Loop a sound** and **Stop a sound** for every owner.

[`src/sounds.ts`](src/sounds.ts) owns sound intake, the per-session
`SoundBoard` of playing voices and the browser `<audio>` backend; Play wires
the Grant in [`src/play.ts`](src/play.ts), stopping each owner's voices with
its Scripts. Unit tests cover sniffing, decode refusal, size limits,
ownership, the Page-leave, Stop and delete lifecycle, Recipes and the
export/import round trip. Browser checks exercise the real decoder and
picker with a WAV made in memory.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Open `/sounds-test.html` and run
`await import('/sounds.browser.js').then(m => m.runBrowserTests())`.
Every result must have `passed: true`. Reload before repeating, and rebuild
both files after an app rebuild. Which browsers play WAV, and why the
Project picker has no extension filter, are recorded in
[the storage research](../../docs/research/creative-tool-project-storage.md#device-checks-from-739-recorded-for-822).

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
the reader flag allows rich-text input during Play Sessions (see [Play](#play)).

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
IME composition and the toolbar.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Then run `await import('/rich-text.browser.js').then(m => m.runBrowserTests())`
in the browser console on Folio's page, `/`. Every result must have
`passed: true`. Rebuild this test bundle after the watch server rebuilds the app.

## Running it

From the repository root, with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run creative                       # serves at http://127.0.0.1:3928/ and rebuilds on change
bun run --cwd tooling/creative start   # serves one minified build, never rebuilt
bun run --cwd tooling/creative build   # a static dist/ any web server can host
bun test tooling/creative/tests
```

### Browser test suites

With the server running, one command rebuilds the app and every
`tests/*.browser.ts` suite into `dist/`, with a `<suite>-test.html` page
without `main.js` for each suite that mounts the UI itself:

```sh
bun run --cwd tooling/creative build:browser-tests
```

It prints each suite's page: `/<suite>-test.html`, or `/` for `offline`,
`rich-text` and `storage`. The watch server empties `dist/` whenever it
rebuilds the app, so run it again after an app rebuild.

Once `/` has loaded, the [service worker](#offline-installing-and-files-on-disk)
controls the whole origin, test pages included: it answers every
navigation with its cached `index.html` and serves the shell, `main.js`
included, from the build it cached. Before running a suite, unregister it
and clear its caches from the console of any page on the origin, then open
the suite's page in a fresh tab, one tab per suite:

```js
for (const r of await navigator.serviceWorker.getRegistrations())
  await r.unregister();
for (const name of await caches.keys()) await caches.delete(name);
```

Running a suite on `/` registers the worker again.

## Play

There are two ways to run a Project, both on the Page being edited
([ADR 0093](../../docs/adr/0093-folio-browses-in-place.md)). **Browse**, at
the top of the Tools window, plays the Page in place on the desk with the
Tools, Script and Errors windows still open (the Edit menu offers only Undo and Redo, for Script edits), as HyperCard's browse tool did.
**Present**, in the header, plays it full-window with the editor hidden. Each session uses a fresh Core
Group and a disposable copy of the Project. The Project receives `startPlay`,
and the Page receives `openPage`. Click and pointer messages follow the Core's
Element → Page → Project Message Path. A touch tap sends `pointerEnter`, `click`,
then `pointerLeave`. `keyDown` reports the browser key to focused editable text,
or to the Page, without preventing normal typing. A key sent to the Page when
a `keyDown` Handler is on its Message Path loses its browser default, so arrow
keys and space drive a game rather than scroll; with no such Handler they
scroll as usual. Reader-editable text opens
the formatting toolbar on focus: select text for bold, italic, underline or
colour, or use Clear, Paragraph, Undo and Redo. Done hides the toolbar; focusing
the text again reopens it. Typing, formatting, paste and reader undo/redo send
`textChanged` to the Element after updating its text, so handlers read the new
plain text through `the text of me`. IME composition commits at its end.
Clipboard HTML uses the same supported marks and paragraphs as authored text;
unsupported content is discarded.

Reader text and its undo history belong only to the Play Session. Navigation
retains the text and formatting; Stop restores the authored content and
formatting exactly, and another session starts fresh. Script replacements reset
that Element's reader undo history. Script property writes update the reader view; setting
`text` clears mixed formatting.

Choosing **Edit** in Tools, choosing an Element tool, or pressing Escape on
the desk ends browsing; while presenting, the header's **Present** button
becomes **Stop**, and Stop or Escape ends it. Either way every Script and
sound stops, Play State is discarded and Edit returns with the authored
Project and history restored. Browsing returns to the Page the session
reached; presenting restores the selection too. Execution uses the
Core's default limits with small Pump slices between browser turns.
Autosave and export use authored content only.

Script windows stay editable while browsing. An edit changes the authored
Project immediately and applies from the next session; the running session
keeps the Scripts it loaded. Escape inside a Script window stays with the
editor. Script windows are read-only while presenting.

Problems go to the **Errors** window, which opens when the first one arrives.
Each names its owner and line and opens that authored Script; other handlers
continue. Script-sent unhandled messages warn, while unhandled Host messages
are ignored. Script names that cannot be bound are listed there instead of
starting a session. The list outlasts the session and is cleared by **Clear**,
by the next session or by opening another Project.

**Message Box** in the Window menu opens a one-line NorthTalk prompt, as in
HyperCard. Press Enter to run a command, such as
`set the visible of button1 to false`, or an expression, such as
`the label of button1`, whose value is printed; Up and Down recall earlier
lines. While browsing, commands run in the Play Session with the showing
Page's names and every Grant, and their effects are Play State. In Edit, the
command runs in a session copied from the Project that sends no events; when
it finishes, its changes become one undoable authored edit, Script windows
stay attached, and a navigation moves the editor to that Page. A failing
command changes nothing and prints its error and line; waits and `user`
prompts only run while browsing. [`src/message.ts`](src/message.ts) holds the logic, tested without a
DOM.

The Message Box is a code window like a Script's, built from the same parts in
[`src/code-window.ts`](src/code-window.ts): it resizes from its corner, and its
editor has the same completion (⌃Space), hover and diagnostics for the Page's
names. The editor holds the whole Script a command runs as, with the lines
around the command hidden and protected.

HyperTalk-style `hide welcomeText` and `show welcomeText` are Host Commands
([ADR 0094](../../docs/adr/0094-host-commands-are-command-call-spellings-of-granted-operations.md)):
the `hide` and `show` Operations of the `folio` Grant, marked `command`, which
every Script and every Message Box command gets, so any of them can call
them by name without an import, as `tell folio to hide welcomeText` would.
Each takes one Element and sets its `visible`, as a fire-and-forget call in
the caller's Run that costs 1 Fuel and leaves `it` unchanged. An argument
that isn't an Element, as in `hide 42`, is an error at the calling line: a
literal is refused when the Script loads, and any other value fails the call
and stops the calling Handler, reported on that line in Errors or in the
Message Box. A Script's own `on hide` Handler takes that Script's `hide`
calls, and the editor Lints it as `shadowed-host-command`, but an Element's
`hide` never reaches its Page or Project Script, so they can't intercept it.
Each Script's Manifest declares the `folio` Grant with both Operations'
documentation, so the Script editor completes them, hovers their
documentation and checks their arguments as the Core does.

Use `tell pages to show page2` to navigate. The departing Page receives
`closePage` and has up to one second to finish before its Page and Element
Scripts are stopped. Its visual changes remain for this Play Session.
Revisiting reloads those Scripts with fresh variables and sends `openPage`;
the Project Script keeps running and retains its variables. Showing the current
Page does nothing. While a Page is closing, reader messages and further
navigation requests are ignored. Requests in one Pump before closing begins
use the last destination. The Pages strip and Info window stay hidden during a
Play Session.

Only the current Page's and its Elements' Scripts run alongside the Project
Script. Sounds a Page's Scripts started stop when the reader leaves that
Page; sounds the Project Script started keep playing (see [Sounds](#sounds)).

### Dynamic Elements

Every Script can use `elements` during Play:

```talk
ask elements to create "button", thisPage, "trapdoor"
set the label of it to "Open trapdoor"
ask elements to clone climbButton
tell elements to delete climbButton
ask elements to find "door", cellar
```

`create` supports all six Element kinds with the editor's default properties.
Its optional name must be an available Script identifier; omission picks a
fresh name such as `button1`. Created Elements have no Script, so messages
follow their Page and Project's Handlers. `clone` copies the current properties
and Script onto the same Page, with a fresh name and a 20 px position offset.
Its Script attaches after the creating Pump, or when its Page next opens if
that Page is not showing. Clone errors link to the authored source Script.

`delete` removes an Element and stops its Script, including a Script deleting
itself. Old handles become disposed; reusing a deleted name creates a distinct
Element. `find` requires the Page and reports an error when the name is missing.
Names are bound when Scripts load; use `find` or the returned handle to reach
new Elements. Creating, cloning and deleting each consume a Pump's Fuel budget
so Core parent/disposal changes land before execution continues. All changes
are temporary Play State: Stop restores the authored Elements exactly.

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

For animation and games, declare an `on frame elapsed` Handler
([ADR 0095](../../docs/adr/0095-folio-delivers-a-frame-message-to-scripts-that-handle-it.md)).
Folio sends `frame` once per displayed frame, straight to each Script that
declares it, never up the Message Path; `elapsed` is the whole milliseconds
since that Script's previous `frame`, 0 on its first. A Script whose last
`frame` Run is still running or waiting skips frames until it ends, and its
next `elapsed` covers the gap. Frames stop when the reader leaves the Script's
Page, pause while the tab is hidden and never run in Edit:

```talk
script variable sinceMove = 0
on frame elapsed
  add elapsed to sinceMove
  if sinceMove >= 500 then
    put 0 into sinceMove
    set the left of ball to the left of ball + 10
  end if
end frame
```

Leaving a Page cancels its Page and Element Scripts' pending waits, including
`closePage` if it exceeds the one-second navigation deadline. The Project
Script's waits keep their deadlines across navigation. Stop, Escape and Back
to Edit cancel every Script's waits, so none can produce a late property write
or message. Revisiting a Page reloads its Scripts; returning to Play starts a
fresh session. Timers are subject to browser suspension and may resume later
than their deadline.

Play unit tests use an explicit Clock to check exact deadlines, concurrent
handlers, Page cancellation and Project continuity. The browser checks below
exercise visible delayed writes and cancellation through navigation, Stop
and Escape with the real scheduler.

### Asking the reader

Every Script, and every Message Box command while browsing, gets Chapter 7's
`user` Grant ([#1026](https://github.com/odogono/odgn-talk/issues/1026)):

```talk
on click
  ask user to confirm "Start again?" and wait
  if not it then return
  ask user to choose ["Red", "Blue"], {prompt: "Pick a colour"} and wait
  if it is nothing then return
  set the fill of me to it
  ask user to enter "Your name", {default: "Reader"} and wait
  tell user to notify "Hello, " & it, {title: "Welcome"}
end click
```

`confirm`, `choose` and `enter` show a dialog over the Page and suspend only
the Run that asked. OK answers; Cancel or Escape gives `false` to `confirm`
and Nothing to `choose` and `enter`, and Escape in a dialog doesn't leave
Play. `choose` shows radio buttons, or checkboxes with `multiple: true`.
`notify` shows a notice at the top of the Page for a few seconds and waits for
nobody.

One Script can have one prompt waiting: its next `confirm`, `choose` or
`enter` fails with `user busy`. Prompts from different Scripts queue and are
shown oldest first. A prompt whose Run ends without an answer, by a Timeout
Block, leaving its Page, Stop, Escape or Back to Edit, is taken down. The
prompts live on the Play Session in [`src/play.ts`](src/play.ts), tested
without a DOM, and the dialog in [`src/play-prompts.ts`](src/play-prompts.ts).

### Browser checks

Browser regression checks run on a dedicated page without `main.js`.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Open `/play-test.html` and run
`await import('/play.browser.js').then(m => m.runBrowserTests())`.
Reload before repeating; the result must have `passed: true`. After another
reload, run `await import('/play.browser.js').then(m => m.runElementsBrowserTests())`
for dynamic creation, cloned Scripts, deletion, name reuse and Edit restoration.
After another reload, run `await import('/play.browser.js').then(m => m.runUserBrowserTests())`
for `user` prompts, notices, Escape and Cancel, and Stop taking a prompt down.
After another reload, run `await import('/play.browser.js').then(m => m.runMessageBoxBrowserTests())`
for the Message Box.

Reader text unit tests cover formatting, `textChanged`, isolation, undo/redo,
Script replacements and disabled input. The browser suite also checks real
selections, colour focus, clipboard sanitization, paragraphs, IME, navigation,
Stop while editing and the exact authored rich-text restore.

At narrower widths the reader scales the Page to fit and scrolls only
vertically: a scaler element carries the scaled size, as the editor's
stage does, and the presenting header drops its Edit-only controls so Stop
stays reachable on a phone.

## Example Projects

The Projects window lists Folio's Example Projects, from
[`src/examples/index.ts`](src/examples/index.ts). Opening one adds a fresh,
editable copy, never overwriting the Project on the desk; its assets are
decoded first, like an import. To add one, write a builder beside the others
returning the Project and its asset bytes, list it in `EXAMPLE_PROJECTS`, and
[`examples.test.ts`](tests/examples.test.ts) checks that it builds and starts
playing cleanly.

### The Lighthouse Mystery

**Projects → Open The Lighthouse Mystery** adds a fresh copy of
[#154](https://github.com/odogono/odgn-talk/issues/154)'s acceptance
example ([#824](https://github.com/odogono/odgn-talk/issues/824)): a
three-Page illustrated mystery with a reader-editable journal, built as
a non-programmer would. Its navigation, show/hide, text and sound
actions are the exact source Script Recipes insert; only what Recipes
do not offer — clue messages to the Project Script (which remembers
both clues across Pages), a `wait`, and creating the trapdoor button
whose click the Page Script answers through the Message Path — is
written by hand, as an author would after inserting a Recipe. The
illustrations are SVG and the bell and waves are generated WAV, all
from [`src/examples/lighthouse.ts`](src/examples/lighthouse.ts), so it
exports, reopens offline and plays the same anywhere.

Unit tests play the mystery end to end against the Play Host —
including that the ending stays locked without both clues, that
leaving the lamp room early cancels its `wait`, and that the exported
file reopens and plays — and browser checks play it by touch taps at a
phone width.

Build it with the other suites (see [Browser test suites](#browser-test-suites)).

Open `/lighthouse-test.html` and run
`await import('/lighthouse.browser.js').then(m => m.runBrowserTests())`.
The result must have `passed: true`; reload before repeating.

### Tetris

**Projects → Open Tetris** adds the falling-blocks game
([#1114](https://github.com/odogono/odgn-talk/issues/1114)), built from
[`src/examples/tetris.ts`](src/examples/tetris.ts). The board is 200
rectangles, `cell_1_1` to `cell_20_10`, and a 4×4 `next_` grid previews the
next piece; all are drawn in advance, and while playing the Page Script only
changes their fills. The whole game is that one Page Script, in Handlers
split by concern: `frame` adds up `elapsed` for gravity, `keyDown` moves,
turns and drops, and `fits`, `tryMove`, `rotate`, `lockPiece`, `clearLines`
and `paint` keep the board as a list of lists. `paint` changes only the
rectangles whose colour differs from what they show.

Arrow keys move, Up and Z turn, Down drops faster and Space drops. Pieces
come from a 7-bag. Gravity starts at one row a second and speeds up by 75 ms
each level, down to 100 ms; the level rises every ten lines, and one to four
lines score 100, 300, 500 or 800 times the level. There are no wall kicks,
hold or ghost piece. Pieces come from `random`.

It is dressed as a game on a colour Macintosh running System 7: a menu bar on
a periwinkle desktop, a platinum window with a pinstriped title bar and close
box, Chicago and Geneva type where the browser has them, pieces in the
classic 16-colour palette, and a bomb alert for Game Over. All of it is
ordinary rectangles, lines and text.

Unit tests drive the game on an explicit clock through `frame` and `keyDown`:
spawning, moving, turning, gravity, drops, a four-line clear, a level-up and
game over. Open `/tetris-test.html` and run
`await import('/tetris.browser.js').then(m => m.runBrowserTests())`.
