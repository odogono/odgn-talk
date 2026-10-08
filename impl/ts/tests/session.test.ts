import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseEntry, parseInstant } from '../src/index';
import {
  parseTranscript,
  replayTranscript,
  SessionHost,
  writeTranscript,
  type TranscriptItem,
} from '../src/session';

test('a Session Script chooses a Library offer and replays its Transcript and Trace', () => {
  const trace: string[] = [];
  const items: TranscriptItem[] = [];
  const host = new SessionHost({
    now: () => start,
    record: item => items.push(item),
    trace: line => trace.push(line),
  });
  const library = readFileSync(
    new URL('../../../corpus/recovery-offers/basic/rows.talk', import.meta.url),
    'utf8',
  );
  for (const source of [
    ':clock virtual 2026-09-30T10:00:00Z',
    `:library add rows\n${library.trimEnd()}`,
    'use parseRows from rows',
    'function convert row\n return row as number\nend convert',
    'on go\n try\n  put parseRows(["5", "bad", "7"], convert) into rows\n catch e before unwind where offerAvailable("useValue")\n  choose offer useValue(0)\n end try\n say rows\nend go',
  ]) {
    expect(host.input(source)).toEqual([]);
  }
  expect(host.input('go')).toEqual(['[5, 0, 7]']);
  const text = writeTranscript(items);
  const replayedTrace: string[] = [];
  const replayed = replayTranscript(parseTranscript(text), {
    trace: line => replayedTrace.push(line),
  });
  expect(writeTranscript(replayed.items)).toBe(text);
  expect(replayedTrace).toEqual(trace);
  expect(trace.filter(line => line.startsWith('offer-chosen '))).toHaveLength(
    1,
  );
  expect(trace.filter(line => line.startsWith('offer-entered '))).toHaveLength(
    1,
  );
});

