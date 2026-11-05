import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  verifyHttpExample,
  verifyRunnerPeers,
  verifyRunnerWebSockets,
  verifyScriptRunner,
} from './run-integration';

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

test('Bun Runners carry Remote Sends over TLS and loopback TCP', async () => {
  await verifyRunnerPeers([process.execPath, main]);
}, 60_000);

test('Bun Runner accepts browser Hosts over --listen ws://', async () => {
  await verifyRunnerWebSockets([process.execPath, main]);
}, 30_000);

// The Go Runner, built here when Go is on the path, speaks the same wire
// (ADR 0163): each listens for the other, over TLS and loopback TCP.
const goRunner = (() => {
  const out = join(mkdtempSync(join(tmpdir(), 'northtalk-go-')), 'northtalk');
  const built = spawnSync(
    'go',
    [
      '-C',
      resolve(import.meta.dir, '../../../impl/go'),
      'build',
      '-o',
      out,
      './internal/cmd/northtalk',
    ],
    { encoding: 'utf8' },
  );
  return built.status === 0 ? out : undefined;
})();

test.skipIf(!goRunner)(
  'a TS and a Go Runner carry Remote Sends both ways',
  async () => {
    await verifyRunnerPeers([goRunner!], [process.execPath, main]);
    await verifyRunnerPeers([process.execPath, main], [goRunner!]);
  },
  120_000,
);

// The native Zig Runner, when it has been built, speaks the same wire
// over its own TLS (ADR 0164): each listens for the TS and Go Runners.
const zigRunner = resolve(
  import.meta.dir,
  '../../../impl/zig/zig-out/bin/northtalk',
);

test.skipIf(!existsSync(zigRunner))(
  'a TS and a native Runner carry Remote Sends both ways',
  async () => {
    await verifyRunnerPeers([zigRunner], [process.execPath, main]);
    await verifyRunnerPeers([process.execPath, main], [zigRunner]);
  },
  120_000,
);

test.skipIf(!existsSync(zigRunner) || !goRunner)(
  'a Go and a native Runner carry Remote Sends both ways',
  async () => {
    await verifyRunnerPeers([zigRunner], [goRunner!]);
    await verifyRunnerPeers([goRunner!], [zigRunner]);
  },
  120_000,
);
