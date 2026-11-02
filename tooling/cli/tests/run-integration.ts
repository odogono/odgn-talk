// The Script Runner, `northtalk app.talk` (ADR 0126), checked the same way
// under Bun and Node: each case spawns the real command.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintOf, newPeerKey } from '../src/peers';

const scripts = {
  'hello.talk': 'on start args\n  say "hello " & args\nend start\n',
  'boom.talk':
    'on start args\n  say "before"\n  throw {code: "boom", n: 1}\nend start\n',
  'later.talk': [
    'on start args',
    '  ask clock to now',
    '  tell timer to schedule "t", it + 200 ms, "tick", [5]',
    '  say "set"',
    'end start',
    'on tick n',
    '  say "tick " & n',
    'end tick',
    '',
  ].join('\n'),
  'broken.talk': 'on start args\n  say 1 +\nend start\n',
  'echo.talk': [
    'on start args',
    '  ask console to read and wait',
    '  say "got " & it',
    'end start',
    '',
  ].join('\n'),
};

/** Files that run, exit 0 or 1, take their arguments and wait for timers. */
export const verifyScriptRunner = (runtime: string, entry: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-run-'));
  try {
    for (const [name, source] of Object.entries(scripts)) {
      writeFileSync(join(directory, name), source);
    }
    const run = (args: string[], input = '') => {
      const result = spawnSync(runtime, [entry, ...args], {
        encoding: 'utf8',
        input,
        timeout: 20_000,
      });
      return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };
    const at = (name: string) => join(directory, name);
    assert.deepEqual(run([at('hello.talk'), 'a', '--b']), {
      code: 0,
      stdout: 'hello ["a", "--b"]\n',
      stderr: '',
    });
    const boom = run([at('boom.talk')]);
    assert.equal(boom.code, 1);
    assert.equal(boom.stdout, 'before\n');
    assert.equal(
      boom.stderr,
      `${at('boom.talk')}:3:3: uncaught error in start: boom {n: 1}\n`,
    );
    const started = Date.now();
    assert.deepEqual(run([at('later.talk')]), {
      code: 0,
      stdout: 'set\ntick 5\n',
      stderr: '',
    });
    assert.ok(Date.now() - started >= 200, 'exited before the timer fired');
    const broken = run([at('broken.talk')]);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /broken\.talk:3:1: unexpected token/u);
    assert.deepEqual(run([at('echo.talk')], 'line one\n'), {
      code: 0,
      stdout: 'got line one\n',
      stderr: '',
    });
    // At the end of input, the Run waiting to read is cancelled.
    assert.deepEqual(run([at('echo.talk')]), {
      code: 0,
      stdout: '',
      stderr: '',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** The HTTP example serves until SIGINT, then exits 130. */
export const verifyHttpExample = async (
  runtime: string,
  entry: string,
  example: string,
) => {
  const child = spawn(runtime, [entry, '--port', '0', example], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>(resolve =>
    child.on('exit', code => resolve(code)),
  );
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout += chunk;
        const found = /listening on (\d+)\n/u.exec(stdout);
        if (found) {
          resolve(Number(found[1]));
        }
      });
      void exited.then(code =>
        reject(new Error(`exited ${code} before listening: ${stderr}`)),
      );
    });
    assert.notEqual(port, 3000);
    const get = async (path: string, init?: RequestInit) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      return [response.status, await response.text()];
    };
    assert.deepEqual(await get('/'), [200, 'hello']);
    assert.deepEqual(await get('/users/7'), [200, '{"id":"7"}']);
    assert.deepEqual(await get('/echo', { method: 'POST', body: 'hi there' }), [
      201,
      'hi there',
    ]);
    assert.equal((await get('/missing'))[0], 404);
    assert.equal((await get('/never'))[0], 500);
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    assert.equal(stdout, `listening on ${port}\n`);
  } finally {
    child.kill('SIGKILL');
  }
};

const billing = [
  'on start args',
  '  ask peer to expose "billing" and wait',
  '  say "ready"',
  'end start',
  'on charge amount',
  '  say "charge " & amount & " from " & sender()',
  '  if amount > 100 then',
  '    throw {code: "too much"}',
  '  end if',
  '  return amount + 1',
  'end charge',
  'on note line',
  '  say "note " & line & " from " & sender()',
  'end note',
  // The Caller Identity's name, or nobody when the link vouched for none.
  'function sender',
  '  ask peer to caller',
  '  if it = nothing then',
  '    return "nobody"',
  '  end if',
  '  return the name of it',
  'end sender',
  '',
].join('\n');

