# @northtalk/ts

NorthTalk is a readable, conversational scripting language for embedding in applications. This package is its TypeScript implementation: the TS Core, which parses, checks and runs Scripts under a Host's limits, with the Session Host, the Standard Capabilities and the helpers a Host builds on.

The [Spec](https://github.com/odogono/odgn-talk/tree/main/spec) defines the language, and the [TS guide](https://github.com/odogono/odgn-talk/tree/main/impl/ts#readme) describes this implementation.

For a walkthrough from the first Handler to asynchronous application services,
see [Embed the TS Core in a TypeScript app](https://github.com/odogono/odgn-talk/blob/main/docs/embedding-typescript.md).

```sh
npm install @northtalk/ts
```

```ts
import { createCore, num } from '@northtalk/ts';
import { newDrivenGroup } from '@northtalk/ts/driver';

const { group, drive } = newDrivenGroup(createCore(), { name: 'example' });
const script = group.load({
  name: 'main',
  source: 'on total a, b\n  return a + b\nend total',
});
const reply = script.request({ name: 'total', args: [num(2), num(3)] });
console.log((await reply.result).toString()); // 5
await drive.close();
```

A Host can create a Group ready to pump from the event loop with `newDrivenGroup`, or use `newGroup` and drive it with its own `pump` loop. Before releasing application resources, `await drive.close()` stops Scripts and awaits Promise-backed Operation cleanup. A suspending Operation's `run` must honour `call.signal` and settle once it aborts; a Promise that never settles keeps close pending unless the driver's `closeTimeoutMs` bounds the wait. The driver also supports async disposal with `await using`.

## Subpaths

| Import                        | Holds                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@northtalk/ts`               | Values, Groups, Scripts, Libraries, Capabilities, Object Kinds, save and restore, and the parser and checker |
| `@northtalk/ts/session`       | The Session Host, for a REPL or playground, and Session Transcripts                                          |
| `@northtalk/ts/driver`        | `newDrivenGroup` and `autoDrive`, which pump a Group from the event loop                                     |
| `@northtalk/ts/store`         | The Store Standard Capability                                                                                |
| `@northtalk/ts/notify`        | The Store notification router                                                                                |
| `@northtalk/ts/sqlite`        | A `sqlite` implementation on `node:sqlite`, for server Hosts                                                 |
| `@northtalk/ts/http`          | The HTTP router on `node:http`, for server Hosts                                                             |
| `@northtalk/ts/message-layer` | Binary Value and frame codecs for the Message Layer                                                          |
| `@northtalk/ts/wasm`          | The same embedding API over the Zig Core's WebAssembly reactor                                               |
| `@northtalk/ts/setup`         | Group setup shared by Sessions and Trace replay. Tooling surface                                             |
| `@northtalk/ts/debug`         | Debugger hooks. Tooling surface                                                                              |

The tooling surfaces serve editors, debuggers and REPLs. They aren't part of the Spec's embedding API, and may change in any minor release while the package is `0.x`.

`@northtalk/ts/wasm` doesn't include `talk.wasm`. Build it with `zig build -Dtarget=wasm32-wasi` in the repository's `impl/zig`, or take a `reactor-v*` release, and pass it as `createCore({ wasm })` or serve it beside `wasm.js`.

## Runtimes

The package is ESM only, with no dependencies.

- **Browsers:** every subpath except `./sqlite` and `./http`, including `./notify`. The modules load unbundled through an import map, as well as through a bundler.
- **Node 24.10 or later, and Bun.** The Node minimum applies to every entry point, including applications using only the Core.
- **TypeScript 5.9 or later**, for the declarations.

`coreVersions` reports the language, Cost Model, Unicode and save-format versions this release implements. The package version follows semver for its embedding API.

## Licence

[MIT](https://github.com/odogono/odgn-talk/blob/main/LICENSE). The Unicode tables carry the [Unicode licence](https://github.com/odogono/odgn-talk/blob/main/impl/ts/src/generated/UNICODE-LICENSE.txt).
