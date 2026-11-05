#!/usr/bin/env bun
// The chat in a real browser (ADR 0165): two Chromium tabs join a Runner's
// `--listen ws://` and hear each other through the Peers they handed it.
// bun examples/peer-chat/browser-check.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveChat } from './serve';

const runner = spawn(
  process.execPath,
  [
    resolve(import.meta.dir, '../../tooling/cli/src/main.ts'),
    '--listen',
    'ws://127.0.0.1:0',
    resolve(import.meta.dir, 'chat.talk'),
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const ws = await new Promise<string>((done, fail) => {
  let said = '';
  runner.stderr!.setEncoding('utf8').on('data', chunk => {
    said += chunk;
    const found = /listening on (\S+)\n/u.exec(said);
    if (found) {
      done(found[1]!);
    }
  });
  runner.once('exit', code =>
    fail(new Error(`Runner exited ${code}: ${said}`)),
  );
});
const server = await serveChat(0);
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  const open = async (nick: string) => {
    const tab = await browser.newPage();
    await tab.goto(`${server.url}?nick=${nick}&ws=${encodeURIComponent(ws)}`);
    await tab.getByText(`*: ${nick} joined`).waitFor();
    return tab;
  };
  const alice = await open('alice');
  const bob = await open('bob');
  await bob.getByRole('textbox').fill('hi alice');
  await bob.getByRole('button').click();
  await alice.getByText('bob: hi alice').waitFor();
  assert.deepEqual(await alice.locator('#log li').allTextContents(), [
    '*: alice joined',
    '*: bob joined',
    'bob: hi alice',
  ]);
  process.stdout.write(
    'Browser chat: two tabs talked through --listen ws://\n',
  );
} finally {
  await browser.close();
  await server.stop();
  runner.kill('SIGINT');
}
