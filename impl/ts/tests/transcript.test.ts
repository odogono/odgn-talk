import { describe, expect, test } from 'bun:test';
import { map, parseInstant, ScriptError, text } from '../src/index';
import {
  parseTranscript,
  replayTranscript,
  SessionHost,
  writeTranscript,
  type TranscriptItem,
} from '../src/session';

const at = (s: string) => parseInstant(`2026-09-30T10:00:${s}Z`);

describe('Session Transcripts', () => {
  test('read each kind of line, folding an Entry’s further lines in', () => {
    expect(
      parseTranscript(
        [
          '# a comment',
          '> on greet name',
          '|   say name',
          '|',
          '| end greet',
          '> greet "Ann"',
          '@ 2026-09-30T10:00:00Z',
          'Ann',
          '< typed',
          '<',
          '~ c1 fail {code: "x"}',
          "'",
          "'> not an Entry",
        ].join('\n'),
      ),
    ).toEqual([
      { k: 'comment', text: '# a comment' },
      { k: 'input', source: 'on greet name\n  say name\n\nend greet' },
      { k: 'input', source: 'greet "Ann"' },
      { k: 'clock', at: at('00') },
      { k: 'output', text: 'Ann' },
      { k: 'read', line: 'typed' },
      { k: 'read', line: '' },
      { k: 'answer', call: 'c1', answer: 'fail {code: "x"}' },
      { k: 'output', text: '' },
      { k: 'output', text: '> not an Entry' },
    ]);
  });

  test('refuse malformed lines', () => {
    expect(() => parseTranscript('| orphan')).toThrow('line 1');
    expect(() => parseTranscript('>')).toThrow('line 1');
    expect(() => parseTranscript('> 1\n')).not.toThrow();
    expect(() => parseTranscript('> 1\n\n')).toThrow('line 2');
    expect(() => parseTranscript('@')).toThrow('line 1');
  });

  test("write output lines that look like marks after `'`", () => {
    const text = [
      '> say "x"',
      '| more',
      '|',
      '@ 2026-09-30T10:00:00Z',
      "'",
      "'> b",
      "''quoted",
      "'#hash",
      'plain',
      '',
    ].join('\n');
    expect(writeTranscript(parseTranscript(text))).toBe(text);
  });

  test('replay with each `@` as its Pump’s reading, and others as deadline Pumps', () => {
    const recorded = [
      '> on nap',
      '|   wait 2 s',
      '|   say "rested"',
      '| end nap',
      '> nap and wait',
      '@ 2026-09-30T10:00:00Z',
      '@ 2026-09-30T10:00:02Z',
      'rested',
      '',
    ].join('\n');
    const trace: string[] = [];
    const { items } = replayTranscript(parseTranscript(recorded), {
      trace: line => trace.push(line),
    });
    expect(writeTranscript(items)).toBe(recorded);
    expect(trace.filter(l => l.startsWith('> pump'))).toEqual([
      '> pump clock=2026-09-30T10:00:00Z',
      '> pump clock=2026-09-30T10:00:02Z',
    ]);
  });

  test('replay answers `read` with each `<` line', () => {
    const recorded = [
      '> on echo',
      '|   ask console to read and wait',
      '|   say "got " & it',
      '| end echo',
      '> echo and wait',
      '@ 2026-09-30T10:00:00Z',
      '< hello',
      '@ 2026-09-30T10:00:01Z',
      'got hello',
      '',
    ].join('\n');
    const { items } = replayTranscript(parseTranscript(recorded));
    expect(writeTranscript(items)).toBe(recorded);
  });

  test('replay puts the lines it printed in place of the recorded ones', () => {
    const { items } = replayTranscript(
      parseTranscript('> 1 + 1\n@ 2026-09-30T10:00:00Z\n3\n# kept\n'),
    );
    expect(writeTranscript(items)).toBe(
      '> 1 + 1\n@ 2026-09-30T10:00:00Z\n2\n# kept\n',
    );
  });

  test('replay needs a reading for every Pump', () => {
    expect(() => replayTranscript(parseTranscript('> 1 + 1\n'))).toThrow(
      'no `@` reading',
    );
  });
});

