# NorthTalk Playground

**Session observation:** the [Session observation contract](../../spec/session-observation.md) is implemented here; coordinated release review remains in #370. The prompt and Script-tab Apply retain `--|` Declaration Documentation, and editor hover shares the Core's extraction and Built-in catalogue. `:trace`, `:untrace` and `:fuel` work as in the Session Host, including a multiline `:fuel` Entry ([#438](https://github.com/odogono/odgn-talk/issues/438)). `:describe` and `:apropos` share the Session Host's passive metadata and name discovery ([#437](https://github.com/odogono/odgn-talk/issues/437)). `:inspect` and `%` object Transcript replay use the shared Session Host ([#439](https://github.com/odogono/odgn-talk/issues/439)); new recordings include empty setup even when there are no Host Objects.


The browser counterpart of the REPL, on the TS Core ([chapter 12](../../spec/12-sessions-and-tooling.md#the-playground)). It is published at <https://opendoorgonorth.com/odgn-talk/>. A Playground session is an ordinary Session Host, so everything it prints and records is the same as the REPL's. The page itself is tooling, and none of it is normative ([ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Running it

From a clean checkout, with Bun 1.4.2, at the repository root:

```sh
bun install
bun run playground                        # serve at http://127.0.0.1:3927/, rebuilding on change
bun run --cwd tooling/playground build    # write a static dist/
bun run --cwd tooling/playground start    # build once and serve dist/
bun run --cwd tooling/playground test     # the session, Apply and link tests
```

`dist/` is static: `index.html`, `style.css`, `main.js` and the workers, `session.worker.js`, `lsp.worker.js` and `syntax.worker.js`. Any web server can host it, with no server-side code. Set `PORT` to serve on another port.

## Publishing

The [Playground workflow](../../.github/workflows/playground.yml) builds `dist/` on each push to `main` and publishes it to GitHub Pages, at <https://opendoorgonorth.com/odgn-talk/>. A Shared Link made there is that URL plus its `#v1.…` fragment.

- **The sub-path:** Pages serves the page under `/odgn-talk/`. The page loads its styles, script and workers relative to itself, and Pages redirects `/odgn-talk` to `/odgn-talk/`, so nothing names the sub-path.
- **Source maps** are published with the scripts. They add about 12 MB to the site, but a browser fetches them only when its developer tools are open, and they make errors reported from the published site readable.
- **The domain:** the account's Pages site has the custom domain `opendoorgonorth.com`, so `odogono.github.io/odgn-talk/` redirects there.
- **Repository setting:** Pages must use GitHub Actions as its source (Settings → Pages → Build and deployment).

## What it does

A leading `--|` block keeps the prompt open until its declaration is complete. Blank lines and ordinary comments break attachment; a block directly before an expression, statement or Import is refused. Cancel drops unsubmitted input without recording an Entry. Pasting multiple lines submits each completed physical line through the same prompt rules and leaves the final line for Enter.

- **Workbench:** resizable editor and inspector, a collapsible console drawer, and light/dark/system themes. Inspector tabs expose Syntax, Inspect, Canvas, Debug, Replay and Setup. Preferences persist locally; narrow screens stack the panes.
- **Run fresh** loads current tabs into a replacement session, then evaluates the visible Launch Entry. Invalid source or Libraries leave the old session intact. After loading succeeds, execution errors belong to the new session. An empty Launch Entry only loads.
- **Evaluate** runs the Launch Entry against the currently loaded session, without applying pending edits. **Apply** retains the live workflow below.
- **Do it, Print it, Inspect it** (Ctrl/Cmd-D, -P, -I) run the editor's selection, or the cursor's line, against the live session as an ordinary Entry, so the console and the Session Transcript show it like one typed at the prompt. The selection's shared indentation is dropped.
  - **Print it** shows beside the selection the last line its Entry printed: its value, or an error. The tooltip shows every line. Lines a Run prints later, once it goes on in the background, update it; editing the tab clears it.
  - **Inspect it** enters `:inspect` with the selected expression and shows its rows in the **Inspect** inspector.
  - A selected declaration in the Script tab is entered like one at the prompt, so it applies. A Library tab's declarations load only by saving the tab.
  - A statement selected from inside a Handler doesn't have the Handler's locals, so the Session Host reports them as unknown names. An unfinished Entry or a Session Command is refused without an Entry.
- **Syntax** follows the current editor text, not loaded code. Select a node to highlight source; selecting source reveals its node. Incomplete source remains inspectable.

- **The Script tab is the session source** ([ADR 0051](../../docs/adr/0051-the-playgrounds-script-tab-is-the-session-source.md)):
  - **Apply** (Ctrl/Cmd-S in the tab) enters each new or changed top-level declaration as an Entry. Handlers are compared by full Selector, so labelled and unlabelled heads with the same first word remain separate. Attached `--|` blocks travel with their declarations, and a documentation-only edit is a redefinition. A redefinition causes the Spec's Reload, which prints `! discarded` for each Run it discards.
  - A declaration entered at the prompt updates a clean tab. A tab with unapplied edits keeps them under a banner.
  - When the tab drops a declaration, Apply offers a **Restart**. A Restart makes a fresh session from the Grants, the Clock and limits, the Library tabs and the Script tab, and starts a new Transcript.
- **Library tabs:** **+ Library** adds one. Saving it (Ctrl/Cmd-S) records `:library add` the first time and `:library replace` after that. Renaming or closing a saved Library needs a Restart to take it out of the session.
- **The console** is the live Session Transcript.
  - Enter Entries and Session Commands at the `>` prompt. An unfinished Entry goes on at `|` until the whole Entry is complete, including labelled calls whose arguments continue inside brackets.
  - A `console` `read` is answered at the `<` prompt.
  - **Cancel** or Esc is `:cancel`, and `:help` lists the commands.
  - The **@ ~** box shows the Clock readings and Capability answers the Transcript records.
- **Grants:** before the session starts, the Grants panel issues `:grant` and `:mock`.
  - The built-in Capabilities are `clock` and the `Intl`-based `calendar` and `locale` shared with the REPL ([`builtins.ts`](../stack/src/builtins.ts)).
  - The Playground's Host Manifest is built from the session's Grants and given to the language server, so completion and hover know them.
- **Editing:** the language server runs in a worker with the formatter and the Lints.
  - It gives diagnostics, completion, hover, suspension marks, go to definition (F12), references (Shift-F12), rename (F2) and **Format**.
  - Highlighting separates fenced delimiters and literal text from hole code, including nested literals and multiline holes. Raw closing fences must match the opening quote run exactly. Argument Labels have their own style, including after continued argument expressions; argument variables keep their ordinary name style.
  - **Lints** chooses the `beginner` (the default) or `standard` Lint Profile.
- **Live debugging:** click the gutter to set a breakpoint in the Script tab or a saved Library tab.
  - A breakpoint pauses the whole session during any Run, and the tab shows the paused line. While paused, the prompt waits.
  - Continue, Step, Over and Out work as chapter 12 describes. Recovery Offer dispatch follows the active policy/cleanup cursor. The panel labels retained and dispatch frames, identifies the shared owner by its displayed frame number, and shows the actual owner locals. It also shows the session's runs, mailbox and Script Variables.
  - The pause isn't a Host Input, so the Transcript and the Trace are as they would be without it, and the paused time doesn't count on the Clock.
  - A breakpoint in a tab with unapplied edits is shown faded until Apply or a save loads it.
- **Replay debugging:** the Replay debugger replays a Trace on the TS Core.
  - With no Trace pasted, it replays this session, or a Shared Link's Transcript that replayed differently.
  - A pasted Trace from another Host needs its Setup as JSON (a `case.toml` converted to JSON). The Setup's source files come from tabs of the same name, and the panel asks for any it can't find.
  - Breakpoints are `unit:line`. **Back** steps backwards through dispatch statements too, and **Run to Host Input** seeks to a Host Input. The frame labels and owner locals match the live panel.
- **Sharing:** **Share** makes a Shared Link.
  - The link's fragment carries the tabs, launch Entry, setup commands and, optionally, the Session Transcript, deflated and base64url-encoded, so it never reaches a server.
  - Opening a link replays its Transcript, then goes on live. If the replay prints differently, the page shows the first differing line, never goes live, and leaves the replay debugger to step through what did replay.
  - **Transcript** downloads `session.transcript`, which `bun run northtalk replay` replays.
- **Autosave:** the tabs, launch Entry, setup, the Lint Profile and the **@ ~** choice are kept in `localStorage`.
- **Store slots:** the session's worker has no file system, so `:store save <slot>` and `:store load <slot>` name slots the page keeps in `localStorage`. The Session Store itself stays in the worker's memory, and a Restart or Run fresh starts it empty. A Shared Link replays `:store load` from the contents its Transcript recorded, not from a slot.
  - On load they open as unapplied edits in an empty session, and nothing executes until you explicitly use Run fresh, Apply or the prompt. The session itself is never saved.

## Layout

- [`src/session.ts`](src/session.ts): the Playground session over the Session Host. It handles Apply, Restart, Library saves, breakpoint mapping, pause views and opening a Transcript. It does no I/O and is tested under Bun.
- [`src/declarations.ts`](src/declarations.ts): splits a tab into top-level declarations with the Core's parser, and plans Apply.
- [`src/session.worker.ts`](src/session.worker.ts): the Playground Host. It holds the session, its deadline timers and the replay debugger.
- [`src/lsp.worker.ts`](src/lsp.worker.ts): the tooling stack's language server over `postMessage`.
- [`src/main.ts`](src/main.ts), [`src/editor.ts`](src/editor.ts), [`src/lsp-client.ts`](src/lsp-client.ts): the page, the CodeMirror 6 editor, and its LSP client.
- [`src/workbench.ts`](src/workbench.ts): pane controls, themes and syntax navigation. [`src/syntax.worker.ts`](src/syntax.worker.ts) projects the recovering tree; [`src/canvas.ts`](src/canvas.ts) renders validated drawing commands.
- [`src/link.ts`](src/link.ts): the Shared Link codec. [`src/protocol.ts`](src/protocol.ts): the worker messages.

## The corpus in a browser

```sh
bun run --cwd tooling/playground test:browser
```

This serves a page at http://127.0.0.1:3928/. Open it in a browser and it runs every blessed Trace Case and Session Transcript that `corpus:run` runs by default, on the TS Core in that browser.

- **The same checks:** it uses [`case-checks.ts`](../../impl/ts/tools/case-checks.ts), which the Bun runner uses too. For a Trace Case it replays twice, the second time restoring between Pumps. For a Transcript it compares the replayed lines, then replays the Trace as a Trace Case.
- **Results:** the page reports each case and a summary. `document.body.dataset.done` is `pass` or `fail` once it finishes.
- **What it leaves out:** Value Encoding and Disassembly Cases run only under Bun, and CI doesn't open the page.

## Static canvas

Use **Load drawing example** in the Canvas inspector, then **Run fresh**. Alternatively grant `canvas` in Setup before the session starts, or enter `:grant canvas canvas` at the prompt. Canvas is a Host capability, not language syntax or a Standard Capability. The same capability is available in the TypeScript CLI, including `northtalk replay`.

```northtalk
on draw
  tell canvas
    background "#f5f0e8"
    noStroke
    fill "#235f75"
    rectangle 70, 70, 180, 180
    fill "#e0a458"
    ellipse 250, 250, 160, 160
  end tell
end draw
```

Set Launch to `draw`. Operations are immediate and return Nothing. A `tell canvas` block calls each line as an `ask`, so no line takes `and wait`; a single call is `ask canvas to fill "#235f75"`.

| Operation | Arguments and behavior |
| --- | --- |
| `size` | Integer width, height, each 1–4096; clears pixels and resets styles |
| `clear` | No arguments; clears pixels, preserving styles |
| `background` | Color; replaces all pixels, preserving styles |
| `fill`, `stroke` | Color; enables and sets that style |
| `noFill`, `noStroke` | No arguments; disables that style |
| `strokeWidth` | Nonnegative number; zero suppresses strokes |
| `line` | x1, y1, x2, y2; uses stroke |
| `rectangle` | x, y, positive width, positive height; top-left origin |
| `ellipse` | x, y, positive width, positive height; center origin |
| `text` | Text, x, y; left-aligned alphabetic baseline; uses fill/stroke |
| `textSize` | Positive size in logical pixels; sans-serif |

Colors are `#RRGGBB` or `#RRGGBBAA`, case-insensitive. Coordinates and numeric arguments are bounded to ±1,000,000. Text is limited to 4096 UTF-16 code units. A session accepts at most 10,000 operations (including style changes); Run fresh resets this budget. Each call costs one Fuel. Invalid values raise `invalid canvas argument`; exhaustion raises `canvas limit`. Core Shape checks reject wrong types and argument counts.

The initial canvas is transparent, 400×400, with black fill, black one-pixel stroke and 12-pixel sans-serif text. Live evaluation keeps pixels and styles. Run fresh resets them after loading succeeds. Display scales to fit the pane without changing coordinates. Accepted drawing operations are not rolled back if later script work fails. Core `:save`/`:restore` does not rewind canvas pixels, styles or its session-wide operation budget; use Run fresh for that.

Shared transcripts reconstruct the drawing from successful typed Trace calls. Replay seeks rebuild the relevant prefix. The CLI validates/replays headlessly; pixel equality across browsers is not promised. Go replay requires the future Go Session Host to supply compatible declarations and validation (#137). Animation, input events, transforms, images and arbitrary browser access are not provided.
