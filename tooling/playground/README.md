# NorthTalk Playground

The browser counterpart of the REPL, on the TS Core ([chapter 12](../../spec/12-sessions-and-tooling.md#the-playground)). A Playground session is an ordinary Session Host, so everything it prints and records is the same as the REPL's. The page itself is tooling, and none of it is normative ([ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Running it

From a clean checkout, with Bun 1.4.2, at the repository root:

```sh
bun install
bun run playground                        # serve at http://127.0.0.1:3927/, rebuilding on change
bun run --cwd tooling/playground build    # write a static dist/
bun run --cwd tooling/playground start    # build once and serve dist/
bun run --cwd tooling/playground test     # the session, Apply and link tests
```

`dist/` is static: `index.html`, `style.css`, `main.js` and the two workers, `session.worker.js` and `lsp.worker.js`. Any web server can host it, with no server-side code. Set `PORT` to serve on another port.

## What it does

- **The Script tab is the session source** ([ADR 0051](../../docs/adr/0051-the-playgrounds-script-tab-is-the-session-source.md)):
  - **Apply** (Ctrl/Cmd-S in the tab) enters each new or changed top-level declaration as an Entry. A redefinition causes the Spec's Reload, which prints `! discarded` for each Run it discards.
  - A declaration entered at the prompt updates a clean tab. A tab with unapplied edits keeps them under a banner.
  - When the tab drops a declaration, Apply offers a **Restart**. A Restart makes a fresh session from the Grants, the Clock and limits, the Library tabs and the Script tab, and starts a new Transcript.
- **Library tabs:** **+ Library** adds one. Saving it (Ctrl/Cmd-S) records `:library add` the first time and `:library replace` after that. Renaming or closing a saved Library needs a Restart to take it out of the session.
- **The console** is the live Session Transcript.
  - Enter Entries and Session Commands at the `>` prompt. An unfinished Entry goes on at `|`, and an empty line ends it.
  - A `console` `read` is answered at the `<` prompt.
  - **Cancel** or Esc is `:cancel`, and `:help` lists the commands.
  - The **@ ~** box shows the Clock readings and Capability answers the Transcript records.
- **Grants:** before the session starts, the Grants panel issues `:grant` and `:mock`.
  - The built-in Capabilities are `clock` and the `Intl`-based `calendar` and `locale` shared with the REPL ([`builtins.ts`](../stack/src/builtins.ts)).
  - The Playground's Host Manifest is built from the session's Grants and given to the language server, so completion and hover know them.
- **Editing:** the language server runs in a worker with the formatter and the Lints.
  - It gives diagnostics, completion, hover, suspension marks, go to definition (F12), references (Shift-F12), rename (F2) and **Format**.
  - **Lints** chooses the `beginner` (the default) or `standard` Lint Profile.
- **Live debugging:** click the gutter to set a breakpoint in the Script tab or a saved Library tab.
  - A breakpoint pauses the whole session during any Run, and the tab shows the paused line. While paused, the prompt waits.
  - Continue, Step, Over and Out work as chapter 12 describes. The panel shows the frames with their locals, and the session's runs, mailbox and Script Variables.
  - The pause isn't a Host Input, so the Transcript and the Trace are as they would be without it, and the paused time doesn't count on the Clock.
  - A breakpoint in a tab with unapplied edits is shown faded until Apply or a save loads it.
- **Replay debugging:** the Replay debugger replays a Trace on the TS Core.
  - With no Trace pasted, it replays this session, or a Shared Link's Transcript that replayed differently.
  - A pasted Trace from another Host needs its Setup as JSON (a `case.toml` converted to JSON). The Setup's source files come from tabs of the same name, and the panel asks for any it can't find.
  - Breakpoints are `unit:line`. **Back** steps backwards, and **Run to Host Input** seeks to a Host Input.
- **Sharing:** **Share** makes a Shared Link.
  - The link's fragment carries the tabs and, optionally, the Session Transcript, deflated and base64url-encoded, so it never reaches a server.
  - Opening a link replays its Transcript, then goes on live. If the replay prints differently, the page shows the first differing line, never goes live, and leaves the replay debugger to step through what did replay.
  - **Transcript** downloads `session.transcript`, which `bun run northtalk replay` replays.
- **Autosave:** the tabs, the Lint Profile and the **@ ~** choice are kept in `localStorage`.
  - On load they open as unapplied edits in an empty session, and nothing runs until you Apply. The session itself is never saved.

## Layout

- [`src/session.ts`](src/session.ts): the Playground session over the Session Host. It handles Apply, Restart, Library saves, breakpoint mapping, pause views and opening a Transcript. It does no I/O and is tested under Bun.
- [`src/declarations.ts`](src/declarations.ts): splits a tab into top-level declarations with the Core's parser, and plans Apply.
- [`src/session.worker.ts`](src/session.worker.ts): the Playground Host. It holds the session, its deadline timers and the replay debugger.
- [`src/lsp.worker.ts`](src/lsp.worker.ts): the tooling stack's language server over `postMessage`.
- [`src/main.ts`](src/main.ts), [`src/editor.ts`](src/editor.ts), [`src/lsp-client.ts`](src/lsp-client.ts): the page, the CodeMirror 6 editor, and its LSP client.
- [`src/link.ts`](src/link.ts): the Shared Link codec. [`src/protocol.ts`](src/protocol.ts): the worker messages.

## The corpus in a browser

```sh
bun run --cwd tooling/playground test:browser
```

This serves a page at http://127.0.0.1:3928/. Open it in a browser and it runs every blessed Trace Case and Session Transcript that `corpus:run` runs by default, on the TS Core in that browser.

- **The same checks:** it uses [`case-checks.ts`](../../impl/ts/tools/case-checks.ts), which the Bun runner uses too. For a Trace Case it replays twice, the second time restoring between Pumps. For a Transcript it compares the replayed lines, then replays the Trace as a Trace Case.
- **Results:** the page reports each case and a summary. `document.body.dataset.done` is `pass` or `fail` once it finishes.
- **What it leaves out:** Value Encoding and Disassembly Cases run only under Bun, and CI doesn't open the page.
