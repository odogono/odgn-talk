import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { coreVersions } from '@odgn/northtalk';

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
      '1 + return',
      '',
      ':help',
      ':quit',
      '',
    ].join('\n'),
  );
  expect(code).toBe(0);
  expect(stdout).toStartWith(
    '7.50 GBP\nhello Ann\ngot typed\n! unexpected token at 1:5\n',
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

test('fmt writes several files in place and check never writes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-format-'));
  const first = join(dir, 'first.talk');
  const second = join(dir, 'second.talk');
  const source = 'on go\nsay  1+2\nend go\n';
  writeFileSync(first, source);
  writeFileSync(second, source);
  expect(run(['fmt', '--check', first, second]).code).toBe(1);
  expect(readFileSync(first, 'utf8')).toBe(source);
  expect(run(['fmt', first, second]).code).toBe(0);
  expect(readFileSync(first, 'utf8')).toBe('on go\n  say 1 + 2\nend go\n');
  expect(readFileSync(second, 'utf8')).toBe(readFileSync(first, 'utf8'));
  expect(run(['fmt', first, second, '--check']).code).toBe(0);
});

test('fmt reads stdin and check reports differences without printing source', () => {
  const source = 'on go\nsay 1\nend go';
  expect(run(['fmt', '-'], source)).toEqual({
    code: 0,
    stdout: 'on go\n  say 1\nend go',
    stderr: '',
  });
  const checked = run(['fmt', '--check', '-'], source);
  expect(checked.code).toBe(1);
  expect(checked.stdout).toBe('');
  expect(checked.stderr).toContain('not formatted');
});

test('fmt preserves syntax errors and processes the other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-format-'));
  const broken = join(dir, 'broken.talk');
  const valid = join(dir, 'valid.talk');
  const source = '  on go\nsay 1+\nend go';
  writeFileSync(broken, source);
  writeFileSync(valid, 'on go\nsay 1\nend go');
  const result = run(['fmt', broken, valid]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('unexpected token');
  expect(readFileSync(broken, 'utf8')).toBe(source);
  expect(readFileSync(valid, 'utf8')).toBe('on go\n  say 1\nend go');
  const stdin = run(['fmt', '-'], source);
  expect(stdin.code).toBe(1);
  expect(stdin.stdout).toBe(source);
});

test('fmt validates its command line and reports unreadable files', () => {
  expect(run(['fmt']).code).toBe(2);
  expect(run(['fmt', '--width', '4', '-']).code).toBe(2);
  expect(run(['fmt', '-', '-']).code).toBe(2);
  expect(run(['fmt', '/nonexistent/northtalk.talk']).code).toBe(1);
});

test('lint prints advice without rejecting a valid Script, and selects either profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const file = join(dir, 'demo.talk');
  writeFileSync(file, 'on demo\nput {length: 1} into x\nend');
  const standard = run(['lint', file]);
  expect(standard.code).toBe(0);
  expect(standard.stdout).toContain(
    `${file}:2:6: warning [key-shadows-property]`,
  );
  expect(standard.stdout).not.toContain('prefer-explicit-end');
  const beginner = run(['lint', '--profile', 'beginner', file]);
  expect(beginner.code).toBe(0);
  expect(beginner.stdout).toContain(
    `${file}:3:1: warning [prefer-explicit-end]`,
  );
});

test('lint recovers after syntax errors and returns a syntax failure separately from advice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const file = join(dir, 'demo.talk');
  writeFileSync(
    file,
    'on demo\nput + into x\nput {length: 1} into x\nend demo',
  );
  const result = run(['lint', file]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${file}:2:5: unexpected token`);
  expect(result.stdout).toContain('[key-shadows-property]');
});

test('lint accepts multiple files and rejects invalid profile names and missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const file = join(dir, 'demo.talk');
  writeFileSync(file, 'on demo\nend demo');
  expect(run(['lint', file, file]).code).toBe(0);
  const invalid = run(['lint', '--profile', 'expert', file]);
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain('beginner or standard');
  expect(run(['lint']).code).toBe(2);
  expect(run(['lint', join(dir, 'missing.talk')]).code).toBe(2);
});

test('the Bun command runs through a bin symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const bin = join(dir, 'northtalk');
  symlinkSync(main, bin);
  const file = join(dir, 'demo.talk');
  writeFileSync(file, 'on demo\nput {length: 1} into x\nend demo');
  const result = Bun.spawnSync([process.execPath, bin, 'lint', file]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('[key-shadows-property]');
});

test('lint reads an explicit Host Manifest and keeps checker diagnostics out of its exit status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const file = join(dir, 'demo.talk');
  const manifest = join(dir, 'host.talk-manifest.json');
  writeFileSync(
    file,
    'constant min = 1\non demo\nput missing into x\nend demo',
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      kind: 'demo',
      version: '1',
      language: coreVersions.language,
      grants: [],
      libraries: [],
      messages: [],
      objects: [],
      objectKinds: [],
    }),
  );
  const result = run(['lint', '--manifest', manifest, file]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('[unknown-message]');
  expect(result.stdout).toContain('[shadows-builtin]');
  expect(result.stderr).toBe('');
  expect(run(['lint', file]).stdout).not.toContain('[unknown-message]');
  expect(
    run(['lint', '--manifest', join(dir, 'missing.json'), file]).code,
  ).toBe(2);
  expect(run(['lint', '--manifest']).code).toBe(2);
  writeFileSync(manifest, '{}');
  expect(run(['lint', '--manifest', manifest, file]).code).toBe(2);
});
