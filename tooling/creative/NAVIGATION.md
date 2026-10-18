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
- Browser suites: with the server running, `bun run --cwd tooling/creative build:browser-tests`
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

- [play.ts](src/play.ts): the Play Session, its Group, the disposable Project
  copy, the `PlayMessage` list (`startPlay`, `openPage`, `click`, …) and
  `send`, Page navigation, `wait`, dynamic Elements, and `frame` delivery
  (`definesHandler`, `wantsFrames`, `frame`; ADR 0095).
- [play-view.ts](src/play-view.ts): Browse and Present in the browser,
  pointer and key input turned into `PlayMessage`s, and the
  `requestAnimationFrame` loop that drives `frame`.
- [play-text.ts](src/play-text.ts): reader-editable text and its history.
- Tests: [play.test.ts](tests/play.test.ts),
  [play-text.test.ts](tests/play-text.test.ts),
  [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/play.test.ts`.

## Project model and Project files

- [model.ts](src/model.ts): Projects, Pages, Elements and their properties;
  pure data, no Play State ([ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md)).
- [editing.ts](src/editing.ts): selection and authored edits, undo and redo.
- [project-file.ts](src/project-file.ts) over [zip.ts](src/zip.ts): the
  `.folio` file.
- Tests: [model.test.ts](tests/model.test.ts),
  [editing.test.ts](tests/editing.test.ts),
  [history.test.ts](tests/history.test.ts),
  [project-file.test.ts](tests/project-file.test.ts),
  [zip.test.ts](tests/zip.test.ts).
- First check: `bun test tooling/creative/tests/model.test.ts tooling/creative/tests/project-file.test.ts`.

## Images, sounds and assets

- [images.ts](src/images.ts): image intake and the session's
  content-addressed bytes, which hold sound bytes too.
- [sounds.ts](src/sounds.ts): sound intake, the `SoundBoard` and playback;
  Play wires the `sound` Grant in [play.ts](src/play.ts).
- Tests: [images.test.ts](tests/images.test.ts),
  [sounds.test.ts](tests/sounds.test.ts),
  [images.browser.ts](tests/images.browser.ts),
  [sounds.browser.ts](tests/sounds.browser.ts).
- First check: `bun test tooling/creative/tests/images.test.ts tooling/creative/tests/sounds.test.ts`.

## The folio Grant and hide/show

- [script-manifest.ts](src/script-manifest.ts): `FOLIO_COMMANDS`, the `hide`
  and `show` Operations' documentation, and the `folio` Grant in each Script's
  Manifest, both marked `command`.
- [play.ts](src/play.ts) defines the `folio` Capability and grants it to every
  Script; [message-script.ts](src/message-script.ts) builds the Message Box's
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
- [message-window.ts](src/message-window.ts): the window, built on
  [code-window.ts](src/code-window.ts).
- Tests: [message.test.ts](tests/message.test.ts),
  `runMessageBoxBrowserTests` in [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/message.test.ts`.

## Windows and code windows

- [windows.ts](src/windows.ts): the title bar and close box every floating
  window shares, show/hide/bring-forward and the Window menu. Dragging and
  positions are in [stack.ts](src/stack.ts).
- [code-window.ts](src/code-window.ts): the resizable NorthTalk editor window,
  its language-server worker and the [shared editor](../editor/src/editor.ts).
  Script windows ([scripts.ts](src/scripts.ts)) and the Message Box are both
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

- [errors.ts](src/errors.ts): the last Play Session's Script problems, kept
  after it ends, each linking to its Script and line. The problems come from
  `PlayProblem` in [play.ts](src/play.ts).
- Tests: problem reporting in [play.test.ts](tests/play.test.ts); the window
  in [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/play.test.ts`.

## User prompts

- [play.ts](src/play.ts): the `user` Grant's prompts and notices on the Play
  Session (`UserPrompt`).
- [play-prompts.ts](src/play-prompts.ts): the dialog over the Page.
- Tests: `user` cases in [play.test.ts](tests/play.test.ts),
  `runUserBrowserTests` in [play.browser.ts](tests/play.browser.ts).
- First check: `bun test tooling/creative/tests/play.test.ts -t user`.

## Host Manifests and Script windows

- [script-manifest.ts](src/script-manifest.ts): each Script owner's Host
  Manifest for its language-server workspace (ADR 0084), data only.
- [script-names.ts](src/script-names.ts): binding and name checks.
- [scripts.ts](src/scripts.ts): one editor and workspace per Script.
- [recipes.ts](src/recipes.ts): Script Recipe targets, source and placement.
  [recipe-picker.tsx](src/recipe-picker.tsx): the Preact Recipe picker, with
  its choices, preview and status as component state; it reads the CodeMirror
  view and inserts through `view.dispatch`.
- The Core's Manifest export is [manifest.ts](../../impl/ts/src/manifest.ts);
  the format is [the Host Manifest](../../spec/09-embedding.md#the-host-manifest-format).
- Tests: [scripts.test.ts](tests/scripts.test.ts),
  [recipes.test.ts](tests/recipes.test.ts),
  [scripts.browser.ts](tests/scripts.browser.ts),
  [recipes.browser.ts](tests/recipes.browser.ts).
- First check: `bun test tooling/creative/tests/scripts.test.ts`.

## Saving and browser storage

- [storage.ts](src/storage.ts) (IndexedDB), [autosave.ts](src/autosave.ts),
  [edit-lock.ts](src/edit-lock.ts), [projects.ts](src/projects.ts) (the
  Projects window and banners).
- Tests: [storage.test.ts](tests/storage.test.ts) over
  [fake-indexeddb.ts](tests/fake-indexeddb.ts),
  [autosave.test.ts](tests/autosave.test.ts),
  [edit-lock.test.ts](tests/edit-lock.test.ts),
  [storage.browser.ts](tests/storage.browser.ts).
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
  the Projects window; [examples/lighthouse.ts](src/examples/lighthouse.ts)
  builds The Lighthouse Mystery and [examples/tetris.ts](src/examples/tetris.ts)
  builds Tetris.
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
  [rich-text.browser.ts](tests/rich-text.browser.ts),
  [lighthouse.browser.ts](tests/lighthouse.browser.ts).
- First check: `bun test tooling/creative/tests/rich-text.test.ts`.
