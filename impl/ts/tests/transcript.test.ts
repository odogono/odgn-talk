import { describe, expect, test } from 'bun:test';
import { parseInstant } from '../src/index';
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