const shop = [
  'on start args',
  '  ask peer to reach "billing" into billing and wait',
  '  send charge with 12 to billing into total and wait',
  '  say "total " & total',
  '  try',
  '    send charge with 500 to billing and wait',
  '  catch e',
  '    say the code of e & " " & the reason of e',
  '  end try',
  '  send note with "hi" to billing',
  '  send charge with 1 to billing and wait',
  'end start',
  '',
].join('\n');

/** A listening Runner, until `stop` signals it, and the lines it says. */
const listener = async (command: readonly string[], args: string[]) => {
  const child = spawn(command[0]!, [...command.slice(1), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
  });
  const exited = new Promise<number | null>(resolve =>
    child.on('exit', code => resolve(code)),
  );
  const address = await new Promise<string>((resolve, reject) => {
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      const found = /listening on (\S+)\n/u.exec(stderr);
      if (found) {
        resolve(found[1]!);
      }
    });
    void exited.then(code =>
      reject(new Error(`exited ${code} before listening: ${stderr}`)),
    );
  });
  return {
    address,
    // Its output comes through a pipe: wait for as much as is wanted.
    said: async (want: string) => {
      for (let i = 0; i < 100 && stdout.length < want.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return stdout;
    },
    stop: async () => {
      child.kill('SIGINT');
      return exited;
    },
    kill: () => child.kill('SIGKILL'),
  };
};

const said = (who: string) =>
  `ready\ncharge 12 from ${who}\ncharge 500 from ${who}\nnote hi from ${who}\ncharge 1 from ${who}\n`;

/**
 * Two Runners carry Remote Sends (chapter 12, Runner peers): a call and its
 * reply, a Script error as `send failed`, and a post. Over mutual TLS the
 * listener's `--peer` names the caller and a wrong pinned key is refused;
 * over plain TCP on loopback nobody is vouched for, and any other host is
 * refused.
 */
export const verifyRunnerPeers = async (
  /** The listening Runner's command, such as `[bun, main.ts]` or `[northtalk]`. */
  listenWith: readonly string[],
  /** The dialling Runner's command. */
  dialWith: readonly string[] = listenWith,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-peers-'));
  const at = (name: string) => join(directory, name);
  writeFileSync(at('billing.talk'), billing);
  writeFileSync(at('shop.talk'), shop);
  const shopKey = newPeerKey();
  writeFileSync(at('shop.pem'), shopKey);
  const shopPrint = fingerprintOf(
    /-{5}BEGIN CERTIFICATE-{5}[\S\s]+?-{5}END CERTIFICATE-{5}/u.exec(
      shopKey,
    )![0],
  );
  const run = (args: string[]) =>
    spawnSync(dialWith[0]!, [...dialWith.slice(1), ...args, at('shop.talk')], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  const tls = await listener(listenWith, [
    '--listen',
    '127.0.0.1:0',
    '--peer',
    `shop=tls://127.0.0.1:1#${shopPrint}`,
    at('billing.talk'),
  ]);
  const tcp = await listener(listenWith, [
    '--listen',
    'tcp://127.0.0.1:0',
    at('billing.talk'),
  ]);
  try {
    const shopRun = run([
      '--peer-key',
      at('shop.pem'),
      '--peer',
      `billing=${tls.address}`,
    ]);
    assert.equal(shopRun.status, 0, shopRun.stderr);
    assert.equal(shopRun.stdout, 'total 13\nsend failed errored\n');
    assert.equal(shopRun.stderr, `peer: key ${shopPrint}\n`);
    assert.equal(await tls.said(said('shop')), said('shop'));
    // A listener whose key isn't the pinned one is never reached.
    const wrong = run([
      '--peer',
      `billing=${tls.address.replace(/#.*/u, `#${'0'.repeat(64)}`)}`,
    ]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /uncaught error in start: bad address/u);

    assert.match(tcp.address, /^tcp:\/\/127\.0\.0\.1:\d+$/u);
    const plain = run(['--peer', `billing=${tcp.address}`]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, 'total 13\nsend failed errored\n');
    assert.equal(await tcp.said(said('nobody')), said('nobody'));
    // Plain TCP carries no key, so it stays on loopback.
    const away = run(['--peer', 'billing=tcp://192.0.2.1:7400']);
    assert.notEqual(away.status, 0);
    assert.match(away.stderr, /tcp:\/\/ is only for loopback/u);

    assert.equal(await tls.stop(), 130);
    assert.equal(await tcp.stop(), 130);
  } finally {
    tls.kill();
    tcp.kill();
    rmSync(directory, { recursive: true, force: true });
  }
};
