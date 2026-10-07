import { describe, expect, test } from 'bun:test';
import { parseInstant } from '@odgn/northtalk';
import { PlaygroundSession, SESSION_TAB } from '../src/session';
import {
  recoveryLibrary,
  recoveryScript,
} from '../../stack/tests/verify-recovery-debug';

test('a Library offer runs from the Script tab with dispatch owner views and Transcript replay', () => {
  const { env } = environment();
  const s = new PlaygroundSession(env);
  const library = { name: 'rows', source: recoveryLibrary };
  expect(s.saveLibrary(library)).toEqual([]);
  expect(s.apply(recoveryScript)).toMatchObject({
    kind: 'applied',
    failed: [],
  });
  const tabs = { script: recoveryScript, libraries: [library] };
  s.setBreakpoints(
    [{ tab: SESSION_TAB, line: 8 }],
    { error: false, limitFault: false },
    tabs,
  );
  expect(s.input('go')).toEqual([]);
  s.setBreakpoints([], { error: false, limitFault: false }, tabs);
  s.continueDebug('stepOver');
  expect(s.pauseView()?.tab).toEqual({ name: SESSION_TAB, line: 10 });
  s.continueDebug('stepOver');
  const pause = s.pauseView()!;
  expect(pause.tab).toEqual({ name: SESSION_TAB, line: 11 });
  const dispatch = pause.frames[0]!;
  expect(dispatch.role).toBe('dispatch');
  expect(dispatch.locals).toContain('policy = 2');
  expect(pause.frames[dispatch.owner!]!.role).toBe('retained');
  expect(pause.frames[dispatch.owner!]!.locals).toEqual(dispatch.locals);
  s.setBreakpoints(
    [{ tab: 'rows', line: 13 }],
    { error: false, limitFault: false },
    tabs,
  );
  s.continueDebug('resume');
  expect(s.pauseView()?.tab).toEqual({ name: 'rows', line: 13 });
  expect(s.pauseView()?.frames[0]!.locals).toContain('accumulated = 4');
  expect(s.pauseView()?.frames[0]!.locals).toContain('value = 3');
  s.setBreakpoints([], { error: false, limitFault: false }, tabs);
  expect(s.continueDebug('resume')).toEqual([]);
  expect(s.input('say "done"')).toEqual(['done']);
  const opened = PlaygroundSession.replay(env, s.transcriptText);
  if (!('session' in opened)) {
    throw new Error('Recovery Transcript did not replay');
  }
  expect(opened.session.trace).toEqual(s.trace);
  expect(opened.session.input('go')).toEqual([]);
  expect(
    s.trace.filter(line => line.startsWith('offer-entered ')),
  ).toHaveLength(1);
});

const start = parseInstant('2026-09-30T10:00:00Z');
const environment = () => {
  const clock = { now: start, ms: 0 };
  return {
    clock,
    env: { now: () => clock.now, monotonic: () => clock.ms },
  };
};
const greet = 'on greet name\n  say "hello " & name\n  say "bye"\nend greet';

describe('The Script tab', () => {
  test('applies new and changed declarations as Entries', () => {
    const s = new PlaygroundSession(environment().env);
    expect(s.apply(`constant k = 2\n\n${greet}\n`)).toEqual({
      kind: 'applied',
      lines: [],
      failed: [],
      pending: 0,
    });
    expect(s.input('greet "Ann"')).toEqual(['hello Ann', 'bye']);
    expect(s.host.source).toBe(`constant k = 2\n${greet}\n`);
    const changed = greet.replace('"bye"', '"later"');
    expect(s.apply(`constant k = 2\n${changed}\n`).kind).toBe('applied');
    expect(s.input('greet "Bo"')).toEqual(['hello Bo', 'later']);
    // Applying the same tab again enters nothing.
    const before = s.transcript.length;
    s.apply(`constant k = 2\n${changed}\n`);
    expect(s.transcript.length).toBe(before);
  });

  test('lets a declaration use one later in the tab', () => {
    const s = new PlaygroundSession(environment().env);
    const r = s.apply(
      'on go\n  say twice(2)\nend go\nfunction twice n\n  return n * 2\nend twice\n',
    );
    expect(r).toMatchObject({ kind: 'applied', failed: [] });
    expect(s.input('go')).toEqual(['4']);
  });

  test('needs a Restart to drop a declaration', () => {
    const s = new PlaygroundSession(environment().env);
    s.input(':grant c clock');
    s.apply('constant a = 1\nconstant b = 2\n');
    s.input(':limits fuelPerRun 5000');
    expect(s.apply('constant a = 1\n')).toEqual({
      kind: 'restart',
      removed: ['constant b'],
    });
    const { session } = s.restart({
      script: 'constant a = 1\n',
      libraries: [],
    });
    expect(session.host.source).toBe('constant a = 1\n');
    expect(session.setup).toEqual([':grant c clock']);
    expect(session.input(':limits')[0]).toBe('fuelPerRun 5000');
    expect(session.transcriptText).toStartWith('> :grant c clock\n');
  });

  test('reports a syntax error without entering anything', () => {
    const s = new PlaygroundSession(environment().env);
    expect(s.apply('on f\n  say 1 +\nend f\n').kind).toBe('syntax');
    expect(s.transcript).toEqual([]);
  });
});

