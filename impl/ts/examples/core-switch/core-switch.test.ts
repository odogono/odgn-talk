// The same Host on both Cores (#1121). The wasm half needs talk.wasm:
// `cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi`.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run as onTs } from './ts';
import { run as onWasm } from './wasm';

const artifact = resolve(
  import.meta.dir,
  process.env.NORTHTALK_WASM ?? '../../../../.cache/zig-wasi/bin/talk.wasm',
);

test('the Host finishes its order on the TS Core', async () => {
  const outcome = await onTs();
  expect(outcome.result).toBe('completed "R-1"');
  expect(outcome.ledger).toBe('[["apple", "R-1", 15]]');
  expect(outcome.pending).toBe(1);
});

describe.skipIf(!existsSync(artifact))('on the Zig reactor', () => {
  test('the same Host gives the same results and Trace', async () => {
    const ts = await onTs();
    const wasm = await onWasm(pathToFileURL(artifact));
    expect(wasm.result).toBe(ts.result);
    expect(wasm.ledger).toBe(ts.ledger);
    expect(wasm.pending).toBe(ts.pending);
    expect(wasm.trace).toEqual(ts.trace);
    // Saves are each Core family's own (ADR 0008).
    expect(wasm.saveBytes).not.toBe(ts.saveBytes);
  });
});
