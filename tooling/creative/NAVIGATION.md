# Folio task navigation

Find your task's heading, then open the listed files and run its first check.
Behaviour and limitations are in the [Folio guide](README.md); domain terms in
[GLOSSARY.md](../../GLOSSARY.md#browser-authoring); rationale in the
[ADR index](../../docs/adr/README.md). Commands run from the repository root.
List files with `rg --files tooling/creative` before opening one by name.

Read only your section, e.g.
`sed -n '/^## Mini-Notation/,/^## /p' tooling/creative/NAVIGATION.md`.
Sections: Running and testing; Play Session and reader input; Project model and Project files; Palettes; Group Elements; Images, sounds and assets; Audio engines; Transport and beat; Instruments; Built-in kits; Mini-Notation; Sound Patterns; Punch In; The folio Grant and hide/show; Message Box; Windows and code windows; Menus; Errors window; Variables window; Breakpoints; Performance window; Canvas Elements and the canvas Grant; User prompts; Grants; Host Manifests, Code Browser and Libraries; Saving and browser storage; Offline, service worker and files on disk; Editor shell, Page and rich text.

Music work belongs to map #1887; its task list shows which children have
landed, and the Issue graph job ticks it as they close.

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
  `--suite play,tetris` runs a subset, `--headed` shows the browser,
  `--timeout` sets each step's limit and `--run-timeout` (default 300000 ms)
  fails a run that hangs. Once per
  machine: `bunx playwright install chromium-headless-shell`.
  The `instruments` suite fails on `main` until #1946 is fixed.
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
- [pointer.ts](src/pointer.ts): the `click` and `pointerHeld` maps
  (ADR 0145) and the Harness's default click;
  [click-migration.ts](src/click-migration.ts) is format 5's rewrite of
  `on click`, and [click-advice.ts](src/click-advice.ts) the Code Browser's
  advice about `click` clauses.
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
- [elements/](src/elements/registry.ts): one definition per Element kind
  ([definition.ts](src/elements/definition.ts)): its properties, defaults,
  styles, file checks and migrations, and what Play sends the page. What it
  draws and its Info controls are in [views.tsx](src/elements/views.tsx), so
  the CLI and the Play worker load no JSX. Ask `kindOf(element)` rather than
  branching on `kind`; the registry's header lists the branches that remain,
  and why. A new kind is a new file registered in both.
- Add-ons (ADR 0162, #1901): `Project.addOns` lists them by URL, and
  [add-on.ts](src/elements/add-on.ts) reads kinds named `<url>#<name>`. Until
  a loader registers one, `kindOf` gives the placeholder definition, which
  keeps the file form in `saved`; Scripts see it as the `placeholder` Object
  Kind (`scriptKindOf`), and Play reports it in the Errors window. In-memory
  Projects are checked in their saved form. Tests:
  [add-ons.test.ts](tests/add-ons.test.ts).
- The controls Add-on (#1902): [add-ons/controls/](src/add-ons/controls/index.ts)
  has the slider, knob, toggle, XY pad and level meter. A view's `change`
  prop ([views.tsx](src/elements/views.tsx)) reaches
  [play-view.ts](src/play-view.ts)'s `control`, which merges a drag's
  changes into one `control` request at a time; the worker's
  `PlaySession.control` sets the fields and sends `change`. Tests:
  [controls.test.ts](tests/controls.test.ts) and the `controls` browser suite.
- Bindings (#1904): [bindings.ts](src/bindings.ts) reads, checks and applies
  an Element's `bindings`, which a kind allows through its definition's
  `bindings`. The page sends a bound parameter to the worklet itself
  (`InstrumentAudio.send`) and marks the `control` request `applied`, so
  `PlaySession.control` only records it; tempo is set on the worker's
  Transport. Meters bound to an output take the worklet's `levels`
  ([rack.ts](src/instruments/rack.ts)) in `play-view.ts`'s `showLevels`.
  Info's menus are `BindingFields` in [info-panel.tsx](src/info-panel.tsx);
  the tree's `setBinding` takes the target's range, and renaming an
  Instrument renames its bindings. Tests: [bindings.test.ts](tests/bindings.test.ts)
  through the harness's `control`, and the `bindings` browser suite.
- Loading Add-ons (#1901): an Add-on module ([add-ons/api.ts](src/add-ons/api.ts))
  imports nothing from Folio; Folio passes its kinds' data and view factories
  their helpers and Preact. [catalogue.ts](src/add-ons/catalogue.ts) lists the
  built-in ones, which [build.ts](tools/build.ts) writes as `add-ons/<slug>-<version>.js`
  and the service worker keeps on demand. [loader.ts](src/add-ons/loader.ts)
  registers kinds with the registry and `elementShape`;
  [page.ts](src/add-ons/page.ts) is the page's loader, which also registers
  views, and [play.worker.ts](src/play.worker.ts) loads a session's Add-ons
  before opening it. [project.ts](src/add-ons/project.ts)'s
  `projectWithAddOns` reads a Project again once its Add-ons load, turning
  placeholders into their kinds; [projects.ts](src/projects.ts) calls it on
  every open. [offered.ts](src/add-ons/offered.ts) says which kinds the Tools window and Info's Instrument menu offer: only those of the Add-ons the Project lists (#2025), loaded on first use; Project ▸ Add-ons… ([add-ons-dialog.ts](src/add-ons/add-ons-dialog.ts)) ticks them, and the tree's `stopUsingAddOn` refuses one in use. Tests: [offered-add-ons.test.ts](tests/offered-add-ons.test.ts).
  Project Add-ons import from a `blob:` URL once [trust.ts](src/add-ons/trust.ts)
  holds their hash; [trust-prompt.ts](src/add-ons/trust-prompt.ts) asks on
  opening, Base Project copies are trusted, a placeholder's Info offers
  "Load Add-on…", and the Play worker runs the hashes the page sends.
  Tests: [add-on-loader.test.ts](tests/add-on-loader.test.ts), the
  `add-ons` browser suite, and [fixtures/counter-add-on.ts](tests/fixtures/counter-add-on.ts).
- [project-file.ts](src/project-file.ts) over [zip.ts](src/zip.ts): the
  `.folio` file.
- Tests: [model.test.ts](tests/model.test.ts),
  [editing.test.ts](tests/editing.test.ts),
  [history.test.ts](tests/history.test.ts),
  [project-file.test.ts](tests/project-file.test.ts),
  [zip.test.ts](tests/zip.test.ts).
- First check: `bun test tooling/creative/tests/model.test.ts tooling/creative/tests/project-file.test.ts`.

## Palettes

- Model (#1903): a Palette is a `Page` with `palette` settings, kept after
  the Pages in `Project.pages`; [model.ts](src/model.ts) has `pagesOf`,
  `palettesOf`, `pageCount` and `pageWidth`. Page indices therefore count
  Pages only, and every Page-wide rule covers Palettes. The file form is a
  separate `palettes` list in [project-file.ts](src/project-file.ts).
- Edit: `addPalette` and the Pages-or-Palettes rules for moving, stepping
  and deleting in [editing.ts](src/editing.ts) and
  [tree/project-tree.ts](src/tree/project-tree.ts); the `paletteTitle`,
  `paletteWidth` and `openOnPlay` properties in
  [tree/properties.ts](src/tree/properties.ts); Info in
  [info-panel.tsx](src/info-panel.tsx); the strip in
  [page-strip.tsx](src/page-strip.tsx).
- Play: [play.ts](src/play.ts) loads Palette Scripts at start, keeps
  `openPalettes`, and routes `show`/`hide` of a Palette there
  ([grants/folio.ts](src/grants/folio.ts)). [play-host.ts](src/play-host.ts)
  sends each changed Palette whole as a `PaletteView`;
  [play-mirror.ts](src/play-mirror.ts) keeps them; and
  [palette-windows.ts](src/palette-windows.ts) draws the windows and Window
  menu items for [play-view.ts](src/play-view.ts).
- Tests: [palettes.test.ts](tests/palettes.test.ts), Palette cases in
  [play-host.test.ts](tests/play-host.test.ts), and the `palettes` browser
  suite.
- First check: `bun test tooling/creative/tests/palettes.test.ts`.

## Add-on signing

- [add-ons/signing.ts](src/add-ons/signing.ts) (#1967): the shipped public
  key, `verifyAddOn`, `addOnsToAsk` (used by `addOnsFor` in
  [projects.ts](src/projects.ts)) and `signForPublishing` (used by
  [tools/build.ts](tools/build.ts)); [add-ons/trust.ts](src/add-ons/trust.ts)
  `vouch` trusts a verified hash for the visit.
  [tools/add-on-key.ts](tools/add-on-key.ts) makes a key pair.
- Tests: [add-on-signing.test.ts](tests/add-on-signing.test.ts) and the
  WebCrypto case in the `add-ons` browser suite.

## Perform

- [perform-layout.ts](src/perform-layout.ts): the Perform layout (#1999):
  stage, divider and docked Code Browser, with the divider and code zoom
  kept per Project in browser storage. [play-view.ts](src/play-view.ts)
  starts the `perform` Play mode and ⌘+/⌘−. Its one header button plays the
  Project's way, `Project.play` (#2028), which Project ▸ Play by Performing
  sets; ⌘⇧↩ (`isPerformKey` in [shortcuts.ts](src/shortcuts.ts)) plays the
  other way once. Format 12's
  [controls/migration.ts](src/add-ons/controls/migration.ts) makes Music
  copies perform and lists the controls Add-on where controls are used.
  Tests: [play-by-performing.test.ts](tests/play-by-performing.test.ts).
- Code pane (#2000): `recentTabs`, the tab bar and the error banner are in
  perform-layout.ts; [scripts.ts](src/scripts.ts) `onShow`/`show` feed the
  tabs through `shell.code`; play-view.ts handles ⌥-click and lets Punch In
  run while performing (`punching` in [play-controls.ts](src/play-controls.ts)).
- Docked Palettes (#2001): `PaletteSettings.float` (file `float`, Info
  `floatInPerform`); [palette-windows.ts](src/palette-windows.ts) docks a
  window in the layout's `palettes` column through its `dock` option.
- Toolbar (#2002): `PlaySession.hush` in [play.ts](src/play.ts) behind the
  `hush` request; [play-host.ts](src/play-host.ts) sends a `TransportView`
  anchor that `clockText` in perform-layout.ts counts on from; Revert uses
  `shell.code.replace` with play-view.ts's loaded source.
- Tests: [perform-layout.test.ts](tests/perform-layout.test.ts) and the
  `perform`, `perform-code`, `perform-palettes` and `perform-toolbar`
  browser suites, and the Hush case in
  [sound-patterns.test.ts](tests/sound-patterns.test.ts).
- First check: `bun test tooling/creative/tests/perform-layout.test.ts`.

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
- [sounds-window.tsx](src/sounds-window.tsx): the Sounds window's list,
  placeholders and Add, Rename… and Remove… buttons; [stack.ts](src/stack.ts)
  wires its clicks to [sound-dialogs.ts](src/sound-dialogs.ts).
- [sound-uses.ts](src/sound-uses.ts): a sound's literal uses in Scripts and
  Libraries, rewritten by `StackEditor.renameSound` (#2050).
- Tests: [images.test.ts](tests/images.test.ts),
  [sounds.test.ts](tests/sounds.test.ts),
  [sound-uses.test.ts](tests/sound-uses.test.ts),
  [images.browser.ts](tests/images.browser.ts),
  [sounds.browser.ts](tests/sounds.browser.ts),
  [info-panel.browser.ts](tests/info-panel.browser.ts) (the Sounds window).
- First check: `bun test tooling/creative/tests/images.test.ts tooling/creative/tests/sounds.test.ts`.

## Audio engines

Headless engines for Folio's Instruments (#1887), copied from Mercenary and
WIME. Nothing in Folio uses them yet. Each file's header names the repository,
path and commit it came from. No original game's sound assets are included.

- [audio/chip-host.ts](src/audio/chip-host.ts): the `Chip` interface
  (`render(count)` plus timed commands), `ChipHost`, which applies each
  `SoundBatch` on its own sample, and `renderOffline`.
- [audio/ym2149.ts](src/audio/ym2149.ts): the Atari ST's YM2149 and
  `ym2149Chip`, which takes register writes.
- [audio/sonix/](src/audio/sonix/): the Sonix waveform synth
  ([synth.ts](src/audio/sonix/synth.ts)), its four-voice
  [mixer.ts](src/audio/sonix/mixer.ts) and
  [tables.ts](src/audio/sonix/tables.ts), under nuade's MIT notice, plus
  [wave-synth.ts](src/audio/sonix/wave-synth.ts), the new `Chip` built on them.
- Tests: [engines.test.ts](tests/audio/engines.test.ts) checks the golden
  hashes in [goldens.json](tests/audio/goldens.json) for the scenarios in
  [scenarios.ts](tests/audio/scenarios.ts).
  [audio-goldens.ts](tools/audio-goldens.ts) regenerates those hashes from
  checkouts of the originals, and fails if a copy renders differently.
- First check: `bun test tooling/creative/tests/audio`.

## Transport and beat

- [transport.ts](src/transport.ts): the Transport's tempo, beat grid on the
  Play clock, Meters (a time signature from its bar line), the lead, which
  beats are due, and Scripts' musical Waits (`wait 8 bars`, ADR 0166).
- [play.ts](src/play.ts): `PlaySession.pump` delivers due beats to Scripts
  that handle `beat`, ends musical Waits a lead before their line through the
  Group's musical clock, remembers each `beat` Delivery's and resumed Run's
  musical time for `musicalTimeOf`, and folds the next beat and Wait into
  `nextDeadline`, so the Play worker and the harness need no beat scheduling
  of their own. `hush` cancels the Runs waiting in bars or beats.
- [grants/transport.ts](src/grants/transport.ts): the `transport` Grant.
  [instruments/session.ts](src/instruments/session.ts) times sounds from the
  call's beat Delivery and `at`.
- [audio-clock.ts](src/audio-clock.ts): the Play clock of a session with
  Instruments, the page's audio clock plus the margin (ADR 0156).
  [play-host.ts](src/play-host.ts) reads it from `audioClock` requests, freezes
  it on Pause and Breakpoints, and turns sound times into audio times;
  [instruments/audio.ts](src/instruments/audio.ts) sends the readings and
  suspends the AudioContext while paused.
- Tests: [transport.test.ts](tests/transport.test.ts) covers the grid, tempo
  and time-signature changes, Waits, `beat` delivery, sound times,
  `wait 2 beats` and Pause; [musical-time.test.ts](tests/musical-time.test.ts)
  plays arrangements with `wait N bars` on Perform and Punch In, with Hush
  and Stop; [audio-clock.test.ts](tests/audio-clock.test.ts) covers the clock.
- First check: `bun test tooling/creative/tests/transport.test.ts tooling/creative/tests/musical-time.test.ts tooling/creative/tests/audio-clock.test.ts`.
- Browser: `beats` suite on `/beats-test.html` plays beats through the real
  worklet and checks each note's sample.

## Instruments

Instrument kinds, editing in the Instruments window and Play wiring (ADR 0158,
#1894, #2049).

- The synth and YM2149 are the built-in Instruments Add-on (#1901):
  [add-ons/instruments/](src/add-ons/instruments/index.ts) registers their
  kinds, named `https://northtalk.org/add-ons/instruments#synth`, and its
  [worklet.ts](src/add-ons/instruments/worklet.ts) their engines in the audio
  worklet ([worklet-engines.ts](src/instruments/worklet-engines.ts)).
  [ids.ts](src/add-ons/instruments/ids.ts) names them without loading them;
  [migration.ts](src/add-ons/instruments/migration.ts) is format 10. Only the
  sampler stays in Folio. Tests register it with
  [helpers/instruments.ts](tests/helpers/instruments.ts).
- [instruments/kind.ts](src/instruments/kind.ts): an `InstrumentEngine`
  (parameters, voice cap and Chip factory), the `InstrumentKind` that adds
  its Operations, the `InstrumentCommand`s a Chip takes, and parameter checks.
- One engine module per kind, each importing only `kind.ts`, the notes and its
  chip, never the Core: [sampler.ts](src/instruments/sampler.ts),
  [ym2149.ts](src/instruments/ym2149.ts) and
  [synth.ts](src/instruments/synth.ts), listed in
  [engines.ts](src/instruments/engines.ts).
  [notes.ts](src/instruments/notes.ts) reads note names and numbers.
- [instruments/registry.ts](src/instruments/registry.ts): every kind with its
  Operations from [operations.ts](src/instruments/operations.ts),
  `createInstrument`, `instrumentProblems` (names, voices, parameters and the
  `SESSION_VOICES` cap) and the names an Instrument can't take.
- [instruments/session.ts](src/instruments/session.ts): a Play Session's
  Instruments. Each one is a Grant over its kind's Capability (`tell bass to
play "c3"`) and an object whose properties are its parameters (`set the
cutoff of bass to 800`). Both send `InstrumentMessage`s, which
  [play-host.ts](src/play-host.ts) posts to the page as `instrument`
  responses. [play.ts](src/play.ts) binds them for every Script;
  [script-manifest.ts](src/script-manifest.ts) lists them, and
  [script-names.ts](src/script-names.ts) refuses Pages and Elements that
  share their names.
- [instruments/parameter-units.ts](src/instruments/parameter-units.ts): a
  number parameter that names a Catalogue Unit, such as the synth's `cutoff`
  in `Hz`, takes any Quantity of that Unit's Kind (`2 kHz`) and keeps a plain
  number in its Unit (ADR 0166, #2067). Its Shape is the property's and the
  Manifest's.
- [instruments/kind.ts](src/instruments/kind.ts): a parameter's `group`
  names its collapsible section in the Instruments window, and a number
  parameter's `scale: 'log'` makes its slider logarithmic (#2078). Add-on
  kinds set both; the Manifest does not describe them.
- [instruments/audio.ts](src/instruments/audio.ts): the page's AudioContext,
  started by [play-view.ts](src/play-view.ts) when a session has Instruments.
  It decodes the Project's sounds for samplers and runs
  [instruments.worklet.ts](src/instruments/instruments.worklet.ts), whose
  [rack.ts](src/instruments/rack.ts) mixes every Instrument's Chip.
- Editing: [tree/project-tree.ts](src/tree/project-tree.ts)'s
  `addInstrument`, `changeInstrument` and `removeInstrument` check every
  change; [instruments-window.tsx](src/instruments-window.tsx) lists them
  and shows the selected one's fields, and [stack.ts](src/stack.ts) commits
  them.
- `Project.instruments` is in [model.ts](src/model.ts);
  [project-file.ts](src/project-file.ts) checks them and migrates format 5
  Projects to format 6.
- Tests: [instruments.test.ts](tests/instruments/instruments.test.ts) renders
  each kind offline and round-trips Instruments through a Project file;
  [play.test.ts](tests/instruments/play.test.ts) covers Scripts, the
  Manifest, names and the rack; [editing.test.ts](tests/instruments/editing.test.ts)
  covers the tree's changes and history.
- First check: `bun test tooling/creative/tests/instruments`.
- Browser: `instruments` suite on `/instruments-test.html` covers Info and the
  built worklet; also run `info-panel` and `sounds`.

## Built-in kits

The sample kits Folio ships (ADR 0158, #1895), synthesised and CC0.

- [kits/kits.ts](src/kits/kits.ts): each kit's samples, source and licence,
  `DEFAULT_KIT`, the `DEFAULT_KIT_INSTRUMENT` sampler a pattern without `on`
  plays, `kitSampleKey` for `name:n`, `KIT_FILES`, and `KIT_BUDGET_BYTES`.
  [kits/synth.ts](src/kits/synth.ts) holds the oscillators, noise and filters;
  [wav.ts](src/wav.ts) encodes WAV.
- [tools/build.ts](tools/build.ts) writes `kits/<kit>/<name>.wav` and
  `kits/LICENSE.txt` and precaches them.
  [instruments/audio.ts](src/instruments/audio.ts) fetches and decodes them
  for every sampler, ahead of the Project's sounds, and adds the default kit's
  sampler; [pattern-checks.ts](src/pattern-checks.ts) knows their names.
- Tests: [kits.test.ts](tests/kits.test.ts) covers licences, names, variants,
  the WAVs and the rack; [build.test.ts](tests/build.test.ts) checks the
  budget and precache.
- First check: `bun test tooling/creative/tests/kits.test.ts`.

## Mini-Notation

Folio's own Mini-Notation parser and its checks (ADR 0159, #1893).

- [mini-notation.ts](src/mini-notation.ts): `parseMiniNotation` reads
  sequences, `-` rests, `[ ]`, `< >`, `*n`, `/n`, `,`, `name:n` and note
  names into a `Pattern`, whose `cycle(n)` and `query` give events with exact
  `Time`s and each step's character range; errors carry a range too.
- [pattern-checks.ts](src/pattern-checks.ts): finds literal texts given to
  `play` or `loop` as Host Commands or told to `sound`, and reports syntax
  errors and unknown sound names. [play.ts](src/play.ts) adds them to
  `problems` when a Script loads, without stopping it; [scripts.ts](src/scripts.ts)
  underlines them in the Code Browser. A text that names a whole Project
  sound passes.
- Tests: [mini-notation.test.ts](tests/mini-notation.test.ts) and
  [pattern-checks.test.ts](tests/pattern-checks.test.ts).
- First check: `bun test tooling/creative/tests/mini-notation.test.ts tooling/creative/tests/pattern-checks.test.ts`.

## Sound Patterns

`play`, `loop` and `stop` (ADR 0159, #1896).

- [sound-patterns.ts](src/sound-patterns.ts): `SoundPatterns` keeps each
  Script's loops, one per Instrument, and `play`'s one-shot steps, and sends
  each step one lead ahead on the Transport; `schedule` and `nextDeadline`
  run from `PlaySession.pump`.
- [grants/sound.ts](src/grants/sound.ts): the Host Commands, with `on` and
  `with` as Argument Labels (ADR 0160). [play.ts](src/play.ts) resolves the
  Instrument and options, checks texts built at run time, plays a whole
  Project sound, and stops an owner's patterns with its sounds.
- [sound-migration.ts](src/sound-migration.ts): format 7's rewrite of
  `tell sound to loop` to `play … with {repeat: true}`.
- [message.ts](src/message.ts) and
  [instruments/preview.ts](src/instruments/preview.ts): Edit's preview of
  `play`. [pattern-checks.ts](src/pattern-checks.ts)'s
  `needsInstrumentAudio` decides whether Browse starts the audio.
- Recipes: **Loop a pattern** (`loopPattern` in [recipes.ts](src/recipes.ts));
  [examples/first-sounds.ts](src/examples/first-sounds.ts) teaches patterns.
- Tests: [sound-patterns.test.ts](tests/sound-patterns.test.ts),
  [sound-migration.test.ts](tests/sound-migration.test.ts), Message Box
  cases in [message.test.ts](tests/message.test.ts).
- First check: `bun test tooling/creative/tests/sound-patterns.test.ts`.
- Browser: `beats` suite on `/beats-test.html`.

## Punch In

Loading an edited Script or Library into a browsing session (ADR 0157, #1897).

- [play.ts](src/play.ts): `PlaySession.punchIn` queues it, at once or for
  the next bar if the Script keeps musical time; `pump` applies it first,
  reloading with `carry variables` and the mailbox kept (a Library through
  `replaceLibrary`), then sends `openScript`, which `#load` also sends.
  [sound-patterns.ts](src/sound-patterns.ts)'s `punchedAt` holds the new
  loops to the punch bar for that Pump.
- [play-host.ts](src/play-host.ts) answers the `punchIn` request
  ([play-protocol.ts](src/play-protocol.ts)); [scripts.ts](src/scripts.ts)
  binds ⌘↩ and shows the note, [edit-menu.tsx](src/edit-menu.tsx) has the
  command, and [play-view.ts](src/play-view.ts) sends it.
- Tests: [punch-in.test.ts](tests/punch-in.test.ts) covers the session and
  Pause through the host; [punch-in.browser.ts](tests/punch-in.browser.ts).
- First check: `bun test tooling/creative/tests/punch-in.test.ts`.
- Browser: `punch-in` suite on `/punch-in-test.html`.

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

- [menus.ts](src/menus.ts): opening and closing the header's Folio, File,
  Edit and Project menus, and the About window; the Window menu is in
  [windows.ts](src/windows.ts). The Folio, File and Project menus are static HTML; Project ▸ Add-ons… and Add Sound from Music… ([music-sounds-dialog.ts](src/music-sounds-dialog.ts), #2027) are wired in [stack.ts](src/stack.ts).
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
  The problems come from `PlayProblem` in [play.ts](src/play.ts). Its Pause
  on errors option reaches the worker as `pauseOnErrors`, which
  [play-host.ts](src/play-host.ts) turns into the Core's
  `pauseOn({ uncaughtError })`; a stop is then a Breakpoint's.
  A problem whose message `musicSoundIn` ([sounds.ts](src/sounds.ts)) reads
  as a missing Music sound gets an Add from Music button calling the shell's
  `addMusicSound` (#2033).
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

## Breakpoints

- [play-host.ts](src/play-host.ts) places `breakpoints` requests in the loaded
  code through the Group's debug controller, turns a stop into a Pause, sends
  the stopped Run's frames as `stoppedRun`, and continues it on `resume`
  or moves it on `statementStep`; while stopped it answers Watches and
  `message` requests in the `selectFrame` frame through `debug.evaluate`;
  [play.ts](src/play.ts) holds the controller and the debugger-aware Pump.
- [scripts.ts](src/scripts.ts) adds the shared editor's breakpoint gutter
  (`@northtalk/editor/breakpoints`), fades Breakpoints in edited source and
  shows the paused line; [play-view.ts](src/play-view.ts) sends them and
  shows stops; [variables-window.tsx](src/variables-window.tsx) draws frames.
- Tests: [play-host.test.ts](tests/play-host.test.ts) and
  [breakpoints.browser.ts](tests/breakpoints.browser.ts).
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
  `user`, `folio`, `canvas`, `transport`), each declaring its Operations once and building
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
  renders its Sources, Scripts and Handlers columns and Library and Test
  Script controls. [dictionary-window.tsx](src/dictionary-window.tsx) is the
  Dictionary window over `readDictionary` in [dictionary.ts](../stack/src/dictionary.ts);
  right-click finds its target with `operationAt` in
  [features.ts](../stack/src/lsp/features.ts), and
  [context-menu.ts](src/context-menu.ts) is the menu.
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
- [element-view.tsx](src/element-view.tsx): `ElementView`, the Preact
  component that draws an Element on the desk, in the Page strip and in Play
  (ADR 0146), and `renderElements`, which renders a Page's layer of them.
- [info-panel.tsx](src/info-panel.tsx): the Preact Page, Element and
  multi-selection Info panel, observing editor and name-refusal signals;
  field and action events are handled by the shell.
- [instruments-window.tsx](src/instruments-window.tsx): the Instruments
  window's list and the selected Instrument's fields (#2049).
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
  [examples/sonar.ts](src/examples/sonar.ts) builds Sonar, one Canvas
  driven by `frame`, `click`'s map and `pointerHeld`, played through in
  [sonar.test.ts](tests/sonar.test.ts).
  [examples/first-sounds.ts](src/examples/first-sounds.ts) builds First
  Sounds, one Page per `LESSONS` entry with a generated Page Script, played
  through in [first-sounds.test.ts](tests/first-sounds.test.ts) with the
  harness's `advance` and `notes`; browser suite `first-sounds`.
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