describe('Library tabs', () => {
  test('add on the first save, and replace after', () => {
    const s = new PlaygroundSession(environment().env);
    const lib = {
      name: 'util',
      source: 'function twice n\n  return n * 2\nend twice\n',
    };
    expect(s.saveLibrary(lib)).toEqual([]);
    s.input('use twice from util');
    expect(s.input('twice(3)')).toEqual(['6']);
    expect(s.saveLibrary(lib)).toEqual([]);
    s.saveLibrary({ ...lib, source: lib.source.replace('* 2', '* 3') });
    expect(s.input('twice(3)')).toEqual(['9']);
    expect(s.transcriptText).toContain(
      '> :library add util\n| function twice n\n',
    );
    expect(s.transcriptText).toContain('> :library replace util\n');
  });
});

describe('Debugging', () => {
  test('pauses at a Script tab breakpoint and maps it back to the tab', () => {
    const { env, clock } = environment();
    const s = new PlaygroundSession(env);
    const script = `-- greeting\n${greet}\n`;
    s.apply(script);
    s.setBreakpoints(
      [{ tab: SESSION_TAB, line: 4 }],
      { error: false, limitFault: false },
      {
        script,
        libraries: [],
      },
    );
    expect(s.input('greet "Ann"')).toEqual([]);
    const view = s.pauseView()!;
    expect(view.tab).toEqual({ name: SESSION_TAB, line: 4 });
    expect(view.frames[0]!.locals).toContain('name = "Ann"');
    clock.ms += 5000;
    expect(s.continueDebug('resume')).toEqual(['hello Ann', 'bye']);
    expect(s.paused).toBe(false);
  });

  test('keeps breakpoints across a Reload', () => {
    const s = new PlaygroundSession(environment().env);
    s.apply(`constant k = 1\n${greet}\n`);
    const script = `constant k = 2\n${greet}\n`;
    s.setBreakpoints(
      [{ tab: SESSION_TAB, line: 3 }],
      { error: false, limitFault: false },
      {
        script,
        libraries: [],
      },
    );
    s.apply(script);
    s.input('greet "Ann"');
    expect(s.pauseView()?.tab).toEqual({ name: SESSION_TAB, line: 3 });
  });
});

describe('A shared Transcript', () => {
  test('replays exactly and goes on live', () => {
    const { env, clock } = environment();
    const first = new PlaygroundSession(env);
    first.apply(`${greet}\n`);
    first.input('greet "Ann"');
    const opened = PlaygroundSession.replay(env, first.transcriptText);
    if (!('session' in opened)) {
      throw new Error('expected a replay');
    }
    clock.now += 1_000_000_000n;
    expect(opened.session.input('greet "Bo"')).toEqual(['hello Bo', 'bye']);
    expect(opened.session.transcriptText).toStartWith(first.transcriptText);
  });

  test('reports the first line that replays differently', () => {
    const { env } = environment();
    const opened = PlaygroundSession.replay(
      env,
      '> 1 + 1\n@ 2026-09-30T10:00:00Z\n3\n',
    );
    expect('difference' in opened && opened.difference).toEqual({
      line: 3,
      expected: '3',
      actual: '2',
    });
  });
});

describe('Fresh execution', () => {
  test('preserves the old session and transcript when source or libraries fail', () => {
    const s = new PlaygroundSession(environment().env);
    s.apply('constant n = 7');
    const before = s.transcriptText;
    expect(
      s.prepareFresh({ script: 'on broken', libraries: [] }).session,
    ).toBeNull();
    expect(
      s.prepareFresh({
        script: '',
        libraries: [{ name: 'bad', source: 'function' }],
      }).session,
    ).toBeNull();
    expect(s.transcriptText).toBe(before);
    expect(s.input('n')).toEqual(['7']);
  });
  test('replaces declarations in a new transcript and evaluates only when asked', () => {
    const s = new PlaygroundSession(environment().env);
    s.apply('constant old = 7');
    const prepared = s.prepareFresh({ script: greet, libraries: [] });
    expect(prepared.session).not.toBeNull();
    expect(prepared.session!.transcriptText).not.toContain('constant old');
    expect(prepared.session!.input('greet "Ann"')).toEqual([
      'hello Ann',
      'bye',
    ]);
  });
});

test('Apply keeps live variables while fresh execution starts from initializers', () => {
  const session = new PlaygroundSession(environment().env);
  const source =
    'script variable count = 0\non bump\n add 1 to count\nend bump';
  session.apply(source);
  session.input('bump');
  session.apply(source.replace('add 1', 'add 2'));
  session.input('bump');
  expect(session.input('count')).toEqual(['3']);
  const fresh = session.prepareFresh({
    script: source,
    libraries: [],
  }).session!;
  expect(fresh.input('count')).toEqual(['0']);
  fresh.input('bump');
  expect(fresh.input('count')).toEqual(['1']);
});

test('labelled Entries run and Apply changes only the selected Selector', () => {
  const s = new PlaygroundSession(environment().env);
  const text =
    'on move piece\n say piece\nend move\non move piece to square\n say piece & square\nend move\n';
  expect(s.apply(text).kind).toBe('applied');
  expect(s.input('move "knight" to "e4"')).toEqual(['knighte4']);
  const applied = s.apply(text.replace('piece & square', 'square & piece'));
  expect(applied.kind).toBe('applied');
  expect(s.input('move "knight"')).toEqual(['knight']);
  expect(s.input('move "knight" to "e4"')).toEqual(['e4knight']);
  expect(s.input('send to me: move "rook" to "a4" and wait')).toEqual([
    '[session/r5] a4rook',
  ]);
});

test('the prompt completes continued labelled Entries in the current session', () => {
  const s = new PlaygroundSession(environment().env);
  s.apply('on move piece to square\n say piece & square\nend move\n');
  expect(s.incomplete('move (')).toBe(true);
  expect(s.incomplete('move (\n "knight"\n) to "e4"')).toBe(false);
  expect(s.input('move (\n "knight"\n) to "e4"')).toEqual(['knighte4']);
});
