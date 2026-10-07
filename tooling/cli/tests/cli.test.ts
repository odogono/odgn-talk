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

test('the REPL chooses a Library offer and replays the recorded session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-recovery-'));
  const transcript = join(dir, 'session.transcript');
  const rows = resolve(
    import.meta.dir,
    '../../../corpus/recovery-offers/basic/rows.talk',
  );
  const input = [
    ':clock virtual 2026-09-30T10:00:00Z',
    `:library add rows ${rows}`,
    'use parseRows from rows',
    'function convert row',
    ' return row as number',
    'end convert',
    'on go',
    ' try',
    '  put parseRows(["5", "bad", "7"], convert) into rows',
    ' catch e before unwind where offerAvailable("useValue")',
    '  choose offer useValue(0)',
    ' end try',
    ' say rows',
    'end go',
    'go',
    ':quit',
    '',
  ].join('\n');
  expect(run(['--transcript', transcript], input)).toEqual({
    code: 0,
    stdout: '[5, 0, 7]\n',
    stderr: '',
  });
  expect(readFileSync(transcript, 'utf8')).toContain(
    '|   choose offer useValue(0)',
  );
  expect(run(['replay', transcript]).code).toBe(0);
});

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

// A directory of Scripts under test, a Test Script and a Host Manifest
// granting `http`.
const testDir = (tests: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  writeFileSync(
    join(dir, 'counter.talk'),
    [
      'script variable n = 0',
      'on inc',
      '  add 1 to n',
      '  return n',
      'end inc',
      'on boom',
      '  throw {code: "bad"}',
      'end boom',
      'on later',
      '  wait for ping or 10 s',
      '  if it is nothing then return "timed out"',
      '  return "pinged"',
      'end later',
      'on fetch url',
      '  ask http to get url and wait',
      '  return it',
      'end fetch',
      'on log line',
      '  tell http to note line',
      'end log',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'counter.test.talk'), tests);
  const manifest = join(dir, 'host.talk-manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      kind: 'demo',
      version: '1',
      language: coreVersions.language,
      grants: [
        {
          name: 'http',
          capability: 'http',
          operations: [
            { name: 'get', mode: 'suspending', args: ['text'] },
            { name: 'note', mode: 'fire-and-forget', args: ['text'] },
          ],
        },
      ],
      libraries: [],
      messages: [],
      objects: [],
      objectKinds: [],
    }),
  );
  return { dir, manifest };
};

test('test runs each Test Handler against the Scripts beside it', () => {
  const { dir, manifest } = testDir(
    [
      'use assert, assertEqual from test',
      'script variable seed = 0',
      'on setup',
      '  put 5 into seed',
      'end setup',
      'on testIncrements',
      '  send inc to counter and wait',
      '  assertEqual(it, 1)',
      '  assertEqual(seed, 5)',
      'end testIncrements',
      'on testFreshGroup',
      '  send inc to counter and wait',
      '  assert(it = 1)',
      'end testFreshGroup',
      'on testWithParameters x',
      'end testWithParameters',
      'on helper',
      'end helper',
      '',
    ].join('\n'),
  );
  const { code, stdout } = run(['test', '--manifest', manifest, dir]);
  expect(code).toBe(0);
  const file = join(dir, 'counter.test.talk');
  expect(stdout).toBe(
    [
      `ok ${file} testIncrements`,
      `ok ${file} testFreshGroup`,
      '2 passed, 0 failed',
      '',
    ].join('\n'),
  );
});

test('test reports a failed assertion, a background error and an unhandled message', () => {
  const { dir, manifest } = testDir(
    [
      'use assert, assertEqual from test',
      'on testEqual',
      '  send inc to counter and wait',
      '  assertEqual(it, 2)',
      'end testEqual',
      'on testThrows',
      '  say "about to fail"',
      '  assert(false, "nope")',
      'end testThrows',
      'on testBackground',
      '  send boom to counter',
      'end testBackground',
      'on testUnhandled',
      '  send nope to counter',
      'end testUnhandled',
      'on testStuck',
      '  wait for never',
      'end testStuck',
      '',
    ].join('\n'),
  );
  const { code, stdout } = run(['test', '--manifest', manifest, dir]);
  expect(code).toBe(1);
  const file = join(dir, 'counter.test.talk');
  expect(stdout).toContain(
    `FAIL ${file}:2:1 testEqual\n  counterTest testEqual errored: {code: "assertion failed", expected: 2, actual: 1}\n`,
  );
  expect(stdout).toContain(
    `FAIL ${file}:6:1 testThrows\n  counterTest testThrows errored: {code: "assertion failed"}\n    nope\n  | about to fail\n`,
  );
  expect(stdout).toContain(
    `FAIL ${join(dir, 'counter.talk')}:7:3 testBackground\n  counter boom errored: {code: "bad"}\n`,
  );
  expect(stdout).toContain(
    `FAIL ${file}:13:1 testUnhandled\n  counter has no Handler for nope\n`,
  );
  expect(stdout).toContain(
    `FAIL ${file}:16:1 testStuck\n  testStuck waits for something that never comes\n`,
  );
  expect(stdout).toEndWith('0 passed, 5 failed\n');
  // --only picks tests by file and name.
  const only = run(['test', '--manifest', manifest, '--only', 'Equal', dir]);
  expect(only.stdout).toEndWith('0 passed, 1 failed\n');
  expect(run(['test', '--only', 'nothing', dir])).toMatchObject({
    code: 1,
    stderr: 'No tests found\n',
  });
});

