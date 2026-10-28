# Folio task navigation

Find your task's heading, then open the listed files and run its first check.
Behaviour and limitations are in the [Folio guide](README.md); domain terms in
[GLOSSARY.md](../../GLOSSARY.md#browser-authoring); rationale in the
[ADR index](../../docs/adr/README.md). Commands run from the repository root.
List files with `rg --files tooling/creative` before opening one by name.

## Running and testing

- Fresh worktree: `bun install --frozen-lockfile`.
- Dev server: `bun run creative` serves `dist/` at <http://127.0.0.1:3928/>
  (`PORT` overrides; [serve.ts](tools/serve.ts)) and rebuilds on changes to
  Folio, the editor, the Tooling stack and the TS Core.
  `bun run --cwd tooling/creative start` builds once, minified, and never
  rebuilds. `bun run --cwd tooling/creative build` writes `dist/` only.
- JSX: [tsconfig.json](tsconfig.json) uses Preact's automatic JSX runtime
  for `.tsx` components. Both [build.ts](tools/build.ts) and
  [build-browser-tests.ts](tools/build-browser-tests.ts) bundle imported
  components with `Bun.build`. The root ESLint and Prettier checks include
  `.tsx` files.
- Unit tests: `bun test tooling/editor/tests tooling/creative/tests`. They
  never run `*.browser.ts`.
- Typecheck: `bun run --cwd tooling/creative typecheck`.
- Browser suites, automated: `bun run --cwd tooling/creative test:browser`
  ([browser-tests.ts](tools/browser-tests.ts)) builds every suite, serves
  `dist/` and runs each `run*BrowserTests` export headless in its own fresh
  Chromium context, so the service-worker trap below cannot happen.
  `--suite play,tetris` runs a subset, `--headed` shows the browser. Once per
  machine: `bunx playwright install chromium-headless-shell`.
- Browser suites by hand: with the server running, `bun run --cwd tooling/creative build:browser-tests`
  ([build-browser-tests.ts](tools/build-browser-tests.ts)) rebuilds the app
  and every suite, and prints where each one runs: `/<suite>-test.html` (a
  page without `main.js`; the suite mounts the UI itself), or `/` for
  `offline`, `rich-text` and `storage`. In the page's console run
  `await import('/<suite>.browser.js').then(m => m.runBrowserTests())`;
  every result must have `passed: true`. `play` also exports
  `runElementsBrowserTests`, `runFrameBrowserTests`, `runKeyBrowserTests`,
  `runUserBrowserTests` and
  `runMessageBoxBrowserTests`; run each after a reload. The watch server
  empties `dist/` on every app rebuild, so rebuild the suites after one.
- Service-worker trap: once `/` has loaded, Folio's
  [service worker](src/sw.ts) controls all of `127.0.0.1:3928`. It answers
  every navigation, including `/<suite>-test.html`, with its cached
  `index.html`, and serves `main.js` and the other shell files from the
  build it cached, not from `dist/`. Before a browser suite, in any page on
  the origin run:

  ```js
  for (const r of await navigator.serviceWorker.getRegistrations())
    await r.unregister();
  for (const name of await caches.keys()) await caches.delete(name);
  ```

  Then close that tab and open the suite's page in a fresh tab, one tab
  per suite. `/` registers the worker again, so repeat this after running
  a suite on `/`.

## Play Session and reader input

- [play.ts](src/play.ts): the Play Session, its Group, Core handles and lifecycle
  wiring, the `PlayMessage` list (`startPlay`, `openPage`, `click`, …) and
  `send`, Page navigation, `wait`, dynamic Elements, and `frame` delivery
  (`definesHandler`, `wantsFrames`, `frame`; ADR 0095).
- [play-view.ts](src/play-view.ts): Browse and Present in the browser,
  pointer and key input turned into `PlayMessage`s, the
  `requestAnimationFrame` loop that drives `frame`, and the worker
  supervisor that ends an unresponsive Play worker (ADR 0107).
- [play-host.ts](src/play-host.ts): the Play worker's side, which owns the
  session and its Pump clock and publishes views; [play.worker.ts](src/play.worker.ts)
  is its entry. [play-protocol.ts](src/play-protocol.ts) lists the messages,
  and [play-mirror.ts](src/play-mirror.ts) is the page's copy of Play State.
- [play-text.ts](src/play-text.ts): reader-editable text and its history.
- [play-harness.ts](src/play-harness.ts): the TS Play harness Example
  Project tests use (ADR 0133): a seeded session on a virtual clock with
  `settle`, `key`, `click`, `frame(ms)`, `deliver`, `element`, `text`,
  `drawingOf` and an `extend` option.
- [test-runner.ts](src/test-runner.ts): Run Tests for a Project's Test
  Scripts (ADR 0133), with the Folio Harness in
  [grants/harness.ts](src/grants/harness.ts) and the Code Browser's Tests
  section in [code-browser-panel.tsx](src/code-browser-panel.tsx); the Test Library and Test
  Handler discovery are shared with `northtalk test` in
  [test-script.ts](../stack/src/test-script.ts). Tests:
  [test-runner.test.ts](tests/test-runner.test.ts).
- [recorder.ts](src/recorder.ts): Record Test (ADR 0134), which turns
  Browse input into a Recorded Test; [play-view.ts](src/play-view.ts) feeds
  it. Tests: [recorder.test.ts](tests/recorder.test.ts),
  [record.browser.ts](tests/record.browser.ts).
- Tests: [play.test.ts](tests/play.test.ts),
  [play-host.test.ts](tests/play-host.test.ts),
  [play-text.test.ts](tests/play-text.test.ts),
  [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/play.test.ts`.

## Project model and Project files

- [model.ts](src/model.ts): Projects, Pages, Elements and their properties;
  pure data, no Play State ([ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md)).
- [editing.ts](src/editing.ts): authoring interaction state, tree transactions,
  grouped change history, signal adapters and generation/revision/content tokens.
  `editor.project` is a readonly live view; use `snapshot()` or `capture()` to
  retain data for asynchronous work. Never write through it or retain old
  `state.value` as a document snapshot.
- [project-file.ts](src/project-file.ts) over [zip.ts](src/zip.ts): the
  `.folio` file.
- Tests: [model.test.ts](tests/model.test.ts),
  [editing.test.ts](tests/editing.test.ts),
  [history.test.ts](tests/history.test.ts),
  [project-file.test.ts](tests/project-file.test.ts),
  [zip.test.ts](tests/zip.test.ts).
- First check: `bun test tooling/creative/tests/model.test.ts tooling/creative/tests/project-file.test.ts`.

## Group Elements

- [tree/project-tree.ts](src/tree/project-tree.ts): the persistent mutable
  Project authority shared by Edit and Play, readonly live views, indexes,
  explicit mutations, copy work, batched changes and forward/inverse journals.
  [tree/properties.ts](src/tree/properties.ts) holds property getters, setters,
  validation and Script metadata shared by the tree, Play and the Script
  manifest. [tree/rules.ts](src/tree/rules.ts) holds child-membership dispatch,
  pure hierarchy/geometry rules and the 1,024-node/depth-32 limits without
  runtime model imports.
  [tree/history.ts](src/tree/history.ts) folds Edit's incoming field runs and
  detaches completed journals. [The write benchmark](tools/bench-project-tree.md)
  measures drag/typing bursts and checks copy and serialization budgets.
  [readonly.ts](src/readonly.ts) defines the `DeepReadonly` view contract and
  `thaw`, the writable deep copy of a view.
- [model.ts](src/model.ts) and [project-file.ts](src/project-file.ts): recursive
  copies and format-2 nested members/empty anchors; [editing.ts](src/editing.ts):
  entered scope, Group/Ungroup, history and sibling actions.
- [play.ts](src/play.ts): the Core adapter for tree collections and operations,
  parent-first handle installation, Fuel authorization and lifecycle effects.
- [stack.ts](src/stack.ts), [edit-menu.tsx](src/edit-menu.tsx),
  [info-panel.tsx](src/info-panel.tsx) and [play-view.ts](src/play-view.ts):
  outlines, empty markers, entry/exit, menu commands, Info and reader input.
- First check: `bun test tooling/creative/tests/project-tree.test.ts tooling/creative/tests/groups.test.ts`.
- Browser: `groups` suite on `/groups-test.html`; also run `edit-menu`,
  `play`, its Elements/key/Message Box exports, and `tetris`.

## Images, sounds and assets

- [images.ts](src/images.ts): image intake and the session's
  content-addressed bytes, which hold sound bytes too.
- [sounds.ts](src/sounds.ts): sound intake, the `SoundBoard` and playback;
  [grants/sound.ts](src/grants/sound.ts) is the `sound` Grant.
- Tests: [images.test.ts](tests/images.test.ts),
  [sounds.test.ts](tests/sounds.test.ts),
  [images.browser.ts](tests/images.browser.ts),
  [sounds.browser.ts](tests/sounds.browser.ts).
- First check: `bun test tooling/creative/tests/images.test.ts tooling/creative/tests/sounds.test.ts`.

## The folio Grant and hide/show

- [grants/folio.ts](src/grants/folio.ts): the `hide` and `show` Operations,
  their documentation and the `folio` Capability, both marked `command`.
- [play.ts](src/play.ts) grants it to every Script; [message-script.ts](src/message-script.ts) builds the Message Box's
  wrapper Script. They are Host Commands
  ([ADR 0094](../../docs/adr/0094-host-commands-are-command-call-spellings-of-granted-operations.md)),
  so they never climb the Message Path.
- Tests: `hide`/`show` cases in [play.test.ts](tests/play.test.ts),
  [scripts.test.ts](tests/scripts.test.ts) and
  [message.test.ts](tests/message.test.ts).
- First check: `bun test tooling/creative/tests/play.test.ts -t hide`.

## Message Box

- [message.ts](src/message.ts): running one command against the Play Session
  or, in Edit, the Project as one undoable edit; no DOM.
- [message-script.ts](src/message-script.ts): command wrappers, loaded Script
  editor contexts and the distinct-command limit; [play.ts](src/play.ts) owns
  target instance identities, Extend and command result routing.
- [message-window.ts](src/message-window.ts): the target selector and history, built on
  [code-window.ts](src/code-window.ts).
- Tests: [message.test.ts](tests/message.test.ts),
  `runMessageBoxBrowserTests` in [play.browser.ts](tests/play.browser.ts),
  and [message-targets.browser.ts](tests/message-targets.browser.ts) on
  `/message-targets-test.html` for target lifetime, loaded scope and history.
- First check: `bun test tooling/creative/tests/message.test.ts`.

## Windows and code windows

- [windows.ts](src/windows.ts): the title bar and close box every floating
  window shares, show/hide/bring-forward and the Window menu. Dragging and
  positions are in [stack.ts](src/stack.ts).
- [code-window.ts](src/code-window.ts): the resizable NorthTalk editor window,
  its language-server worker and the [shared editor](../editor/src/editor.ts).
  The Code Browser ([scripts.ts](src/scripts.ts)) and the Message Box are both
  built from it, so a change here reaches every code window.
- No unit tests; [scripts.browser.ts](tests/scripts.browser.ts) and
  [play.browser.ts](tests/play.browser.ts) drive real windows.
- First check: `bun run --cwd tooling/creative typecheck`, then the
  `scripts` browser suite.

## Menus

- [menus.ts](src/menus.ts): opening and closing the header's Folio, File
  and Edit menus, and the About window; the Window menu is in
  [windows.ts](src/windows.ts). The Folio and File menus are static HTML.
- [edit-menu.tsx](src/edit-menu.tsx): the Preact Edit menu commands, enabled
  from the editor signals and the shell's `playing` signal. Clicks and
  shortcuts run through `runCommand` in [stack.ts](src/stack.ts).
- [shortcuts.ts](src/shortcuts.ts): the editing shortcuts the Edit menu
  shares.
- Tests: [shortcuts.test.ts](tests/shortcuts.test.ts),
  [edit-menu.browser.ts](tests/edit-menu.browser.ts).
- First check: `bun test tooling/creative/tests/shortcuts.test.ts`.

## Errors window

- [errors.tsx](src/errors.tsx): the last Play Session's Script problems, kept
  after it ends, each linking to its Script and line. `ErrorsWindow` keeps
  them in a signal, labelled when reported, and the Preact `ErrorsPanel`
  renders `#errors-panel` (the empty note, `#error-list` and Clear) from it.
  The problems come from `PlayProblem` in [play.ts](src/play.ts).
- Tests: problem reporting in [play.test.ts](tests/play.test.ts); the window
  in [errors.browser.ts](tests/errors.browser.ts) (append, labels, opening,
  vanished owners, Clear and Close) and, during Play,
  [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/play.test.ts`.

## Variables window

- [variables.ts](src/variables.ts): the worker's read of the showing Page's
  Script Variables (`variablesOf`, from `group.inspect()`), their plain
  encoding, and the rows the page draws from them; no DOM.
- [play-host.ts](src/play-host.ts) answers the `variables` request in
  [play-protocol.ts](src/play-protocol.ts), without values when no Pump has
  run since the last one; [play-view.ts](src/play-view.ts) asks every 100 ms
  while the window is open and Play is browsing.
- [variables-window.tsx](src/variables-window.tsx): the Preact window, its
  open rows and change highlights.
- Tests: [play-host.test.ts](tests/play-host.test.ts) and
  [variables.browser.ts](tests/variables.browser.ts) on
  `/variables-test.html`.
- First check: `bun test tooling/creative/tests/play-host.test.ts`.

## Performance window

- [performance.ts](src/performance.ts): typed Run accounting, frame counts and
  recent history; [play.ts](src/play.ts) feeds reports and frame decisions.
- [play-host.ts](src/play-host.ts) and [play-protocol.ts](src/play-protocol.ts):
  opt-in capture and independent telemetry; [performance-results.ts](src/performance-results.ts)
  rejects stale session/capture snapshots.
- [performance-window.tsx](src/performance-window.tsx): rankings and charts;
  [play-view.ts](src/play-view.ts) wires capture, shortcuts and retained results.
- Tests: [performance.test.ts](tests/performance.test.ts),
  [play-host.test.ts](tests/play-host.test.ts), and the `performance` browser suite
  on `/performance-test.html`. Run `tetris` for a game integration check.
- [The Tetris benchmark](tools/bench-tetris.md) plays a scripted, seeded
  game on Element and Canvas Tetris, headless and in Chromium.
- First check: `bun test tooling/creative/tests/performance.test.ts tooling/creative/tests/play-host.test.ts`.

## Canvas Elements and the canvas Grant

- [drawing.ts](src/drawing.ts): the retained Drawing, its `clear`/`background`
  reset and limit, and project-file checks over the shared
  [canvas validation](../stack/src/canvas.ts) (ADR 0116). It also owns the
  change contract: `changesSince` gives the worker a Drawing's reset or new
  commands, and `ReceivedDrawing` applies them on the page.
- [grants/canvas.ts](src/grants/canvas.ts): the `canvas` Grant;
  [play.ts](src/play.ts) keeps each session's Drawings and holds back a
  reset Drawing while a Pump cuts off the Run that reset it;
  [play-host.ts](src/play-host.ts) sends their changes as `DrawingView`s and
  [play-mirror.ts](src/play-mirror.ts) keeps and commits them.
- [canvas-view.ts](src/canvas-view.ts): Canvas 2D painting shared by Edit and
  Play.
- Tests: [canvas.test.ts](tests/canvas.test.ts); Canvas Tetris
  ([examples/tetris-canvas.ts](src/examples/tetris-canvas.ts)) exercises a
  whole game in [tetris.test.ts](tests/tetris.test.ts).
- First check: `bun test tooling/creative/tests/canvas.test.ts`.

## User prompts

- [play.ts](src/play.ts): the `user` Grant's prompts and notices on the Play
  Session (`UserPrompt`).
- [play-prompts.ts](src/play-prompts.ts): the dialog over the Page.
- Tests: `user` cases in [play.test.ts](tests/play.test.ts),
  `runUserBrowserTests` in [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/play.test.ts -t user`.

## Grants

- [grants/](src/grants/): one module per Grant (`pages`, `elements`, `sound`,
  `user`, `folio`, `canvas`), each declaring its Operations once and building
  its Capability over the narrow state [play.ts](src/play.ts) passes in.
  [grants/grant.ts](src/grants/grant.ts) derives the Manifest entry and the
  Library declarations; [grants/index.ts](src/grants/index.ts) lists them.
- Tests: [grants.test.ts](tests/grants.test.ts) checks every Grant's
  Manifest against its Capability and runs Grants over stub state.
- First check: `bun test tooling/creative/tests/grants.test.ts`.

## Host Manifests, Code Browser and Libraries

- [script-manifest.ts](src/script-manifest.ts): each Script owner's Host
  Manifest for its language-server workspace (ADR 0084), data only.
- [script-names.ts](src/script-names.ts): binding and name checks.
- [scripts.ts](src/scripts.ts): the single Code Browser, per-source editor
  states and selected owner-scoped workspace; [code-browser-panel.tsx](src/code-browser-panel.tsx)
  renders its Project hierarchy and Library controls.
- [libraries.ts](src/libraries.ts): dependency-ordered Library compilation and
  isolated diagnostics; [play.ts](src/play.ts) registers the graph before Scripts.
  Library edits use root transactions in [tree/project-tree.ts](src/tree/project-tree.ts).
  [project-file.ts](src/project-file.ts) saves format 3 and migrates older Projects.
- [recipes.ts](src/recipes.ts): Script Recipe targets, source and placement.
  [recipe-picker.tsx](src/recipe-picker.tsx): the Preact Recipe picker, with
  its choices, preview and status as component state; it reads the CodeMirror
  view and inserts through `view.dispatch`.
- The Core's Manifest export is [manifest.ts](../../impl/ts/src/manifest.ts);
  the format is [the Host Manifest](../../spec/09-embedding.md#the-host-manifest-format).
- Tests: [libraries.test.ts](tests/libraries.test.ts), [scripts.test.ts](tests/scripts.test.ts),
  [recipes.test.ts](tests/recipes.test.ts),
  [scripts.browser.ts](tests/scripts.browser.ts),
  [recipes.browser.ts](tests/recipes.browser.ts).
- First check: `bun test tooling/creative/tests/scripts.test.ts`.

## Saving and browser storage

- [storage.ts](src/storage.ts) (IndexedDB), [autosave.ts](src/autosave.ts),
  [edit-lock.ts](src/edit-lock.ts), [projects.ts](src/projects.ts) (the
  Projects window's actions, banners and the signals its lists follow).
- [projects-window.tsx](src/projects-window.tsx): the Preact Project,
  Earlier Versions and Example Projects lists, keyed by Project id and version
  `seq`; a rename field keeps its focus and typed text while the list reloads.
- Tests: [storage.test.ts](tests/storage.test.ts) over
  [fake-indexeddb.ts](tests/fake-indexeddb.ts),
  [autosave.test.ts](tests/autosave.test.ts),
  [edit-lock.test.ts](tests/edit-lock.test.ts),
  [storage.browser.ts](tests/storage.browser.ts),
  [projects-window.browser.ts](tests/projects-window.browser.ts).
- First check: `bun test tooling/creative/tests/storage.test.ts`.

## Offline, service worker and files on disk

- [sw.ts](src/sw.ts): the service worker; [offline.ts](src/offline.ts)
  registers it and owns the update, offline and install UI;
  [file-access.ts](src/file-access.ts): Save and Save As.
- [build.ts](tools/build.ts) stamps the worker with `precacheFiles` and a
  content hash; [static/folio.webmanifest](static/folio.webmanifest) and
  [icons.ts](tools/icons.ts) make it installable.
- Tests: [service-worker.test.ts](tests/service-worker.test.ts),
  [offline.test.ts](tests/offline.test.ts),
  [file-access.test.ts](tests/file-access.test.ts),
  [build.test.ts](tests/build.test.ts),
  [offline.browser.ts](tests/offline.browser.ts).
- First check: `bun test tooling/creative/tests/service-worker.test.ts tooling/creative/tests/offline.test.ts`.

## Editor shell, Page and rich text

- [stack.ts](src/stack.ts): the Page on the desk, Tools and Info windows,
  Page resizing and strip navigation/drag events; [main.ts](src/main.ts) boots
  the page.
- [info-panel.tsx](src/info-panel.tsx): the Preact Page, Element and
  multi-selection Info panel, observing editor, name-refusal and sound-preview
  signals; field and action events are handled by the shell.
- [page-strip.tsx](src/page-strip.tsx): the Preact Pages strip, keyed by
  session-local Page ids, with memoised miniatures sharing the shell's direct
  DOM Page renderer.
- [project-title.tsx](src/project-title.tsx): the Preact Project title,
  observing the editor signal independently of the shell redraw.
- [text-editor.ts](src/text-editor.ts) over [rich-text.ts](src/rich-text.ts)
  and [rich-text-dom.ts](src/rich-text-dom.ts): in-place text editing.
- [examples/index.ts](src/examples/index.ts): the Example Projects listed in
  the Projects window, with the slugs [build.ts](tools/build.ts) writes a
  `<slug>/` page and `projects/<slug>.folio` for; [examples/lighthouse.ts](src/examples/lighthouse.ts)
  builds The Lighthouse Mystery, [examples/tetris.ts](src/examples/tetris.ts)
  builds Tetris and [examples/tetris-canvas.ts](src/examples/tetris-canvas.ts)
  builds Canvas Tetris, both over the shared
  [tetris-rules.ts](src/examples/tetris-rules.ts) Script and
  [tetris-layout.ts](src/examples/tetris-layout.ts) Page.
- Tests: [rich-text.test.ts](tests/rich-text.test.ts),
  [project-title.browser.ts](tests/project-title.browser.ts),
  [info-panel.browser.ts](tests/info-panel.browser.ts),
  [page-strip.browser.ts](tests/page-strip.browser.ts),
  [examples.test.ts](tests/examples.test.ts),
  [lighthouse.test.ts](tests/lighthouse.test.ts),
  [tetris.test.ts](tests/tetris.test.ts),
  [tetris.browser.ts](tests/tetris.browser.ts),
  [page-resize.browser.ts](tests/page-resize.browser.ts),
  [borders.browser.ts](tests/borders.browser.ts),
  [buttons.browser.ts](tests/buttons.browser.ts),
  [rich-text.browser.ts](tests/rich-text.browser.ts),
  [lighthouse.browser.ts](tests/lighthouse.browser.ts).
- First check: `bun test tooling/creative/tests/rich-text.test.ts`.
