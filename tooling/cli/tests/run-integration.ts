// The Script Runner, `northtalk app.talk` (ADR 0126), checked the same way
// under Bun and Node: each case spawns the real command.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
