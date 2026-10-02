import { describe, expect, test } from 'bun:test';
import { parseEntry, parseInstant } from '../src/index';
import { SessionHost } from '../src/session';

const start = parseInstant('2026-09-30T10:00:00Z');
const session = () => {
  const clock = { now: start };
  const trace: string[] = [];
  const host = new SessionHost({
    now: () => clock.now,
    trace: line => trace.push(line),
  });
  return { host, clock, trace };
};
// Only `greet` is a Handler of the Session Script.
const kind = (source: string) => {
  const r = parseEntry(source, n => n === 'greet');
  return r.error ? r.error.code : r.kind;
};
const incomplete = (source: string) => {
  const r = parseEntry(source, () => false);
  return r.error ? r.incomplete : null;
};
const advance = (clock: { now: bigint }, seconds: number) => {
  clock.now += BigInt(seconds) * 1_000_000_000n;
};

describe('Entries', () => {
  test('are decided on their first token', () => {
    expect(kind('on greet name\n  say name\nend greet')).toBe('declaration');
    expect(kind('script variable v = 3')).toBe('declaration');
    expect(kind('use pad from text')).toBe('declaration');
    expect(kind('put 1 into x')).toBe('statement');
    expect(kind('next repeat')).toBe('statement');
    expect(kind('say "a"')).toBe('statement');
    expect(kind('greet "Ann"')).toBe('statement');
    // A Name that isn't a Handler starts an expression.
    expect(kind('n - 1')).toBe('expression');
    expect(kind('the length of "abc"')).toBe('expression');
    expect(kind('-- just a comment')).toBe(null);
    expect(kind('put 1 into x\nput 2 into y')).toBe('unexpected token');
  });

  test('that end early are incomplete, and others are not', () => {
    expect(incomplete('on greet name\n  say name')).toBe(true);
    expect(incomplete('if x then\n  say 1')).toBe(true);
    expect(incomplete('1 +')).toBe(true);
    expect(incomplete('put 1 + into x')).toBe(false);
    expect(incomplete('on greet name')).toBe(true);
    expect(incomplete('1 + 2')).toBe(null);
  });
});