describe('Recording', () => {
  test('records a live session in a form that replays the same', () => {
    let now = parseInstant('2026-09-30T10:00:00Z');
    const items: TranscriptItem[] = [];
    const host = new SessionHost({
      now: () => now,
      record: item => items.push(item),
      readFile: () => 'constant k = 7',
    });
    host.input(':mock db.get immediate');
    host.input(':stub db.get 1');
    host.input(':library add lib lib.talk');
    host.input('on nap\n  wait 2 s\n  say "rested"\nend nap');
    host.input('nap and wait');
    expect(host.waiting.k).toBe('deadline');
    now += 2_000_000_000n;
    host.tick();
    host.input(
      'on echo\n  ask console to read and wait\n  say "got " & it\nend echo',
    );
    host.input('echo and wait');
    now += 1_000_000_000n;
    host.read('');
    host.input(':clock virtual');
    host.input('say "> virtual"');
    const text = writeTranscript(items);
    expect(text).toBe(
      [
        '> :mock db.get immediate',
        '> :stub db.get 1',
        '> :library add lib',
        '| constant k = 7',
        '> on nap',
        '|   wait 2 s',
        '|   say "rested"',
        '| end nap',
        '> nap and wait',
        '@ 2026-09-30T10:00:00Z',
        '@ 2026-09-30T10:00:02Z',
        'rested',
        '> on echo',
        '|   ask console to read and wait',
        '|   say "got " & it',
        '| end echo',
        '> echo and wait',
        '@ 2026-09-30T10:00:02Z',
        '<',
        '@ 2026-09-30T10:00:03Z',
        'got ',
        '> :clock virtual 2026-09-30T10:00:03Z',
        '> say "> virtual"',
        "'> virtual",
        '',
      ].join('\n'),
    );
    const replayed = replayTranscript(parseTranscript(text));
    expect(writeTranscript(replayed.items)).toBe(text);
  });
});

describe('Built-in Capabilities', () => {
  // A Host whose `calendar` knows one zone, and whose `locale` uppercases.
  const builtIns = {
    calendar: {
      zone: (call: { binding: string }, zone?: string) => {
        if ((zone ?? call.binding) !== 'UTC') {
          throw new ScriptError(
            'unknown zone',
            'no such zone',
            map([['zone', text(zone!)]]),
          );
        }
        return text('UTC');
      },
    },
    locale: {
      upper: (_: unknown, s: { asText(): string }) =>
        text(s.asText().toUpperCase()),
    },
  } as unknown as ConstructorParameters<typeof SessionHost>[0]['builtIns'];

  test('record each answer as a `~` line, which a replay answers from', () => {
    const items: TranscriptItem[] = [];
    const host = new SessionHost({
      now: () => parseInstant('2026-09-30T10:00:00Z'),
      record: item => items.push(item),
      builtIns,
    });
    expect(host.input(':grant cal calendar UTC')).toEqual([]);
    expect(host.input(':grant loc locale')).toEqual([]);
    host.input('function zone z\n  ask cal to zone z\n  return it\nend zone');
    expect(host.input('zone(nothing)')).toEqual(['"UTC"']);
    expect(host.input('zone("Mars/Base")')).toEqual([
      '! error {code: "unknown zone", zone: "Mars/Base", capability: "cal", operation: "zone"} at session+1:2:3',
    ]);
    const recorded = writeTranscript(items);
    expect(recorded).toContain('~ session/r1.c1 "UTC"\n');
    expect(recorded).toContain(
      '~ session/r2.c1 fail {code: "unknown zone", message: "no such zone", zone: "Mars/Base"}\n',
    );
    // The replay has no Host of its own: every answer comes from the lines.
    const trace: string[] = [];
    const replayed = replayTranscript(parseTranscript(recorded), {
      trace: line => trace.push(line),
    });
    expect(writeTranscript(replayed.items)).toBe(recorded);
  });

  test('a binding goes only with calendar and locale, and only built-ins can be granted', () => {
    const host = new SessionHost({ now: () => 0n });
    expect(host.input(':grant cal calendar')).toEqual(['! bad arguments']);
    expect(host.input(':grant c clock UTC')).toEqual(['! bad arguments']);
    expect(host.input(':grant c clock')).toEqual([]);
    const offered = new SessionHost({ now: () => 0n, builtIns });
    expect(offered.input(':grant cal calendar Europe/London')).toEqual([]);
    expect(offered.input(':mock locale.upper immediate')).toEqual([
      '! bad arguments',
    ]);
  });
});

describe('Going on live after a replay', () => {
  test('takes the live Clock and records later items', () => {
    const recorded = parseTranscript(
      ['> 1 + 1', '@ 2026-09-30T10:00:00Z', '2', ''].join('\n'),
    );
    const later: TranscriptItem[] = [];
    const { host, items } = replayTranscript(recorded, {
      live: { now: () => at('05'), record: item => later.push(item) },
    });
    expect(writeTranscript(items)).toBe(writeTranscript(recorded));
    expect(host.input('2 + 2')).toEqual(['4']);
    expect(later).toEqual([
      { k: 'input', source: '2 + 2' },
      { k: 'clock', at: at('05') },
      { k: 'output', text: '4' },
    ]);
  });
});
