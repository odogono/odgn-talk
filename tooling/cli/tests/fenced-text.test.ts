import { expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseTranscript } from '@odgn/northtalk/session';

const run = (stdin: string, args: string[] = []) => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, '../src/main.ts'), ...args],
    {
      stdin: new TextEncoder().encode(stdin),
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  return result.stdout.toString();
};

test('REPL preserves blank lines inside raw and interpolated text', () => {
  expect(run('say `\nfirst\n\nsecond\n`\nsay """\nraw\n\ntext\n"""\n')).toBe(
    'first\n\nsecond\nraw\n\ntext\n',
  );
});

test('REPL keeps blank lines and multiline expressions inside a hole pending', () => {
  expect(run('say `sum ${1 +\n\n2}`\n')).toBe('sum 3\n');
});

test.each([
  ['say `unfinished', '! unterminated text at 1:5\n'],
  ['say """unfinished', '! unterminated text at 1:5\n'],
  ['say `value ${1 +', '! unterminated interpolation at 1:12\n'],
  ['say `value ${`nested', '! unterminated text at 1:14\n'],
])('REPL reports final EOF for %s', (source, expected) => {
  expect(run(source!)).toBe(expected!);
});

test('REPL waits for the enclosing Entry after a literal closes', () => {
  expect(run('on greet\n say `hello`\n\nend greet\ngreet\n')).toBe('hello\n');
});

test('REPL input and recording agree with the shared fenced-text Session Transcript', () => {
  const items = parseTranscript(
    readFileSync(
      resolve(
        import.meta.dir,
        '../../../corpus/sessions/fenced-text/session.transcript',
      ),
      'utf8',
    ),
  ).filter(item => item.k !== 'comment');
  const input =
    items
      .flatMap(item => (item.k === 'input' ? [item.source] : []))
      .join('\n') + '\n';
  const expected =
    items.flatMap(item => (item.k === 'output' ? [item.text] : [])).join('\n') +
    '\n';
  const directory = mkdtempSync(join(tmpdir(), 'fenced-repl-'));
  try {
    const path = join(directory, 'session.transcript');
    expect(run(input, ['--transcript', path])).toBe(expected);
    expect(parseTranscript(readFileSync(path, 'utf8'))).toEqual([
      { k: 'envelope', json: '{"objects":{},"type":"setup"}' },
      ...items,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