describe('The Session Host', () => {
  test("prints chapter 12's example", () => {
    const { host } = session();
    expect(host.input('put 2.50 GBP into price')).toEqual([]);
    expect(host.input('price * 3')).toEqual(['7.50 GBP']);
    expect(host.input('"5"')).toEqual(['"5"']);
    expect(
      host.input('on greet name\n  say "hello " & name\nend greet'),
    ).toEqual([]);
    expect(host.input('greet "Ann"')).toEqual(['hello Ann']);
    expect(host.input('1 / 0')).toEqual([
      '! error {code: "division by zero"} at 1:3',
    ]);
  });

  test('loads the Session Script from empty source at the first Entry', () => {
    const { host, trace } = session();
    expect(trace).toEqual([]);
    host.input('1');
    expect(trace[0]).toStartWith('> load session identity=');
  });

  test('prints a line break inside written text as a new line', () => {
    const { host } = session();
    expect(host.input('say "a" & newline & "b"')).toEqual(['a', 'b']);
    expect(host.input('say "a" & newline')).toEqual(['a', '']);
  });

  test('rejects a whole Entry on a syntax error or diagnostic, in its own lines', () => {
    const { host, trace } = session();
    host.input('1');
    const before = trace.length;
    expect(host.input('put 1 + into x')).toEqual(['! unexpected token at 1:9']);
    // A syntax error never reaches the Core.
    expect(trace.length).toBe(before);
    expect(host.input('nope + 1')).toEqual(['! unknown name at 1:1']);
    expect(host.input('put 1 into x')).toEqual([]);
    expect(host.input('put 1 into y\nput 2 into y')).toEqual([
      '! unexpected token at 2:1',
    ]);
    expect(host.input('if true then\n  put nope into z\nend if')).toEqual([
      '! unknown name at 2:7',
    ]);
    // Neither rejected Entry added anything.
    expect(host.source).toBe('script variable x\n');
    expect(host.input('z')).toEqual(['! unknown name at 1:1']);
  });

  test('makes implicit Script Variables of the roots an Entry puts into', () => {
    const { host } = session();
    host.input('put 1 into a');
    host.input('if true then\n  put [a, 2] into list\n  add 3 to a\nend if');
    host.input('put {k: 1, j: 2} into m');
    expect(host.source).toBe(
      'script variable a\nscript variable list\nscript variable m\n',
    );
    expect(host.input('[a, list, m]')).toEqual(['[4, [1, 2], {k: 1, j: 2}]']);
  });

  test('keeps pattern names as the Run’s locals', () => {
    const { host } = session();
    const entry = (list: string) =>
      host.input(
        `if true then\n  let [a, b] be ${list}\n  put a + b into total\nend if`,
      );
    expect(entry('[1, 2]')).toEqual([]);
    expect(host.source).toBe('script variable total\n');
    expect(host.input('total')).toEqual(['3']);
    // Entering it again binds the same locals.
    expect(entry('[3, 4]')).toEqual([]);
    expect(host.input('total')).toEqual(['7']);
    expect(host.input('a')).toEqual(['! unknown name at 1:1']);
  });

  test('starts each Entry with `it` as Nothing', () => {
    const { host } = session();
    expect(host.input('it')).toEqual(['nothing']);
  });

  test('extends with new declarations, and keeps them in the session source', () => {
    const { host } = session();
    host.input('constant rate = 0.2');
    host.input('function tax amount\n  return amount * rate\nend tax');
    host.input('use pad from text');
    expect(host.input('tax(10)')).toEqual(['2.0']);
    expect(host.input('pad("a", 3)')).toEqual(['"a  "']);
    expect(host.source).toBe(
      'constant rate = 0.2\nfunction tax amount\n  return amount * rate\nend tax\nuse pad from text\n',
    );
  });

  test('redefines a declaration in its place, carrying Script Variables over', () => {
    const { host } = session();
    host.input('put 5 into n');
    host.input('function f x\n  return x + n\nend f');
    host.input('constant c = 1');
    expect(host.input('f(1)')).toEqual(['6']);
    expect(host.input('function f x\n  return x * n\nend f')).toEqual([]);
    expect(host.input('f(2)')).toEqual(['10']);
    expect(host.source).toBe(
      'script variable n\nfunction f x\n  return x * n\nend f\nconstant c = 1\n',
    );
  });

  test('replaces every clause of a Handler, and discards the Runs it stops', () => {
    const { host, clock } = session();
    host.input('put 0 into n');
    host.input('on bump\n  wait 5 s\n  add 1 to n\nend bump');
    expect(host.input('send bump to session')).toEqual([]);
    expect(host.nextDeadline).toBeDefined();
    expect(host.input('on bump\n  add 10 to n\nend bump')).toEqual([
      '! discarded session/r3',
    ]);
    expect(host.nextDeadline).toBeUndefined();
    advance(clock, 6);
    expect(host.tick()).toEqual([]);
    expect(host.input('n')).toEqual(['0']);
    host.input('send bump to session');
    expect(host.input('n')).toEqual(['10']);
    expect(host.source).toBe(
      'script variable n\non bump\n  add 10 to n\nend bump\n',
    );
  });

  test('moves a reused `use` name out of its earlier line', () => {
    const { host } = session();
    host.input('use pad, trim from text');
    host.input('use sum from list as pad');
    expect(host.source).toBe('use trim from text\nuse sum from list as pad\n');
    host.input('use trim from text');
    expect(host.source).toBe('use sum from list as pad\nuse trim from text\n');
  });

  test('leaves the source and the Script as they were when a Reload fails', () => {
    const { host } = session();
    host.input('function f x\n  return x\nend f');
    host.input('function g x\n  return f(x)\nend g');
    expect(host.input('function f x\n  return nope\nend f')).toEqual([
      '! unknown name at 2:10',
    ]);
    // A diagnostic outside the Entry names the unit.
    expect(host.input('function f x, y\n  return x\nend f')).toEqual([
      '! wrong argument count at session:5:10',
    ]);
    expect(host.source).toBe(
      'function f x\n  return x\nend f\nfunction g x\n  return f(x)\nend g\n',
    );
    expect(host.input('g(4)')).toEqual(['4']);
  });

  test('sets a Script Variable’s initialiser and puts it, without a Reload', () => {
    const { host, trace } = session();
    host.input('script variable count = 10');
    expect(host.input('count')).toEqual(['10']);
    expect(host.input('script variable count = count + 5')).toEqual([]);
    expect(host.input('count')).toEqual(['15']);
    expect(host.source).toBe('script variable count = count + 5\n');
    expect(trace.some(l => l.startsWith('> reload'))).toBe(false);
    expect(host.input('script variable count')).toEqual([]);
    expect(host.input('count')).toEqual(['nothing']);
    expect(host.source).toBe('script variable count\n');
  });

  test('names each implicit Handler with the next number the Script has no name for', () => {
    const { host, trace } = session();
    host.input('1');
    host.input('on entry2\n  return 0\nend entry2');
    host.input('2');
    expect(trace.filter(l => l.startsWith('> request'))).toEqual([
      '> request d1 to=session message=entry1',
      '> request d2 to=session message=entry3',
    ]);
  });

  test('prefixes the lines of a Run not started by an Entry', () => {
    const { host } = session();
    host.input('on ping\n  say "pong"\nend ping');
    expect(host.input('send ping to session')).toEqual(['[session/r2] pong']);
    expect(host.input('send nobody to session')).toEqual([
      '[session/r4] ! unhandled nobody []',
    ]);
  });

  test('sleeps while the Foreground Run waits only for a deadline', () => {
    const { host, clock } = session();
    host.input('on nap\n  wait 2 s\n  say "done"\nend nap');
    expect(host.input('nap and wait')).toEqual([]);
    expect(host.waiting).toEqual({
      k: 'deadline',
      at: start + 2_000_000_000n,
    });
    advance(clock, 2);
    expect(host.tick()).toEqual(['done']);
    expect(host.waiting).toEqual({ k: 'prompt' });
  });

  test('answers the Foreground Run’s read with a typed line', () => {
    const { host } = session();
    host.input(
      'on echo\n  ask console to read and wait\n  say "got " & it\nend echo',
    );
    expect(host.input('echo and wait')).toEqual([]);
    expect(host.waiting).toEqual({ k: 'read' });
    expect(host.read('hello')).toEqual(['got hello']);
    expect(host.waiting).toEqual({ k: 'prompt' });
  });

  test('returns the prompt for any other wait, and goes on in the background', () => {
    const { host, clock } = session();
    host.input('on later\n  wait 1 s\n  say "later"\nend later');
    expect(host.input('send later to session and wait')).toEqual([]);
    expect(host.waiting).toEqual({ k: 'prompt' });
    advance(clock, 1);
    expect(host.tick()).toEqual(['[session/r2] later']);
  });

  test('prints a Limit Fault with its limit word', () => {
    const { host } = session();
    expect(host.input('repeat forever\n  put 1 into x\nend repeat')).toEqual([
      expect.stringMatching(/^! limit fault fuel at 2:\d+$/),
    ]);
  });

  test('refuses Session Commands it does not know', () => {
    const { host } = session();
    expect(host.input(':nope')).toEqual(['! unknown command']);
  });
});
