import { test } from 'bun:test';
import { resolve } from 'node:path';
import { verifyLspStdio } from './lsp-integration';

test('Bun stdio LSP drives a fixture workspace with manifest discovery and live edits', async () => {
  await verifyLspStdio(
    process.execPath,
    resolve(import.meta.dir, '../src/main.ts'),
    resolve(import.meta.dir, 'fixtures/lsp'),
  );
}, 30_000);

test('Bun LSP preserves the request id when initialization configuration is invalid', async () => {
  const { verifyLspInvalidConfiguration } = await import('./lsp-integration');
  await verifyLspInvalidConfiguration(
    process.execPath,
    resolve(import.meta.dir, '../src/main.ts'),
  );
});
