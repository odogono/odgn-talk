import { test } from 'bun:test';
import { resolve } from 'node:path';
import { verifyHttpExample, verifyScriptRunner } from './run-integration';

const main = resolve(import.meta.dir, '../src/main.ts');

test('Bun runs a Script file: start args, exit codes, timers and reads', () => {
  verifyScriptRunner(process.execPath, main);
}, 60_000);

test('Bun serves the HTTP example until SIGINT', async () => {
  await verifyHttpExample(
    process.execPath,
    main,
    resolve(import.meta.dir, '../../../examples/http/hello.talk'),
  );
}, 30_000);
