import { expect, test } from 'bun:test';
import { httpKitCases, runHttpKitCase } from '../tools/http-kit';

// The HTTP router follows the http test kit through real sockets.
for (const c of await httpKitCases()) {
  test(`${c.file}: ${c.name}`, async () => {
    expect(await runHttpKitCase(c)).toBeUndefined();
  }, 10_000);
}
