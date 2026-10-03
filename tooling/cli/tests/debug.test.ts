import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  linkSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const main = resolve(import.meta.dir, '../src/main.ts');
test('debug CLI runs a Script, steps, inspects and resumes through piped commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  try {
    const file = join(dir, 'demo.talk');
    writeFileSync(
      file,
      'script variable n = 0\non go\n put 1 into n\n put 2 into n\n return n\nend',
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        main,
        'debug',
        file,
        '--trace',
        join(dir, 'demo.trace'),
      ],
      {
        stdin: new TextEncoder().encode(
          ':break 3\n:run go\n:vars\n:step\n:runs\n:vars\n:continue\n:quit\n',
        ),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('paused breakpoint demo:3:');
    expect(result.stdout.toString()).toContain('[demo] n = 0');
    expect(result.stdout.toString()).toContain('paused step demo:4:');
    expect(result.stdout.toString()).toContain('[demo] n = 1');
    expect(result.stdout.toString()).toMatch(/segment 1 fuel \d+/);
    expect(result.stdout.toString()).toContain('completed 2');
    expect(result.stderr.toString()).toBe('');
    const recorded = readFileSync(join(dir, 'demo.trace'), 'utf8');
    expect(recorded).toContain('> load demo');
    expect(recorded).toContain('> pump');
    expect(recorded).not.toContain('> vars');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI validates usage and load diagnostics', () => {
  expect(Bun.spawnSync([process.execPath, main, 'debug']).exitCode).toBe(2);
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  try {
    const file = join(dir, 'bad.talk');
    writeFileSync(file, 'on go\n put + into x\nend');
    const result = Bun.spawnSync([process.execPath, main, 'debug', file], {
      stdin: new Uint8Array(),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('unexpected token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI pumps a suspension deadline and keeps the pending step over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  const file = join(dir, 'waiting.talk');
  writeFileSync(file, 'on go\n wait 10 ms\n return 2\nend');
  const child = Bun.spawn([process.execPath, main, 'debug', file], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    child.stdin.write(':break 2\n:run go\n:over\n');
    child.stdin.flush();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('paused step waiting:3:')) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Debugger ended before the step: ${output}`);
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    child.stdin.write(':runs\n:continue\n:quit\n');
    child.stdin.end();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    expect(await child.exited).toBe(0);
    expect(output).toContain('segment 2 fuel');
    expect(output).toContain('completed 2');
    expect(await new Response(child.stderr).text()).toBe('');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const alias of ['same', 'relative', 'symlink', 'hardlink']) {
  test(`debug CLI refuses a ${alias} source alias as its Trace output`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
    try {
      const file = join(dir, 'demo.talk');
      const source = 'on go\n return 2\nend';
      writeFileSync(file, source);
      let trace = file;
      if (alias === 'relative') {
        trace = dir + '/./demo.talk';
      }
      if (alias === 'symlink' || alias === 'hardlink') {
        trace = join(dir, 'trace');
        if (alias === 'symlink') {
          symlinkSync(file, trace);
        } else {
          linkSync(file, trace);
        }
      }
      const result = Bun.spawnSync(
        [process.execPath, main, 'debug', file, '--trace', trace],
        { stdin: new Uint8Array() },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        'Trace file must differ from Script source',
      );
      expect(readFileSync(file, 'utf8')).toBe(source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
