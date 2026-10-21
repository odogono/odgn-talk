# Browser Hosts may run the Zig reactor through the TS embedding API

A browser Host may run the Zig `wasm32-wasi` reactor in place of the TS Core, through `@odgn/northtalk/wasm`, which offers [`talk.ts`](../../spec/embedding/talk.ts)'s embedding API over the [Message Layer](../../spec/09-embedding.md#the-message-layer) ([#1121](https://github.com/odogono/odgn-talk/issues/1121)). The TS Core stays the browser's default Core, with all its parity duties. This narrows the browser clauses of [ADR 0071](0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md), [ADR 0078](0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md) and [ADR 0089](0089-the-zig-build-serves-the-message-layer-reactor.md). Those clauses keep the TS Core in the browser, and they still rule out replacing it there.

We chose this because a browser Host that wants to compare the two Cores has to run both under the same tests, and only a browser Host can do that in a browser. A Host also chooses its save format when it chooses a Core ([ADR 0008](0008-same-core-save-restore.md)), so it needs to try both before committing. The facade is a Host adapter, like the Elixir and Go adapters. It adds no language behavior and no third parity landing: the reactor's behavior is the Zig Core's, which the Corpus already holds to the Spec.

The facade reuses the TS Core's Values, Shapes, errors and Capability and Object Kind constructors, so Host code switches Cores by its import. Its calls are synchronous, as the TS Core's are. Only `createCore` is asynchronous, because it compiles the module. Each Group has its own guest instance, as the Go adapter's Groups first did, so a callback or a trap in one Group never reaches another.

## Considered Options

- **Keeping the browser on the TS Core alone:** ADR 0089's clause. A Host couldn't compare Cores, or their saves, in a browser.
- **Replacing the TS Core in the browser:** ADR 0009's and ADR 0071's reasons stand. [The browser figures](../research/zig-browser-figures.md) put the reactor's payload at 770 KB Brotli against the TS Core's 147 KB, and its memory at about 2.3 MB per Group against 15 KB. Its Pumps run faster, but a Capability call costs about the same as on the TS Core, since every call crosses between JS and the guest.
- **One guest for all of a Core's Groups,** with `group-exchanges-v1`: this saves about 2 MiB per Group, but a trap or memory exhaustion would lose every Group in the guest. Each Group keeps its own guest until a Host needs many Groups.
- **An asynchronous API:** it would let the guest run in a Worker, but a Host would have to change its code to switch Cores.
- **A package of its own:** the `@odgn/northtalk/wasm` subpath shares the TS Core's types and constructors, and the switch stays one import.

## Consequences

- **The differences are listed in the TS guide's [`@odgn/northtalk/wasm` section](../../impl/ts/README.md#the-zig-reactor-in-a-browser).** They include `createCore` being asynchronous, the reactor's 64 MiB frame limit, and saves in the Zig format.
- **There's no memory cap.** The Message Layer has no field for one, and JavaScript can't cap a guest's own memory, so the runtime-enforced cap that wasmtime gives the Elixir Host isn't available in a browser.
- **CI replays the Corpus's Trace Cases through the facade.** A divergence it finds is the reactor's, and goes to a Zig issue, as [#1128](https://github.com/odogono/odgn-talk/issues/1128) did.
- **`talk.wasm` isn't in the package.** A Host builds it with `zig build -Dtarget=wasm32-wasi`, or takes a `reactor-v*` release, and serves it beside its bundle.
- Supersedes in part [ADR 0071](0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md), [ADR 0078](0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md) and [ADR 0089](0089-the-zig-build-serves-the-message-layer-reactor.md): their browser clauses only.
- Amended by [ADR 0121](0121-ts-host-code-types-against-one-embedding-interface.md): both entry points export one `Core`, `Group` and `Script` interface that the TS Core and this Host Adapter each implement, so `tsc` checks that Host code switches Cores by its import.