test('an echoed map with an offer key reads back as an equal map', () => {
  const host = new SessionHost({ now: () => start });
  expect(host.input('put {} into m')).toEqual([]);
  expect(host.input('put 1 into the offer of m')).toEqual([]);
  expect(host.input('put true into the if of m')).toEqual([]);
  const [echo] = host.input('m');
  expect(echo).toBe('{"offer": 1, if: true}');
  expect(host.input(echo!)).toEqual([echo!]);
  expect(host.input(`(${echo}) = m`)).toEqual(['true']);
});

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
    // A `tell` block reads lines until its `end` (ADR 0063).
    expect(incomplete('tell canvas')).toBe(true);
    expect(incomplete('tell canvas\n  fill 1')).toBe(true);
    expect(incomplete('tell canvas\n  fill 1\nend tell')).toBe(null);
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

  test('extends with a Fallback Handler, and redefines it in its place', () => {
    const { host } = session();
    host.input('put [] into seen');
    host.input(
      'on any message m\n  put the name of m after seen\nend any message',
    );
    host.input('send hop with 1 to session');
    expect(host.input('seen')).toEqual(['["hop"]']);
    expect(
      host.input('on any message m\n  put 0 after seen\nend any message'),
    ).toEqual([]);
    host.input('send skip to session');
    expect(host.input('seen')).toEqual(['["hop", 0]']);
    expect(host.source).toBe(
      'script variable seen\non any message m\n  put 0 after seen\nend any message\n',
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

describe('Mock Operations', () => {
  test('are defined and granted only before the session starts', () => {
    const { host } = session();
    expect(host.input(':mock db.get immediate')).toEqual([]);
    expect(host.input(':grant store db')).toEqual([]);
    expect(host.input(':grant other nope')).toEqual(['! bad arguments']);
    expect(host.input(':mock db.get sometimes')).toEqual(['! bad arguments']);
    expect(host.input(':mock console.write immediate')).toEqual([
      '! bad arguments',
    ]);
    host.input('1');
    expect(host.input(':mock db.put immediate')).toEqual(['! session started']);
    expect(host.input(':grant again db')).toEqual(['! session started']);
    expect(host.grants).toEqual({
      granted: { db: 'db', store: 'db' },
      mocks: [{ capability: 'db', operation: 'get', mode: 'immediate' }],
    });
  });

  test('take up to eight arguments, and print each call', () => {
    const { host } = session();
    host.input(':mock log.write fire-and-forget');
    expect(host.input('tell log to write')).toEqual([
      'call session/r1.c1 log.write []',
    ]);
    expect(host.input('tell log to write 1, 2, 3, 4, 5, 6, 7, 8')).toEqual([
      'call session/r2.c1 log.write [1, 2, 3, 4, 5, 6, 7, 8]',
    ]);
    expect(host.input('tell log to write 1, 2, 3, 4, 5, 6, 7, 8, 9')).toEqual([
      '! wrong argument count at 1:13',
    ]);
  });

  test('answer immediate calls from Stubs, which the Trace records', () => {
    const { host, trace } = session();
    host.input(':mock db.get immediate');
    expect(host.input(':stub db.get [1, 2]')).toEqual([]);
    expect(trace.at(-1)).toBe('> stub db.get value=[1, 2]');
    expect(host.input(':stub db.get fail {code: 7}')).toEqual([
      '! bad arguments',
    ]);
    expect(host.input(':stub db.nope 1')).toEqual(['! bad arguments']);
    host.input('function get\n  ask db to get\n  return it\nend get');
    expect(host.input('get()')).toEqual([
      'call session/r1.c1 db.get []',
      '[1, 2]',
    ]);
  });

  test('settle suspending calls with :answer and :fail', () => {
    const { host } = session();
    host.input(':mock http.fetch suspending');
    host.input('on fetch\n  ask http to fetch and wait\n  say it\nend fetch');
    expect(host.input('send fetch to session')).toEqual([
      '[session/r2] call session/r2.c1 http.fetch []',
    ]);
    expect(host.input(':answer session/r2.c1 "ok"')).toEqual([
      '[session/r2] ok',
    ]);
    expect(host.input(':answer session/r2.c1 "ok"')).toEqual([
      '! no such call',
    ]);
    host.input('send fetch to session');
    expect(host.input(':fail session/r4.c1 {code: "down"}')).toEqual([
      '[session/r4] ! error {code: "down", capability: "http", operation: "fetch"} at session+1:2:3',
    ]);
  });
});

describe('The Clock, limits and Runs', () => {
  test('a virtual Clock moves only at :clock commands', () => {
    const { host } = session();
    expect(host.input(':clock')).toEqual(['real']);
    host.input(':clock virtual 2026-09-30T10:00:00Z');
    host.input('on nap\n  wait 2 s\n  say "up"\nend nap');
    expect(host.input('nap and wait')).toEqual([]);
    // A deadline wait returns the prompt at once.
    expect(host.waiting).toEqual({ k: 'prompt' });
    expect(host.input(':clock advance 1 s')).toEqual([]);
    expect(host.input(':clock advance 1 s')).toEqual(['[session/r1] up']);
    expect(host.input(':clock')).toEqual(['virtual 2026-09-30T10:00:02Z']);
    expect(host.input(':clock virtual 2026-09-30T09:00:00Z')).toEqual([
      '! clock backwards',
    ]);
    expect(host.input(':clock advance -1 s')).toEqual(['! bad arguments']);
    host.input(':clock real');
    expect(host.input(':clock advance 1 s')).toEqual(['! clock is real']);
    // A real reading earlier than the last Pump's is taken as the last Pump's.
    host.input('1');
    expect(host.input(':clock')).toEqual(['real 2026-09-30T10:00:02Z']);
  });

  test(':limits tightens the limits later Entries run with', () => {
    const { host, trace } = session();
    expect(host.input(':limits')).toEqual([
      'fuelPerRun 10000000',
      'allocPerRun 16777216',
      'maxWaitMs 30000',
      'maxJoin 16',
    ]);
    expect(host.input(':limits maxJoin 4')).toEqual([]);
    expect(host.input(':limits maxJoin 17')).toEqual(['! invalid value']);
    expect(host.input(':limits maxJoin -1')).toEqual(['! bad arguments']);
    host.input('1');
    host.input(':limits reset');
    host.input('2');
    expect(trace.filter(l => l.startsWith('> request'))).toEqual([
      '> request d1 to=session message=entry1 limits={maxJoin: 4}',
      '> request d2 to=session message=entry2',
    ]);
  });

  test(':cancel cancels the latest Entry’s Run, or a named one', () => {
    const { host } = session();
    host.input(':clock virtual 2026-09-30T10:00:00Z');
    host.input('on nap\n  wait 9 s\nend nap');
    host.input('nap and wait');
    expect(host.input(':cancel')).toEqual(['[session/r1] ! cancelled']);
    expect(host.input(':cancel')).toEqual(['! no such run']);
    host.input('send nap to session');
    expect(host.input(':cancel session/r3')).toEqual([
      '[session/r3] ! cancelled',
    ]);
  });

  test(':runs, :mailbox and :vars render Inspect()', () => {
    const { host, trace } = session();
    host.input(':clock virtual 2026-09-30T10:00:00Z');
    host.input('put [1] into xs');
    host.input('on nap\n  wait 9 s\nend nap');
    host.input('send nap to session');
    expect(host.input(':vars')).toEqual(['xs = [1]']);
    expect(trace.at(-2)).toBe('> vars');
    expect(host.input(':runs')).toEqual([
      'session/r3 suspended nap wait until 2026-09-30T10:00:09Z',
    ]);
    expect(host.input(':mailbox')).toEqual([]);
    expect(host.input(':vars now')).toEqual(['! bad arguments']);
  });
});

describe('Saves, Libraries and export', () => {
  test(':save and :restore keep the Session Host’s own state', () => {
    const { host } = session();
    host.input(':clock virtual 2026-09-30T10:00:00Z');
    host.input('put 1 into n');
    expect(host.input(':save')).toEqual(['saved default']);
    host.input('put 2 into n');
    host.input('function f\n  return 0\nend f');
    host.input(':limits maxJoin 2');
    host.input(':clock advance 10 s');
    expect(host.input(':restore')).toEqual(['restored default']);
    expect(host.input('n')).toEqual(['1']);
    expect(host.source).toBe('script variable n\n');
    expect(host.input(':limits')).toContain('maxJoin 16');
    expect(host.input(':clock')).toEqual(['virtual 2026-09-30T10:00:00Z']);
    expect(host.input(':restore other')).toEqual(['! no such save']);
  });

  test(':library reads a file given a path, and records its source', () => {
    const files = new Map([
      ['lib.talk', 'function twice x\n  return x * 2\nend twice'],
    ]);
    const host = new SessionHost({
      now: () => start,
      readFile: path => {
        const text = files.get(path);
        if (text === undefined) {
          throw new Error('no file');
        }
        return text;
      },
    });
    expect(host.input(':library add maths lib.talk')).toEqual([]);
    expect(host.userLibraries).toEqual([
      {
        name: 'maths',
        version: '1',
        source: 'function twice x\n  return x * 2\nend twice\n',
      },
    ]);
    host.input('use twice from maths');
    expect(host.input('twice(4)')).toEqual(['8']);
    expect(host.input(':library add maths lib.talk')).toEqual([
      '! name reused',
    ]);
    expect(host.input(':library add other missing.talk')).toEqual([
      '! bad arguments',
    ]);
    expect(
      host.input(
        ':library replace maths\nfunction twice x\n  return x + x\nend twice',
      ),
    ).toEqual([]);
    expect(host.input('twice(5)')).toEqual(['10']);
  });

  test(':export prints the session source, or writes it and each Library', () => {
    const written: string[] = [];
    const host = new SessionHost({
      now: () => start,
      writeFile: (directory, file, text) =>
        written.push(`${directory}/${file}=${text}`),
    });
    host.input(':library add lib\nconstant k = 1');
    host.input('use k from lib');
    host.input('put k into v');
    expect(host.input(':export')).toEqual([
      'use k from lib',
      'script variable v',
    ]);
    expect(host.input(':export out')).toEqual([
      'wrote session.talk',
      'wrote lib.talk',
    ]);
    expect(written).toEqual([
      'out/session.talk=use k from lib\nscript variable v\n',
      'out/lib.talk=constant k = 1\n',
    ]);
  });

  test('grants the built-in clock, which reads the Pump’s Clock', () => {
    const { host } = session();
    expect(host.input(':grant time clock')).toEqual([]);
    expect(host.input(':mock clock.now immediate')).toEqual([
      '! bad arguments',
    ]);
    host.input('function now\n  ask time to now\n  return it\nend now');
    expect(host.input('now()')).toEqual(['2026-09-30T10:00:00Z']);
  });
});

test('lifecycle failures render without success values or a crash', () => {
  const { host } = session();
  // Session mocks have no lifecycle declarations. Exercise the consumer with
  // the typed notifications/reports an embedding Host receives from the Core.
  const consumer = host as unknown as {
    events: import('../src/group').RunEvent[];
    print(reports: import('../src/group').Report[]): string[];
  };
  consumer.events = [{ k: 'run', run: 'session/r1', outcome: 'effect-failed' }];
  const failure = {
    script: 'session',
    run: 'session/r1',
    grant: 'db',
    segment: 'session/r1.s1',
    phase: 'commit' as const,
    status: 'failed' as const,
  };
  expect(
    consumer.print([
      { kind: 'effect failure', ...failure },
      {
        kind: 'run end',
        script: 'session',
        run: 'session/r1',
        outcome: 'effect failed',
        fuel: 0,
        alloc: 0,
        effect: failure,
      },
    ]),
  ).toEqual([
    '[session/r1] ! effect failure grant=db segment=session/r1.s1 phase=commit status=failed',
    '[session/r1] ! effect failed',
  ]);
});

test('outside-Pump lifecycle reports render fatal cleanup instead of silent replacement success', () => {
  const { host } = session();
  const consumer = host as unknown as {
    discarded(reports: import('../src/group').Report[]): string[];
  };
  expect(
    consumer.discarded([
      {
        kind: 'effect failure',
        script: 'session',
        run: 'session/r1',
        grant: 'db',
        segment: 'session/r1.s1',
        phase: 'rollback',
        status: 'failed',
      },
      {
        kind: 'stop',
        script: 'session',
        reason: 'effect state unknown',
        discardedRuns: ['session/r1'],
        droppedMessages: [],
        pendingCalls: [],
      },
    ]),
  ).toEqual([
    '[session/r1] ! effect failure grant=db segment=session/r1.s1 phase=rollback status=failed',
    '! effect state unknown',
    '! discarded session/r1',
  ]);
});

test('fatal cleanup reports keep the Session Source and user Library at their previous definitions', () => {
  const reports: import('../src/group').Report[] = [
    {
      kind: 'effect failure',
      script: 'session',
      run: 'session/r1',
      grant: 'db',
      segment: 'session/r1.s1',
      phase: 'rollback',
      status: 'failed',
    },
    {
      kind: 'stop',
      script: 'session',
      reason: 'effect state unknown',
      discardedRuns: [],
      droppedMessages: [],
      pendingCalls: [],
    },
  ];
  const first = new SessionHost({ now: () => start });
  first.input('function one\nreturn 1\nend one');
  const previous = first.source;
  // Session Commands don't offer lifecycle metadata. Supply the native API's
  // terminal reports at its boundary to verify the consumer's publication.
  const script = (first as unknown as { script: { reload(): typeof reports } })
    .script;
  script.reload = () => reports;
  expect(first.input('function one\nreturn 2\nend one')).toContain(
    '! effect state unknown',
  );
  expect(first.source).toBe(previous);

  const second = new SessionHost({
    now: () => start,
    readFile: path =>
      path === 'old.talk'
        ? 'function one\nreturn 1\nend one'
        : 'function one\nreturn 2\nend one',
  });
  expect(second.input(':library add user old.talk')).toEqual([]);
  const libraries = second.userLibraries;
  const group = (
    second as unknown as { group: { replaceLibrary(): typeof reports } }
  ).group;
  group.replaceLibrary = () => reports;
  expect(second.input(':library replace user next.talk')).toContain(
    '! effect state unknown',
  );
  expect(second.userLibraries).toEqual(libraries);
});

describe('Debugging a session', () => {
  const greet = 'on greet name\n  say "hello " & name\n  say "bye"\nend greet';

  test('pauses an Entry and prints the same lines and Trace', () => {
    const plain = session();
    plain.host.input(greet);
    const expected = plain.host.input('greet "Ann"');

    const { host, trace } = session();
    expect(host.debugController()).toBeNull();
    host.input(greet);
    const controller = host.debugController()!;
    const unit = controller.sources().find(s => s.unit.name === 'session+1')!;
    controller.breakAt([{ unit: 'session+1', pc: unit.statements[1]! }]);
    expect(host.input('greet "Ann"')).toEqual([]);
    expect(host.waiting).toEqual({ k: 'paused' });
    expect(() => host.input('1')).toThrow('debug-paused');
    expect(host.tick()).toEqual([]);
    const out: string[] = [];
    out.push(...host.continueDebug('step'));
    while (host.waiting.k === 'paused') {
      out.push(...host.continueDebug('resume'));
    }
    expect(out).toEqual(expected);
    expect(trace).toEqual(plain.trace);
    expect(() => host.continueDebug('resume')).toThrow('not debug-paused');
  });

  test('places each declaration in its loaded code unit', () => {
    const { host } = session();
    host.input('on a\n  say 1\nend a');
    host.input('put 3 into n');
    expect(host.placementsOfSource).toEqual([
      { sourceLine: 1, lines: 3, unit: 'session+1', unitLine: 1 },
      { sourceLine: 4, lines: 1, unit: 'session+2', unitLine: 1 },
    ]);
    // A Redefinition reloads every declaration into the base unit.
    host.input('on a\n  say 2\nend a');
    expect(host.placementsOfSource).toEqual([
      { sourceLine: 1, lines: 3, unit: 'session', unitLine: 1 },
      { sourceLine: 4, lines: 1, unit: 'session', unitLine: 4 },
    ]);
  });

  test('exposes its Grants without starting', () => {
    const { host } = session();
    host.input(':grant c clock');
    expect(Object.keys(host.sessionGrants).sort()).toEqual(['c', 'console']);
    expect(host.inspect()).toBeNull();
  });
});

test('Session Entries recognise the first word of a labelled Handler', () => {
  const { host } = session();
  expect(host.input('on move x to y\n  say x + y\nend move')).toEqual([]);
  expect(host.input('move 3 to 4')).toEqual(['7']);
  expect(host.input('on move x toward y\n  say x * y\nend move')).toEqual([]);
  expect(host.input('move 3 toward 4')).toEqual(['12']);
});
