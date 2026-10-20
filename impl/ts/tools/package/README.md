# @northtalk/ts

NorthTalk is a readable, conversational scripting language for embedding in applications. This package is its TypeScript implementation: the TS Core, which parses, checks and runs Scripts under a Host's limits, with the Session Host, the Standard Capabilities and the helpers a Host builds on.

The [Spec](https://github.com/odogono/odgn-talk/tree/main/spec) defines the language, and the [TS guide](https://github.com/odogono/odgn-talk/tree/main/impl/ts#readme) describes this implementation.

For a walkthrough from the first Handler to asynchronous application services,
see [Embed the TS Core in a TypeScript app](https://github.com/odogono/odgn-talk/blob/main/docs/embedding-typescript.md).

```sh
npm install @northtalk/ts
```

```ts
import { newGroup, num, parseInstant } from '@northtalk/ts';

const group = newGroup({ name: 'example' });
const script = group.load({
  name: 'main',
  source: 'on total a, b\n  return a + b\nend total',
});
const reply = script.request({ name: 'total', args: [num(2), num(3)] });
group.pump(parseInstant('2026-10-17T09:00:00Z'));
console.log((await reply.result).toString()); // 5
```

A Host drives each Group with `pump`. `@northtalk/ts/driver` pumps one from the event loop.

## Subpaths

| Import                  | Holds                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@northtalk/ts`         | Values, Groups, Scripts, Libraries, Capabilities, Object Kinds, save and restore, and the parser and checker |
| `@northtalk/ts/session` | The Session Host, for a REPL or playground, and Session Transcripts                                          |
| `@northtalk/ts/driver`  | `autoDrive`, which pumps a Group from the event loop                                                         |
| `@northtalk/ts/store`   | The Store Standard Capability                                                                                |
| `@northtalk/ts/notify`  | The Store notification router                                                                                |
| `@northtalk/ts/sqlite`  | A `sqlite` implementation on `node:sqlite`, for server Hosts                                                 |
| `@northtalk/ts/wasm`    | The same embedding API over the Zig Core's WebAssembly reactor                                               |
| `@northtalk/ts/setup`   | Group setup shared by Sessions and Trace replay. Tooling surface                                             |
| `@northtalk/ts/debug`   | Debugger hooks. Tooling surface                                                                              |

The tooling surfaces serve editors, debuggers and REPLs. They aren't part of the Spec's embedding API, and may change in any minor release while the package is `0.x`.

`@northtalk/ts/wasm` doesn't include `talk.wasm`. Build it with `zig build -Dtarget=wasm32-wasi` in the repository's `impl/zig`, or take a `reactor-v*` release, and pass it as `createCore({ wasm })` or serve it beside `wasm.js`.

## Runtimes

The package is ESM only, with no dependencies.

- **Browsers:** every subpath except `./sqlite`. The modules load unbundled through an import map, as well as through a bundler.
- **Node 22 or later, and Bun.** `./sqlite` needs Node 24.10 or later, or Bun.
- **TypeScript 5.9 or later**, for the declarations.

`coreVersions` reports the language, Cost Model, Unicode and save-format versions this release implements. The package version follows semver for its embedding API.

## Licence

[MIT](https://github.com/odogono/odgn-talk/blob/main/LICENSE). The Unicode tables carry the [Unicode licence](https://github.com/odogono/odgn-talk/blob/main/impl/ts/src/generated/UNICODE-LICENSE.txt).
