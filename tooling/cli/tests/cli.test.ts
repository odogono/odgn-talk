import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const main = resolve(import.meta.dir, '../src/main.ts');
const corpus = resolve(import.meta.dir, '../../../corpus/sessions');
const run = (args: string[], stdin = '') => {
  const result = Bun.spawnSync([process.execPath, main, ...args], {
    stdin: new TextEncoder().encode(stdin),
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

test('the REPL reads Entries a line at a time and records a Transcript that replays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const transcript = join(dir, 'session.transcript');
  const { code, stdout } = run(
    ['--transcript', transcript],
    [
      'put 2.50 GBP into price',
      'price * 3',
      'on greet name',
      '  say "hello " & name',
      'end greet',
      'greet "Ann"',
      'on echo',
      '  ask console to read and wait',
      '  say "got " & it',
      'end echo',
      'echo and wait',
      'typed',
      '1 +',
      '',
      ':help',
      ':quit',
      '',
    ].join('\n'),
  );
  expect(code).toBe(0);
  expect(stdout).toStartWith(
    '7.50 GBP\nhello Ann\ngot typed\n! unexpected token at 1:4\n',
  );
  const recorded = readFileSync(transcript, 'utf8');
  expect(recorded).toContain('> on greet name\n|   say "hello " & name\n');
  expect(recorded).toContain('< typed\n');
  // `:help` and `:quit` aren't recorded.
  expect(recorded).not.toContain(':help');
  expect(run(['replay', transcript]).code).toBe(0);
});

test('replay reports the first line that differs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const transcript = join(dir, 'changed.transcript');
  writeFileSync(
    transcript,
    readFileSync(
      join(corpus, 'virtual-clock/session.transcript'),
      'utf8',
    ).replace('[session/r2] tick 1', '[session/r2] tick 9'),
  );
  const { code, stderr } = run(['replay', transcript]);
  expect(code).toBe(1);
  expect(stderr).toContain('expected: [session/r2] tick 9');
  expect(stderr).toContain('actual:   [session/r2] tick 1');
});

test('replay writes the Trace it took', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const trace = join(dir, 'case.trace');
  const { code } = run([
    'replay',
    join(corpus, 'mocks/session.transcript'),
    '--trace',
    trace,
  ]);
  expect(code).toBe(0);
  expect(readFileSync(trace, 'utf8')).toBe(
    readFileSync(join(corpus, 'mocks/case.trace'), 'utf8'),
  );
});

test('a bad command line prints the usage', () => {
  const { code, stderr } = run(['replay']);
  expect(code).toBe(2);
  expect(stderr).toContain('Usage:');
});
