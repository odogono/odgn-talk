# NorthTalk creative tool

The browser creative tool planned in [#154](https://github.com/odogono/odgn-talk/issues/154): a HyperCard-inspired tool for making illustrated interactive stories, small games and personal tools, with Scripts in NorthTalk. "Creative tool" is a working name until the application is named.

For now the page opens one Script window on the [shared editor](../editor/), with the language server's diagnostics, completion and hover, and shows the TS Core it loaded. The editor comes with stage 1 of #154. The authored Project model and its zip file format — pure TypeScript with no UI — live in [`src/model.ts`](src/model.ts), [`src/project-file.ts`](src/project-file.ts) and [`src/zip.ts`](src/zip.ts) (#748). Reading a Project file refuses a newer `format`, encrypted or ZIP64 archives, and compression other than stored or deflate; an asset whose file is missing opens as reported in `missingAssets` rather than as an error. The design so far:

- The editor layout and Script windows: the [UI prototype's verdict](https://github.com/odogono/odgn-talk/issues/154#issuecomment-6141500821).
- How Scripts reach Projects, Pages and Elements: [#735](https://github.com/odogono/odgn-talk/issues/735).
- The Project file and browser storage: [#739](https://github.com/odogono/odgn-talk/issues/739).
- Authored Projects are separate from Play State: [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md).

## Running it

From the repository root, with Bun 1.4.2:

```sh
bun install
bun run creative                       # serves at http://127.0.0.1:3928/ and rebuilds on change
bun run --cwd tooling/creative build   # a static dist/ any web server can host
bun test tooling/creative/tests
```
