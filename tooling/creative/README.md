# Folio

Folio is the browser creative tool specified in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. It is named in [ADR 0087](../../docs/adr/0087-the-creative-tool-is-folio-and-projects-save-as-folio-files.md); the package and folder keep their `creative` names.

Implementers and agents: start with the [task map](NAVIGATION.md); to run Folio and its tests, see [Running it](#running-it).

The page is the Stack editor shell ([#749](https://github.com/odogono/odgn-talk/issues/749)) on the last Project used, autosaved in the browser ([#752](https://github.com/odogono/odgn-talk/issues/752); see [Saving](#saving)). The Page sits on a desk at the Project's design width, scaled down to fit narrower windows. The Tools window switches between **Browse** and **Edit** (see [Play](#play)) and adds text, image, button, rectangle, ellipse, line and canvas Elements (see [Canvas](#canvas)); Image opens a file picker; dropping image files on the Page adds them at the drop position (see [Images and portable Projects](#images-and-portable-projects)). The Info window edits the selected Element's name, position, size and kind's properties, or the Page's and Project's when nothing is selected. It validates names against Script bindings and Page/Element names (see [Script Recipes](#script-recipes)), and offers an available name instead, including one from a button's label. Click selects an Element, Shift-click selects several, and clicking empty space selects the Page. Drag Elements to move them, drag a handle to resize, and use the arrow keys to nudge, with Shift for 10 px. The strip of Pages adds, shows and reorders Pages by dragging. Windows are dragged by their title bars and stay where they're put. Every window shares one title bar with a close box ([`src/windows.ts`](src/windows.ts)), and Info, the Code Browser and the Message Box resize from their bottom-right corner; the **Window** menu shows and hides Tools, Info, the Code Browser, the Message Box, Errors and Performance, with a tick beside each one showing, and a closed Tools or Info window stays closed after a reload. The header's **Folio** menu opens About Folio, and the **File** menu holds **New Project**, **Import Project…**, **Projects…**, **Earlier Versions…** and, where the browser can save to disk, **Save** and **Save As…**. The Edit menu duplicates the selected Elements, or the Page when no Elements are selected, deletes the selected Elements, or the Page only once it is selected (click empty space, press Escape or choose it in the strip), and changes Element layer order. Element copies have fresh names and move 20 px down and right; Page copies keep their layout, with independent Elements and Scripts. The last Page cannot be deleted. Undo and redo cover every authored edit, including a whole drag or Info field change as one step, and restore the Project and selection exactly. Use ⌘D to duplicate, Delete or Backspace to delete, and ⌘Z / ⇧⌘Z to undo / redo (Control also works). Shortcuts leave inputs and editable text to their own keyboard handling. The selection and edits live in [`src/editing.ts`](src/editing.ts), which is tested without a DOM, and the shell that draws them in [`src/stack.ts`](src/stack.ts). The Code Browser selects and edits every authored Script and Library on the [shared editor](../editor/); see [Scripts](#scripts).

Edit and each Play Session own separate persistent [`ProjectTree`](src/tree/project-tree.ts)
instances. The tree owns Project mutations, hierarchy, indexed collections,
geometry and copy-work accounting. Its views use the local [`DeepReadonly`](src/readonly.ts) TypeScript contract
and remain live; use explicit operations to change them and `snapshot()` when
retaining an earlier value or crossing an asynchronous boundary. Live nodes
keep their identity during ordinary edits; reacquire collections after structural
changes. The editor keeps selection, showing Page and entered scope separately,
adapts batched tree changes to signals, folds incoming field changes incrementally,
and detaches the completed forward/inverse journal for undo. The tree publishes
synchronous change payloads; consumers retaining durable history use
[`detachJournal`](src/tree/history.ts). Field values are replaced atomically,
so pending history can retain its endpoints until the edit finishes.
Copy-work accounting is enabled only for Play. Renames update the affected name
entries, structural edits index the changed subtree, and geometry stages the
moved subtree and its ancestor bounds. The [write benchmark](tools/bench-project-tree.md)
measures large-Page drag and typing bursts and checks their copy budget.
A whole drag or Info field edit remains one undo step. Finishing any edit
at its starting content preserves redo. Pages and Elements have stable
session-local IDs across history; IDs never enter `.folio` files or browser
storage. The ownership and notification choices are recorded in
[ADR 0106](../../docs/adr/0106-folio-edit-and-play-share-a-mutable-project-tree.md).

The Project title, [Info panel](src/info-panel.tsx),
[Page strip](src/page-strip.tsx), [Edit menu](src/edit-menu.tsx) commands
and the [Projects window's lists](src/projects-window.tsx) are Preact components
written in TSX, observing signals through `@preact/signals`. Live
edits, undo/redo and Project loads update them independently of the shell
redraw. Info reconciles its controls in place, keeping focus, caret, selection
and composing text while the Page and strip update. Its read-only state disables
authored edits while leaving Script viewing and sound previews available. The
app and browser-test builds compile imported TSX with Preact's automatic JSX
runtime. Each strip miniature is memoised by its Page rendering revision, asset revision
and design width, with session-local Page ids keeping it attached across reorders.
Editing one Page redraws only its miniature; navigation and unrelated Project
edits retain all miniatures. The Edit menu enables each command from the
selection, the undo history, read-only state and the Play mode.

The [Errors window](src/errors.tsx) is a Preact component too. It renders a
signal holding the reported problems, each labelled with its owner and line
when it was reported. New problems are appended without rebuilding the earlier
ones, and a problem whose owner has left the Project is disabled when opened.
The notice, save, storage, read-only, orphan, update and offline banners stay
direct DOM: each sets its text and toggles `hidden`, with nothing to rebuild.

The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The original editor layout: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

Group Elements compose ordinary Elements and other groups; see [Grouping Elements](#grouping-elements). Their rationale is [ADR 0103](../../docs/adr/0103-folio-groups-are-nested-elements-with-page-wide-names.md).

Rectangle and ellipse borders have a writable `thickness` in pixels, named
like a line's thickness. Set **Thickness** in Info, or use
`set the thickness of box to 1` in a Script. Zero removes the border;
negative or non-finite values are invalid. New shapes and older Projects
without the property use 2 px. The width is saved in `.folio` files and browser
storage, and renders in Edit, Browse and Present. Info edits participate in
undo/redo; Script changes last only for the Play Session. The
[`borders` browser suite](tests/borders.browser.ts) checks Info, history and
Script-driven rendering on `/borders-test.html` (see
[Browser test suites](#browser-test-suites)).

Buttons have writable `font`, `textSize` (positive pixels) and `style`
properties in Info and Scripts. The named styles are `rounded` (the default),
`rectangle` (square corners and a 1 px border), `shadowed` (rectangle with a
3 px offset shadow), and `transparent` (an invisible hit area). Borders and
shadows use `textColor`; visible styles use `fill` for the background.
For example, `set the style of door to "transparent"` makes a button over a
picture clickable without drawing its fill, border, shadow or label.
Transparent buttons show a dashed outline in Edit and keep receiving `click`,
`pointerEnter` and `pointerLeave` in Browse and Present. Tab focuses them with
a visible focus ring; Enter and Space activate them. Keep a descriptive
`label`: it supplies the button's accessible name (or its Element name when
the label is empty), including when invisible.

Button typography and styles are saved in `.folio` files and browser storage.
New buttons and older Projects without these properties use the previous
rounded look, system font and 18 px text. Info changes participate in undo/redo;
Script changes last only for the Play Session. The
[`buttons` browser suite](tests/buttons.browser.ts) checks Info, history,
invisible hit targets, keyboard input and Script-driven rendering in Browse
and Present on `/buttons-test.html`. The
[`sonar` browser suite](tests/sonar.browser.ts) checks on `/sonar-test.html`
that an idle animated Page changes no reader DOM.

## Grouping Elements

Select two or more siblings and choose **Edit → Group** (⌘/Ctrl-G).
The new named Group Element selects, moves, duplicates and deletes as one.
Double-click to enter it and edit its immediate members; nested groups can be
entered one level at a time. Escape finishes text editing first, then exits one
level and selects that group. Clicking outside or changing Pages returns to
Page scope. The caption shows the entered path. Modified Script-opening clicks
and Info open the group's own Script. Empty groups retain a small selection
marker in Edit.

While inside a group, newly drawn or inserted Elements join it; Duplicate and
layer commands operate among its immediate members. Selection does not cross
parents. Choose **Edit → Ungroup** (⇧⌘/Ctrl-G) to dissolve selected groups one
level, keeping member names, identities, coordinates and layer order. Ungroup
removes the group's own Script; Undo restores it. Ungrouping a hidden group
makes its immediate members individually hidden to preserve the appearance.
Group, Ungroup, Duplicate, Delete and each drag are single undo steps, including
the entered-group context and selection. Membership is reorganized through
Group and Ungroup; drag reparenting and Element clipboard copy/paste are not
supported.

Coordinates remain Page-relative even inside groups. Moving a group translates
every descendant once. Its bounds are derived from its members, including
hidden members and empty child groups' retained positions. Width and height are
read-only; group resizing, scaling and clipping are not supported. Grouping
preserves member order and places the composite at the frontmost selected layer:
for back-to-front A, B, C, grouping A and C brings A in front of B.

Groups and all descendants share the Page's identifier namespace, so existing
Script bindings continue to work. A group can own a Script: member messages
follow member → containing groups → Page → Project, retaining the original
`the target`. During Play, groups have no background or independent hit area;
gaps pass input to what lies beneath. Hidden groups suppress their members'
display and reader input, while their Scripts and frames continue. `hide panel`
and `show panel` change only the group's own visibility, preserving each
member's individual `visible` flag.

Duplicate and runtime `elements.clone` copy the whole subtree with fresh names
and identities, and one overall 20 px offset, as a sibling of the original.
Script source is copied unchanged: named references to original members still
address those originals; `me` and positional member references can address the
copy. Deleting a group removes all descendants, stops their Scripts and sounds,
and disposes their handles. Deleting the final member leaves the empty group,
its Script and position intact, with zero width/height. Scripts can clone and
delete groups but cannot create groups, ungroup or reparent members;
`elements.create` still adds ordinary Elements directly to a Page.

Each outermost group permits at most 1,024 Elements, including itself and nested
groups, and at most 32 group levels. Independent Page Elements have no shared
count ceiling. Import, authoring and cloning enforce these limits before
publishing changes. Script geometry writes declare 8,192 Fuel to cover bounded
geometry preflight and ancestor updates; other writable Element properties
declare 256 Fuel for bounded cache maintenance along group ancestors. Clone/delete obtain additional
size-dependent Fuel before effects, including copied content. Invalid or
unaffordable moves, clones and deletes leave the operation unapplied. Collection
callbacks use maintained indexes, each costing 1 Fuel and 0 allocation.

Projects save as `.folio` format 4, with ordered nested members, Page-relative
leaf coordinates, retained empty-group positions, Project Library source and
Test Scripts. Bounds, lookup indexes and session ids are derived rather than
saved. Existing format-1 and format-2 Projects migrate with an empty Library
collection, and format-3 Projects with no Test Scripts. Browser storage and
earlier versions use the same representation. Older Folio readers refuse
format 4 instead of silently dropping Test Scripts.

The `groups` unit and browser suites cover authoring, history, nested geometry,
collections, visibility, routing, persistence, limits and failure atomicity.
Tetris's window frame and Game Over alert use Group Elements.

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
The **Code Browser** in the Window menu has one source editor under three
columns, after the Smalltalk System Browser. **Sources** lists the Project, each
Page, Libraries and Tests. The next column lists the chosen Source's Scripts: a
Page's own Script and its Elements, with a Group's members after it, or the
Libraries or Test Scripts. **Handlers** lists the shown Script's Handlers, and
choosing one opens its line. On a narrow screen the columns stack. Existing Script actions select the corresponding source. Selecting code leaves
the canvas’s Page and Element selection unchanged. Script sources retain their
Message Path links, Add action, diagnostics and recipes. Each source keeps its
cursor and scroll position when another source is selected. Resize the browser
from its bottom-right corner.

The **Dictionary** window, from the Window menu or the Code Browser's
**Dictionary** button, lists the Grants of the Script the Code Browser shows,
from the Host Manifest its completion reads: a Grants column, then the Grant's
Operations, over the chosen Operation's call, description, examples, mode,
result, cost and errors. A Test Script lists only the Folio Harness. It stays
beside the Code Browser while you write. Right-click a Grant, an Operation call
or a Host Command in a Script and choose **Show … in Dictionary** to open its
entry; elsewhere the browser's own menu appears.

Edits change the authored Project immediately and share its undo/redo, autosave
and portable export/import. The editor’s ⌘/Ctrl-Z and redo shortcuts use the
same history as the Edit menu. Closing the browser keeps its source and editor
state. Renames and undo retain source identities; deleting the selected source
selects the Project Script. Opening another Project closes the browser and drops
its previous source states. Read-only Projects have read-only source editors.

The selected Script has an owner-scoped language-server workspace with a live Host Manifest
from [`src/script-manifest.ts`](src/script-manifest.ts). Page and Element
Scripts bind that Page's Elements, `thisPage` and `project`; every Script
also binds every Page name. The Manifests describe the `pages`, `elements` and `sound` Grants
from ADR 0084, the `user` Standard Capability, the `folio` Grant of `hide` and `show` (see [Play](#play)), and the `canvas` Grant; all six are available during Play (see [Sounds](#sounds), [Canvas](#canvas) and [Asking the reader](#asking-the-reader)). Renames and Library edits refresh the selected source’s Manifest and diagnostics. Problems
show their lines below the editor and in its gutter. Completion and hover use
the Manifest; property completion for a named receiver uses its Object Kind.
Hovering a Handler's name in its head shows a static Fuel Estimate and Fuel
Bound that include the declared costs and result Shapes of Folio's Grants
([#1606](https://github.com/odogono/odgn-talk/issues/1606),
[#1610](https://github.com/odogono/odgn-talk/issues/1610)). A bound over one
frame's Pump Fuel (`PUMP_FUEL`, 5,000) says how many frames it may spread over.
The Manifest cannot yet describe `me`'s kind, so it cannot offer `me`'s
properties. Scripts execute only in a Play Session (see [Play](#play)).
The Manifests include built-in events and each Script's authored message
handlers, so custom messages between Scripts do not produce unknown-message
hints. Editing handlers refreshes the Manifest alongside the source.

### Project Libraries

Choose **Libraries** in the Code Browser, then **+ New Library**. Double-click
it to rename it, and write Handlers, functions and Constants in its source editor. Library names
are NorthTalk identifiers, unique among the Project’s Libraries; Standard
Library names are reserved. Object and Grant names are a separate namespace.
A Library has no Script Variables, owner or mailbox. Pass caller-specific state
and objects as arguments; its code runs with its caller’s Grants.

Import definitions explicitly, for example `use fits from tetrisRules`. Libraries
may import other Libraries. The browser checks Library sources in Library mode
and refreshes importers’ diagnostics as dependencies change. Rename and
**Delete Library**, from its right-click menu, are undoable and leave `use` lines untouched for manual repair.
Broken drafts can still be saved. Play reports Library errors and failed
importers while independent code continues; Errors links to the Library’s own
source and line, including after a rename. Deleted source targets become
unavailable rather than opening a different Library of the same name.

Every Library is embedded in the Project’s file and browser versions. To reuse
one in another Project, create a Library there and paste its source, doing the
same for any custom dependencies. These are independent copies; there are no
external dependencies, automatic updates or author-managed Library versions.
The ownership rationale is in the [Project Libraries ADR](../../docs/adr/0118-folio-projects-own-their-libraries-as-independent-source-copies.md).

### Test Scripts

A Project-level Script whose name is an identifier and then `.test`, such as
`game.test`, is a Test Script ([ADR 0133](../../docs/adr/0133-folio-tests-a-project-with-test-scripts-and-a-folio-harness.md)).
It is saved in the Project's file and never loaded by Play. Each of its
parameterless Handlers named `test` and then a capital is a Test Handler, run
by [`runProjectTests`](src/test-runner.ts) as `northtalk test` runs one
(ADR 0056):

- Each test gets a fresh Play Session on the first Page with the seed 0,
  after `startPlay`, `openPage` and one `frame`. An optional `on setup` runs
  first.
- The Test Script reaches Pages by name and `project`, only by message. It
  may not `extend` the Scripts under test.
- `use assert, assertEqual from test` imports the Test Library. A Project
  Library named `test` hides it, so every test fails until it is renamed.
- The Folio Harness, granted to the Test Script only:
  - `ask harness to key "ArrowLeft" and wait` sends `keyDown`, then `keyUp`, to the Page.
  - `ask harness to click "restartButton" and wait` clicks an Element of the current Page
    with the primary button at its centre. A map replaces any of those, as in
    `ask harness to click "board", {button: 2, x: 30, y: 50} and wait`.
  - `ask harness to hold "cell", 500 ms and wait` presses an Element for the
    duration: `pointerHeld` every 16 ms, then the `click` its release makes.
  - `ask harness to frame 16 ms and wait` moves the Clock on and delivers one `frame`.
  - `ask harness to advance 2 s and wait` moves the Clock on without a `frame`.
  - `ask harness to goTo "ending" and wait` changes Page.
  - `ask harness to page` reads the current Page's name.
  - `ask harness to property "text", "scoreText"` reads an Element's
    `text`, `visible`, or any other text, number or yes/no property.
    Each `wait` returns once everything the input started has finished.
- The Clock moves only on `frame` and `advance`, or when the test waits with
  nothing else able to run, as in `northtalk test`.
- A test passes when its Run completes and no Run in the Play Session
  errors. Events the Harness sends may go unhandled, as a reader's clicks do.
- A failure is placed at the line that raised it in the Test Script,
  including a failed assertion, else at the Test Handler.

Choose **Tests** in the Code Browser, then **+ New Test Script**, to add one
with a Test Handler to start from; double-click it to rename it. Its editor knows the
Harness and the Test Library. **Run Tests** runs every Test Handler against
the Project as it is now and lists `passed` and `failed` counts with each
result and its problems; clicking a result opens its Test Script at the
failing line. Run Tests works in a read-only Project too. Tests run on the
page, not in the Play worker, so a test that loops for a long time holds up
the editor until its Pump limit ends it.

Both Tetris Example Projects ship `game.test`, and Sonar ships `sonar.test`.

**Record Test**, beside Browse, writes a Recorded Test from what you do
([ADR 0134](../../docs/adr/0134-folio-records-a-play-through-as-a-generated-test-script.md)):

- It restarts Browse on the first Page with the seed 0, where every test
  starts. Choose it again, or Edit, to stop.
- Your keys and clicks become `key` and `click` calls, with the time between
  them as 16 ms `frame` calls, a run of them in a `repeat` loop. A Project
  with no `frame` Handler gets `advance` instead. Paused time isn't recorded.
- A click is recorded with its button and position. A held press's
  `pointerHeld` messages aren't replayed, only the `click` that ends it.
- Typing into reader-editable text and answers to `ask user` aren't replayed:
  a `-- not recorded` comment marks each, and Errors says so. Hovering isn't
  recorded either, so `pointerEnter` and `pointerLeave` Handlers don't run in
  the replay.
- It ends by checking the current Page (`ask harness to page`), each Text
  Element's `text`, and the `visible` of each Element whose visibility
  differs from the authored Project. The expected values come from replaying
  the input headless, so the new test passes; if that replay ends differently
  from what you saw, Errors says so.
- It is added to `recorded.test` as `testRecording1`, `testRecording2` and so
  on, and the Code Browser opens at it, ready to rename or edit.

### Script Recipes

Choose **Add action…** in the Code Browser or Info to insert a click action:
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
another preview. The picker is a Preact component
([`src/recipe-picker.tsx`](src/recipe-picker.tsx)): its action, target, text,
position, preview and status are component state, so changing the action
updates the controls in place and keeps the typed text. Changing any input
clears the preview. Closing the picker unmounts it; the CodeMirror Script stays
imperative and the insertion is one `view.dispatch`.

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
explicit placement, selection, undo/redo, stale previews, in-place updates
that keep typed text, and read-only windows.

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
[`src/projects.ts`](src/projects.ts). The Project, Earlier Versions and Example
Projects lists are Preact components in
[`src/projects-window.tsx`](src/projects-window.tsx), following signals for the
records, versions, current Project, edit lock and the row being renamed or
deleted, so a reload updates rows in place and a rename field keeps what was
typed. Beside each stored version, a
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
**Play a sound**, **Loop a sound** and **Stop a sound** for every owner. See this in Folio:
[The Lighthouse Mystery](https://northtalk.org/folio/lighthouse) plays its bell and waves.

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

## Canvas

A canvas Element shows its Drawing over its `fill`: the commands Scripts and
the Message Box have drawn on it since its last `clear` or `background`
([ADR 0116](../../docs/adr/0116-a-canvas-element-keeps-a-retained-drawing-across-play-and-edit.md)).
Every Script and the Message Box get the `canvas` Grant, the Playground's
drawing Operations without `size`, each taking the Canvas first:

```talk
on frame elapsed
  tell canvas
    background board, "#1d2b35"
    noStroke board
    fill board, "#e0a458"
    ellipse board, 60, 40, 30, 30
    fill board, "#ffffff"
    textSize board, 16
    text board, "Score: 10", 8, 20
  end tell
end frame
```

`clear`, `background`, `fill`, `noFill`, `stroke`, `noStroke`, `strokeWidth`,
`strokeCap`, `strokeJoin`, `point`, `line`, `triangle`, `rectangle`,
`roundedRectangle`, `ellipse`, `circle`, `arc`, `text`, `textSize`, `push`,
`pop`, `translate`, `rotate` and `scale` each cost 1 Fuel; their arguments are those in the
[Playground's table](../playground/README.md#static-canvas), after the Canvas.
Coordinates are the Element's own, one unit to one Page pixel, and drawing is
clipped to its frame; `ellipse`, `circle` and `arc` take their centre, and
`arc` angles are radians. Colours are `#RRGGBB` or `#RRGGBBAA`. `clear` and
`background` reset the Drawing to the commands that set the current style
(fill, stroke, stroke width, cap and join, and text size), so style survives a clear and a `background` every
`frame` keeps the Drawing one frame long. `push` saves the style and
transform and `pop` restores them; `rotate` takes radians, clockwise.
`clear` and `background` reset the transform and empty the `push` stack, and
`background` fills the whole Canvas. A `pop` without a `push`, or a `push`
nested more than 64 deep, is a catchable `invalid canvas argument`. A Drawing holds at most 10,000
commands; one more raises a catchable `canvas limit`, and a bad argument a
catchable `invalid canvas argument`. Scripts cannot read a Drawing back.

The Drawing is one surface across Play and Edit. Play starts from it, and on
return to Edit each Canvas's Drawing as shown, a half-drawn frame included,
is committed into the Project as one undoable edit; Undo restores the
Drawing from before Play. Canvases created during Play are discarded with
the rest of Play State. In Edit, a Message Box line that draws is one
undoable edit. Info shows the command count and **Clear drawing**, which
empties the Drawing back to the default style. Duplicating a Canvas, and
cloning it in Play, copy its Drawing. The Project file stores the
Drawing as `{op, args}` commands, checked with the Playground's validation.
See this in Folio: [Canvas Tetris](https://northtalk.org/folio/canvas-tetris) and
[Sonar](https://northtalk.org/folio/sonar) draw on a canvas every frame.

[`src/drawing.ts`](src/drawing.ts) holds the retained list and its reset
rule; [`src/canvas-view.ts`](src/canvas-view.ts) paints it with Canvas 2D in
Edit and Play, painting only the new commands while a Drawing grows. The Play
worker sends the page each Drawing's additions or a reset, apart from its
Element ([`src/play-host.ts`](src/play-host.ts)), and the
[mirror](src/play-mirror.ts) commits them on return to Edit.
[`tests/canvas.test.ts`](tests/canvas.test.ts) checks the retained list
headlessly, with no pixel comparisons.

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
selection, except alignment: the left, centre, right and justify buttons align
every paragraph the selection or caret touches, and a new paragraph keeps the
alignment of the one it was split from. Alignment belongs to each paragraph, so
one Element can mix them; Info's **Alignment** sets every paragraph at once. Font, size, whole-Element colour and **Reader can edit** remain in Info;
the reader flag allows rich-text input during Play Sessions (see [Play](#play)).

**Done**, Escape, selecting another Element or changing Page finishes editing.
The toolbar's Undo and Redo, or ⌘/Ctrl-Z and ⌘/Ctrl-Shift-Z (also Ctrl-Y), are
the Edit menu's: each text change or formatting step is one entry in the same
history as every other authored edit.

Pasting HTML keeps paragraphs, bold, italic, underline, text colours and
paragraph alignment (`text-align` on a block) from semantic tags and inline
styles. Links become text; images, scripts, embedded
content, stylesheet/class formatting, fonts, sizes and backgrounds are dropped.
Plain text paste keeps its paragraph breaks. Dragging external content into text
is disabled. The authored model holds paragraphs of styled runs, and the Project
file round-trip preserves them; the editor never stores raw HTML.

The model's `textOf(element)` reads paragraphs joined by newlines;
`replacePlainText(element, text)` replaces them and clears mixed formatting,
even when the plain text is unchanged. It keeps each paragraph's alignment, and
paragraphs it adds take the last one's, so a centred title stays centred when a
Script writes it. These are the plain-text operations the
Play Host uses for `the text of`. Scripts read and set alignment as
`the textAlign of title`, one of `left`, `center`, `right` or `justify`:
reading gives the first paragraph's, and setting aligns every paragraph. Info's plain text field also
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
navigation with its cached page and serves the shell, `main.js`
included, from the build it cached. Before running a suite, unregister it
and clear its caches from the console of any page on the origin, then open
the suite's page in a fresh tab, one tab per suite:

```js
for (const r of await navigator.serviceWorker.getRegistrations())
  await r.unregister();
for (const name of await caches.keys()) await caches.delete(name);
```

Running a suite on `/` registers the worker again.

The `project-title` suite runs on `/project-title-test.html`; import
`/project-title.browser.js` and call `runBrowserTests()` to check live rename,
undo/redo and Project replacement through the real shell and Preact title.
The [`info-panel` suite](tests/info-panel.browser.ts) checks live field focus,
caret and selection, composition events, uncommitted names, name refusals and
suggestions, history, selection changes and read-only controls for every Element
kind. The [`edit-menu` suite](tests/edit-menu.browser.ts) checks that the Edit
menu's commands follow the selection, undo and redo from the menu and keys,
read-only state, Browse and Present.
The [`errors` suite](tests/errors.browser.ts) checks that problems append
with their labels, open their Script, are disabled once their owner has gone,
and that Clear and Close behave as before.
The [`projects-window` suite](tests/projects-window.browser.ts) runs on
`/projects-window-test.html` and checks that the Project and version lists
keep their rows, and a rename field its focus, caret and typed text, while the
records, current Project, edit lock and previewed version change.

## Performance window

Open **Window → Performance** to profile Browse or Present, or use
**Cmd/Ctrl+Alt+P** outside text editors and modal prompts. The shortcut toggles
only this window; Escape keeps its usual Play behavior. Capture starts on first
opening during a Play Session and continues when the window is closed. A new
session clears results and captures immediately only if the window is open.
Switching Browse to Present starts a new session too. Clear starts a fresh
measurement interval; Stop freezes the final results for inspection. Forced
worker termination retains the last received results marked **Incomplete**.
Opening another Project clears its predecessor's diagnostics.

Script rows expand into **Run origin** rankings, sorted by recent Fuel/second.
A Run origin is its initiating message selector or function, including internal
Handler, function and Library calls. Independently spawned Runs get their own
origins. Repeated Page visits share Script totals; cloned Script instances stay
separate and link to their authored source. Rows show Fuel, starts, completed
Runs (including failed endings), failures, discarded Runs, active Runs, and
last/mean/peak Fuel for finished Runs. Starting capture or clearing mid-Run
counts only subsequent Fuel and excludes that partial Run from cost samples.
Active Runs include waiting and preempted work.

Frame statistics count **delivered messages** and **busy-skipped messages** per
Script, with deliveries/second. They do not measure browser paint FPS or worker
queue latency. Scripts without frame handlers show frame metrics as unavailable.
Fuel measures deterministic work, not CPU time. Recent rates use the current and
previous one-second bucket divided by their elapsed time. Background-tab time
counts, so throttling lowers rates naturally.

The charts retain 60 one-second buckets: total Fuel/second and the largest Pump's
Fuel in each bucket, with the configured Pump cap (currently 5,000) marked. A
Run can span multiple Pumps, so its total Fuel is not compared with that cap.
Totals and peaks span the whole measurement interval. The current chart bucket
is partial; its Fuel rate uses elapsed time in that bucket. Rankings and charts
refresh at 4 Hz, independently of visual changes. This is a live profiler with
bounded recent history, not a per-Run timeline or function self-time profiler.

The worker consumes typed cumulative Run accounting, including final and reload
reports, rather than parsing Trace. Only live Run baselines are tracked before
opt-in. Capture does not change frame delivery or scheduling. Telemetry is
separate from the Play mirror, allowing final Stop snapshots to arrive after
Play State is discarded; session and capture epochs reject stale snapshots.

## Variables window

Open **Window → Variables** to watch a browsing Play Session's Script
Variables. It lists the Project's Script, the showing Page's Script and the
Scripts of that Page's Elements, Elements created during the session
included, each labelled by its owner as the Errors window labels them. Scripts
without Script Variables, Message Box Scripts and the Scripts of Pages the
session has left are hidden. It is read-only, and it isn't available in
Present.

Values show in source form. Lists and maps show their size and open to show
their first 100 items, then a "… N more" row; open rows stay open across
refreshes. An Element reference shows the Element's name, and clicking an
authored Element selects it; an Element that has gone shows as "(deleted)".
Other Host Objects show their kind and id, and a Function shows as
`function`. A value that changed since the last refresh is highlighted for
600 ms. Each row's ⧉ button copies its whole value in source form, even a
list or map cut off at 100 items, so it pastes back into a Script as an equal
value; a value holding a Function or Host Object has no source form, and its
button says so instead ([#1684](https://github.com/odogono/odgn-talk/issues/1684)).

The window reads the session at most every 100 ms, only while it is open and
a Pump has run since it last asked. The Play worker calls the Group's
`inspect()`, which costs no Fuel, and sends only the shown Scripts' variables.
After the session ends the window keeps the last values, marked as from the
ended session, until the next session starts.

## Play

There are two ways to run a Project, both on the Page being edited
([ADR 0093](../../docs/adr/0093-folio-browses-in-place.md)). **Browse**, at
the top of the Tools window, plays the Page in place on the desk with the
Tools, Script and Errors windows still open (the Edit menu offers only Undo and Redo, for Script edits), as HyperCard's browse tool did.
**Present**, in the header, plays it full-window with the editor hidden; an explicitly opened Performance window remains available. Each session uses a fresh Core
Group and a disposable copy of the Project. The Project receives `startPlay`,
and the Page receives `openPage`. Click and pointer messages follow the Core's
Element → containing groups → Page → Project Message Path. A touch tap sends `pointerEnter`, `click`,
then `pointerLeave`.

`click` carries one map, `{button, x, y}`
([ADR 0145](../../docs/adr/0145-pointer-messages-carry-an-event-map.md)).
`button` is the browser's: 0 primary, 1 middle, 2 secondary (right). A tap,
and Enter or Space on a focused button, are 0. `x` and `y` are in Page units
from the Element's top-left corner, whatever Present's scale, and a keyboard
click is at the centre. A Handler picks a button with a pattern or a Guard:

```talk
on click {button: 0, x, y}
  ping x, y
end click

on click {button} where button is 2
  plantBuoy
end click
```

A map pattern matches every map with the keys it lists, so `on click {}` and
`on click e` run on every button; the Code Browser advises
`on click {button: 0}` for a primary-only Handler, and warns about an
`on click` without a parameter, which a click never reaches. A click no
clause matches climbs the Message Path, so an Element can leave right-clicks
to its Page. While a Page plays the browser's context menu stays away.

While the primary button or a finger stays down on an Element whose Message
Path handles `pointerHeld`, Folio sends it `pointerHeld {held, x, y}` once per
displayed frame, `held` being the whole ms since the press and `x` and `y`
where it began. It stops at release, at `pointerLeave` and when Play pauses,
and the release still sends `click`. A long press is a Guard plus a latch,
so the release doesn't also act as a click:

```talk
script variable planted = false

on pointerHeld {held} where held >= 450 and not planted
  put true into planted
  plantBuoy
end pointerHeld

on pointerHeld _
end pointerHeld

on click {button: 0}
  if planted then
    put false into planted
  else
    ping
  end if
end click
```

Projects saved before format 5 open with each `on click` rewritten as
`on click {button: 0}` and each `click` a Script sends given the same map. A
send whose message name is computed is left alone; the Errors window reports
it as an unhandled `click` when it runs. `keyDown key` and `keyUp key` report a pressed and released
browser key (`event.key`) to focused editable text, otherwise to the Page.
Each takes one text argument. Editable text keeps normal typing; a Page key
event loses its browser default only when that message's Handler is on the
Page's Message Path (Page or Project Script). This lets arrow keys and space
drive a game rather than scroll; unhandled events keep their defaults.
Operating-system auto-repeat continues to send `keyDown`, with no additional
argument. Scripts can use `keyDown` and `keyUp` to track several held keys and
implement their own repeat timing through `frame`. See this in Folio:
[Tetris](https://northtalk.org/folio/tetris) moves, turns and drops on `keyDown`.

Focus changes, window blur and hiding the tab send one `keyUp` for each held
key to its original recipient, using the key reported on its first `keyDown`
even if modifiers have changed. Later physical releases and repeats are
ignored until a fresh press. Page navigation also releases held keys along the
old Page's Message Path to any surviving Project Handler. Stopping Play
discards held keys, so releases
cannot reach a new session. Enter or Space on a focused button sends it
`click {button: 0, …}` at its centre and neither key message; a pointer
click returns focus to the Page.
Reader-editable text opens
the formatting toolbar on focus: select text for bold, italic, underline or
colour, align paragraphs, or use Clear, Paragraph, Undo and Redo. Done hides the toolbar; focusing
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
Core's default limits with small Pump slices between turns.
Autosave and export use authored content only.

The session runs in a Play worker ([ADR 0107](../../docs/adr/0107-folio-play-runs-in-a-supervised-worker.md)),
so a Script that never yields can't freeze the editor. The page draws from
its mirror of the showing Page and posts reader input to the worker. Stop
returns to Edit at once. If the worker hasn't acknowledged Stop within 500 ms
it is ended, and Errors reports that a Script did not respond.

The Code Browser stays editable while browsing. Script and Library edits change
the authored Project immediately and apply from the next session; the running
session keeps its loaded source. Escape inside the browser stays with the editor.
The Code Browser is read-only while presenting.

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
lines. While browsing, the default context runs in the Play Session with the
showing Page's names and every Grant, and its effects are Play State. The
context selector also offers the currently loaded Scripts: a targeted command
can read and change that Script's Script Variables using its Grants, object
bindings, Library imports and owner. In Edit, the selector offers the authored
Project and showing Page’s Scripts, with their Library imports; commands use
fresh Script Variables because no events have run. The
command runs in a session copied from the Project that sends no events; when
it finishes, its changes become one undoable authored edit, source editors
stay attached, and a navigation moves the editor to that Page. A failing
Edit command changes nothing and prints its error and line. If another authored
edit occurs while the command runs, its result is refused with a retry message
rather than overwriting newer work; waits and `user`
prompts only run while browsing. [`src/message.ts`](src/message.ts) holds the logic, tested without a
DOM.

The Message Box is a code window like a Script's, built from the same parts in
[`src/code-window.ts`](src/code-window.ts): it resizes from its corner, and its
editor has the same completion (⌃Space), hover and diagnostics. While browsing, a selected Script supplies its loaded source, Library sources
and bindings, even after its authored source or Libraries are edited. The editor keeps that context and the command's wrapper hidden
and protected.

Two Session Commands answer without running anything, alike in Edit and
while browsing, from the same name discovery and Declaration Documentation as
the Session Host. `:describe <name>` prints a name's declaration, signature
and documentation, from the selected Script, a Library it imports or the
Built-ins; `:apropos [query]` lists every name containing the query, with the
`use` line an unimported Library export needs. The default context has only
the Built-ins and the Project's Libraries; Script Variables show no value.

`:inspect <expression>` ([ADR 0141](../../docs/adr/0141-folio-opens-projects-from-urls.md))
does run: it evaluates one expression where any other command would, in the Play Session
while browsing and in the Project in Edit, and shows the value as the
Variables window's rows: lists and maps open from their row, and an Element
selects itself when clicked. The same rows appear in the Variables window's
Inspected section, which keeps the latest result until another Project
opens. Unlike the Playground's, it reads no Host Object properties.

Targeted commands use Extend ([ADR 0108](../../docs/adr/0108-folio-message-box-commands-can-extend-a-chosen-script.md));
they accept statements and expressions, not Script-level declarations. Existing
Script Variables can change, while new local variables disappear after the
command. Commands run alongside other work and may wait; completed effects
can survive a later error, and Browse commands are not undoable. Closing the
Message Box hides it; stopping Play ends its commands. Each result or error
stays beside its submitted command and original context. The last result has
a ⧉ button that copies it in source form, as the Variables window's rows do.

A selection identifies one loaded Script in one Play Session. Navigation,
deletion or Stop can make it unavailable, and returning to a Page or starting
Play again never silently selects the replacement. Choose a context explicitly
to run again, including the default context before making an Edit-mode change.
History retains up to 50 commands with their original contexts across sessions
in one Project; switching Projects clears it, and reloading the app discards it.
Identical targeted commands reuse their generated Handlers. Each loaded Script
allows at most 1,000 distinct commands; after that, existing commands still
work, but new commands require restarting Play. There is no automatic reload
or per-command cancellation.

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

A Script can reach a Page's Elements by computed name or position, and
count them, without a Grant:

```talk
set the fill of element ("cell_" & r & "_" & c) of thisPage to "red"
put the number of elements of thisPage into n
put the last element of thisPage into frontmost
```

A missing name or position gives Nothing.

#### Element references

This is Folio's policy for the
[Object Collection](../../spec/embedding/object-elements.md).
Folio declares collections on `page` and `group`. A Page contains every live
Element and group on that Page, including hidden and Script-less members.
Its numeric order visits siblings back to front, placing each group after its
members: `A, G(B, C), D` gives `A, B, C, G, D`, count 5. A group's collection
contains only its immediate members in local layer order. Page name lookup
finds every descendant; group lookup finds immediate members only. Names are
Page-local identifiers, not labels or ids. All seven Element Object Kinds are
in the result Shape. Project and ordinary Element receivers have no collection.
Any Script holding a Page or group can read its collection, including one on a
Page that is not showing; its Scripts need not be running.

Create appends at the front of a Page; clone appends among the source
Element's siblings; delete removes the member or whole group subtree. Later lookups/counts see the change after the existing Pump boundary.
Reordering changes numeric positions, while a retained member handle keeps
its identity. Deleting and recreating a name resolves to the new handle;
retained old handles stay disposed. End of Play restores authored content,
as it does today. Lookup itself never starts a Script or changes authored
data. The Message Box and authoring Manifest expose the same collection as
Play; Edit commands still apply through their disposable session and undo.

Folio declares 1 Fuel and 0 allocation for each callback. Count and signed
positional access use maintained ordered arrays; name lookup uses a Page-local name
index kept in step with create, clone, delete and session construction. The
Core's text selector rate pays for the size of a name. Names are already
read-only, so there is no Script rename path to reconcile. Do not rebuild
that index or allocate a whole list for every lookup.

The `elements` Grant remains available and independent: `create`, `clone`
and `delete` still mutate through it, and `find` keeps its existing missing-name
error. Static load-time Element bindings still catch misspellings and keep
their existing lifetime. Computed references resolve against current Play
State each time; they do not add new bindings. Tetris paints each computed
cell directly, with no startup cache of cell handles.

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
and Script as a sibling on the same Page, recursively for groups, with fresh
names throughout and one overall 20 px position offset.
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
on click {button: 0}
  set the label of me to "Wait for it…"
  wait 3 s
  set the label of me to "Ready!"
end click
```

The browser schedules the next Pump from the Core's earliest deadline; a wait
does not block reader input, other handlers or other Scripts. A handler can
repeat an effect by waiting and then sending itself another message. No timer
Capability or additional Grant is needed. See this in Folio:
[The Lighthouse Mystery](https://northtalk.org/folio/lighthouse) waits in its lamp room.

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

See this in Folio: [Tetris](https://northtalk.org/folio/tetris) adds up `elapsed` for gravity,
and [Sonar](https://northtalk.org/folio/sonar) sweeps its sea on `frame`.

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
on click {button: 0}
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
returning the Project and its asset bytes, list it in `EXAMPLE_PROJECTS` with
a slug, and [`examples.test.ts`](tests/examples.test.ts) checks that it builds
and starts playing cleanly.

Each Example Project also opens from its own address, such as
<https://northtalk.org/folio/tetris>, so docs can link to it
([ADR 0141](../../docs/adr/0141-folio-opens-projects-from-urls.md)). The
build writes it to `projects/<slug>.folio` and a copy of Folio's page to
`<slug>/index.html`, and the service worker precaches both. The page opens a
fresh copy from the file, as an import, and sets the address back to Folio's
own, so a reload doesn't add another copy. The slug is a public link, so
never change one once it's published.

Folio remembers which Project each address made, in the browser's storage
alongside the Projects. Opening the same address again, while that copy
still exists, shows a banner with **Open your copy** and **Start fresh**
instead of adding another one
([#1679](https://github.com/odogono/odgn-talk/issues/1679)).

Any `.folio` file on the web opens with
`https://northtalk.org/folio/?open=<url>`, where `<url>` is the file's
address, URL-encoded. The host must serve it with CORS, so Folio's page may
read it. Folio adds a fresh copy, as an import, drops `?open=` from the
address and remembers the copy the same way. If the file can't be fetched or
isn't a `.folio` file, a notice says why
([#1677](https://github.com/odogono/odgn-talk/issues/1677)).

**File → Share Link** copies a Shared Link,
`https://northtalk.org/folio/#p1.<payload>`, that carries the whole Project
in its fragment, so it never reaches a server. A link can't carry images or
sounds, so Share refuses a Project with assets and suggests exporting a
`.folio` file instead. Opening a Shared Link adds a fresh copy, drops the
fragment from the address and remembers the copy like `?open=`. The
Playground's old `#v1.` links are ignored
([#1678](https://github.com/odogono/odgn-talk/issues/1678)).

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
exports, reopens offline and plays the same anywhere. See this in Folio:
<https://northtalk.org/folio/lighthouse>.

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
rectangles whose colour differs from what they show. See this in Folio:
<https://northtalk.org/folio/tetris>.

**Projects → Open Canvas Tetris** adds the same game with a board and preview
drawn through the `canvas` Grant instead of pre-placed cells
([#1379](https://github.com/odogono/odgn-talk/issues/1379)), built from
[`src/examples/tetris-canvas.ts`](src/examples/tetris-canvas.ts), at
<https://northtalk.org/folio/canvas-tetris>. Both builders
embed the same `tetrisRules` Library from
[`src/examples/tetris-rules.ts`](src/examples/tetris-rules.ts). The Library holds
Constants, grid creation, collision checks, rotation calculations, full-row
detection, colour lookup and drop timing. Page Scripts import these helpers,
keep game state and events, and call their own painting Handlers. They share the layout in
[`src/examples/tetris-layout.ts`](src/examples/tetris-layout.ts). The Canvas
version ships with empty Drawings. `openPage` clears both surfaces before
starting a new game, including on a second Browse after the previous game's
Drawing was kept in Edit. Each changed board or preview clears its surface
and draws only the filled cells over the surface's empty fill, so the
retained commands hold one frame of filled cells.

Arrow keys move, Up and Z turn, Down drops faster and Space drops. Pieces
come from a 7-bag. Gravity starts at one row a second and speeds up by 75 ms
each level, down to 100 ms; the level rises every ten lines, and one to four
lines score 100, 300, 500 or 800 times the level. There are no wall kicks,
hold or ghost piece. Pieces come from `random`.

It is dressed as a game on a colour Macintosh running System 7: a menu bar on
a periwinkle desktop, a platinum window with a pinstriped title bar and close
box, Chicago and Geneva type where the browser has them, pieces in the
classic 16-colour palette, and a bomb alert for Game Over. The window frame,
score text, New Game button and Game Over Group remain ordinary Elements in
both versions, beside or above the game surfaces.

Both ship the Test Script `game.test`, which plays through the Folio Harness
as a reader would. Unit tests drive the game through the
[Play harness](src/play-harness.ts), on an explicit clock through `frame` and `keyDown`:
spawning, moving, turning, gravity, drops, a four-line clear, a level-up and
game over in both versions. Canvas checks read the retained Drawing rather
than pixels, and also check the preview and a fresh second Browse.
Open `/tetris-test.html` and run
`await import('/tetris.browser.js').then(m => m.runBrowserTests())`.
Reload, then run
`await import('/tetris.browser.js').then(m => m.runCanvasBrowserTests())`
for the Canvas views, keyboard input, New Game button and retained Drawing
across a second Browse.
