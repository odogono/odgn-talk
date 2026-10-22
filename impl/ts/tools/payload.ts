// Each Core's Payload: what a browser Host ships to embed it, bundled and
// minified, raw and compressed (#1121). Used by tools/wasm-browser.ts and the
// Benchmark Suite's report.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const here = resolve(import.meta.dir);

/** Where `zig build -Dtarget=wasm32-wasi --prefix .cache/zig-wasi` puts the reactor. */
export const defaultWasmPath = resolve(
  here,
  '../../../.cache/zig-wasi/bin/talk.wasm',
);

/** One payload's size in bytes. */
export type Sizes = { brotli: number; gzip: number; raw: number };

/**
 * The TS Core's core-switch Example Host and its whole package; with a
 * reactor, the same for the Zig Core behind `@northtalk/ts/wasm`.
 */
export type Payload = {
  talkWasm?: Sizes;
  tsHost: Sizes;
  tsPackage: Sizes;
  wasmHost?: Sizes;
  wasmPackage?: Sizes;
};

export const bundle = async (
  entry: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    minify: true,
  });
  if (!built.success) {
    throw new AggregateError(built.logs, `Bundling ${entry} failed`);
  }
  return new Uint8Array(await built.outputs[0]!.arrayBuffer());
};

export const sizes = (b: Uint8Array): Sizes => ({
  raw: b.length,
  gzip: gzipSync(b, { level: 9 }).length,
  brotli: brotliCompressSync(b, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});

/** Leaves out the Zig Core when there is no reactor at `wasmPath`. */
export const measurePayload = async ({
  wasmPath = defaultWasmPath,
}: { wasmPath?: string } = {}): Promise<Payload> => {
  const of = async (entry: string) => sizes(await bundle(resolve(here, entry)));
  const ts = {
    tsHost: await of('../examples/core-switch/ts.ts'),
    tsPackage: await of('../src/index.ts'),
  };
  if (!existsSync(wasmPath)) {
    return ts;
  }
  return {
    ...ts,
    wasmHost: await of('../examples/core-switch/wasm.ts'),
    wasmPackage: await of('../src/wasm/index.ts'),
    talkWasm: sizes(readFileSync(wasmPath)),
  };
};
