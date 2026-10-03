import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

test('the browser bundle formats without Bun, Node or Host I/O', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-browser-format-'));
  try {
    const entry = join(dir, 'browser.ts');
    const formatter = resolve(import.meta.dir, '../src/format.ts');
    writeFileSync(
      entry,
      String.raw`import { formatSource } from ${JSON.stringify(formatter)};
globalThis.result = formatSource('on go\nsay 1+2\nend go\n');`,
    );
    const build = await Bun.build({ entrypoints: [entry], target: 'browser' });
    expect(build.success).toBe(true);
    const context: {
      result?: { error: null; source: string };
      TextDecoder: typeof TextDecoder;
      TextEncoder: typeof TextEncoder;
    } = { TextEncoder, TextDecoder };
    runInNewContext(await build.outputs[0]!.text(), context);
    expect(context.result).toEqual({
      source: 'on go\n  say 1 + 2\nend go\n',
      error: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the browser LSP bundle checks, hovers and navigates without Bun, Node or Host I/O', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-browser-lsp-'));
  try {
    const entry = join(dir, 'browser.ts');
    const fixtures = resolve(import.meta.dir, './verify-lsp.ts');
    writeFileSync(
      entry,
      `import { verifyLspFeatures } from ${JSON.stringify(fixtures)};\nglobalThis.result = verifyLspFeatures();`,
    );
    const build = await Bun.build({ entrypoints: [entry], target: 'browser' });
    expect(build.success).toBe(true);
    const context: {
      result?: number;
      TextDecoder: typeof TextDecoder;
      TextEncoder: typeof TextEncoder;
    } = { TextEncoder, TextDecoder };
    runInNewContext(await build.outputs[0]!.text(), context);
    expect(context.result).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the browser debug bundle replays, reverses and preserves Trace without Bun or Node globals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-browser-debug-'));
  try {
    const entry = join(dir, 'browser.ts');
    const fixtures = resolve(import.meta.dir, './verify-debug.ts');
    writeFileSync(
      entry,
      `import { verifyDebugFeatures } from ${JSON.stringify(fixtures)};\nglobalThis.result = verifyDebugFeatures();`,
    );
    const build = await Bun.build({ entrypoints: [entry], target: 'browser' });
    expect(build.success).toBe(true);
    const context = {
      TextEncoder,
      TextDecoder,
      performance,
      structuredClone,
      result: undefined as number | undefined,
    };
    runInNewContext(await build.outputs[0]!.text(), context);
    expect(context.result).toBe(9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
