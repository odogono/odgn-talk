import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { measurePayload } from '../tools/payload';

test("the TS Core's Payload compresses, and the Zig Core's is left out without a reactor", async () => {
  const payload = await measurePayload({
    wasmPath: join(import.meta.dir, 'no-such-talk.wasm'),
  });
  expect(Object.keys(payload).sort()).toEqual(['tsHost', 'tsPackage']);
  for (const { brotli, gzip, raw } of Object.values(payload)) {
    expect(brotli).toBeGreaterThan(0);
    expect(brotli).toBeLessThan(gzip);
    expect(gzip).toBeLessThan(raw);
  }
});