test('test grants the Host Manifest as mocks the harness answers', () => {
  const { dir, manifest } = testDir(
    [
      'use assertEqual from test',
      'on testStub',
      '  tell harness to stub "http.get", {status: 200}',
      '  send fetch with "u" to counter and wait',
      '  assertEqual(it, {status: 200})',
      '  ask harness to calls "http.get"',
      '  assertEqual(it, [["u"]])',
      'end testStub',
      'on testFire',
      '  send log with "hi" to counter and wait',
      '  ask harness to calls "http.note"',
      '  assertEqual(it, [["hi"]])',
      'end testFire',
      'on testStubFail',
      '  tell harness to stubFail "http.get", {code: "missing"}',
      '  send fetch with "u" to counter',
      'end testStubFail',
      'on testUnstubbed',
      '  send fetch with "u" to counter',
      'end testUnstubbed',
      'on testUnknown',
      '  tell harness to stub "http.nope", 1',
      'end testUnknown',
      '',
    ].join('\n'),
  );
  const { code, stdout } = run(['test', '--manifest', manifest, dir]);
  expect(code).toBe(1);
  const file = join(dir, 'counter.test.talk');
  const counter = join(dir, 'counter.talk');
  expect(stdout).toContain(`ok ${file} testStub\n`);
  expect(stdout).toContain(`ok ${file} testFire\n`);
  expect(stdout).toContain(
    `FAIL ${counter}:15:3 testStubFail\n  counter fetch errored: {code: "missing", capability: "http", operation: "get"}\n`,
  );
  expect(stdout).toContain(
    `FAIL ${counter}:15:3 testUnstubbed\n  counter fetch errored: {code: "unstubbed call", capability: "http", operation: "get"}\n    No answer is queued for http.get\n`,
  );
  expect(stdout).toContain(
    `FAIL ${file}:22:3 testUnknown\n  counterTest testUnknown errored: {code: "no such operation", name: "http.nope", capability: "harness", operation: "stub"}\n`,
  );
  // Without the manifest, the Script that uses `http` doesn't load.
  expect(run(['test', dir]).stdout).toContain(`counter.talk doesn't load: `);
});

test('test runs on a virtual Clock the harness moves on', () => {
  const { dir, manifest } = testDir(
    [
      'use assertEqual from test',
      'on testTimeout',
      '  send later to counter and wait',
      '  assertEqual(it, "timed out")',
      'end testTimeout',
      'on testAdvance',
      '  ask clock to now',
      '  put it into before',
      '  send later to counter',
      '  ask harness to advance 3 s and wait',
      '  ask clock to now',
      '  assertEqual(it - before, 3 s)',
      'end testAdvance',
      '',
    ].join('\n'),
  );
  const { code, stdout } = run(['test', '--manifest', manifest, dir]);
  expect(stdout).toEndWith('2 passed, 0 failed\n');
  expect(code).toBe(0);
});

test('test replays Session Transcripts as tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  const recorded = readFileSync(
    join(corpus, 'basics/session.transcript'),
    'utf8',
  );
  writeFileSync(join(dir, 'good.transcript'), recorded);
  writeFileSync(
    join(dir, 'bad.transcript'),
    recorded.replace('7.50 GBP\n', '8 GBP\n'),
  );
  const { code, stdout } = run(['test', dir]);
  expect(code).toBe(1);
  expect(stdout).toContain(`ok ${join(dir, 'good.transcript')}\n`);
  expect(stdout).toContain(`FAIL ${join(dir, 'bad.transcript')}:`);
  expect(stdout).toContain('    expected: 8 GBP\n    actual:   7.50 GBP\n');
  expect(stdout).toEndWith('1 passed, 1 failed\n');
});

test('test refuses a missing path and other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-'));
  writeFileSync(join(dir, 'plain.talk'), 'on go\nend go\n');
  expect(run(['test', join(dir, 'missing')]).code).toBe(2);
  expect(run(['test', join(dir, 'plain.talk')]).code).toBe(2);
  expect(run(['test', '--only']).code).toBe(2);
});

test('the REPL continues labelled calls using the loaded Handler first word', () => {
  const { code, stdout } = run(
    [],
    'on move piece to square\n say piece & square\nend move\nmove (\n "knight"\n) to "e4"\n:quit\n',
  );
  expect(code).toBe(0);
  expect(stdout).toBe('knighte4\n');
});
