import { describe, expect, test } from 'bun:test';
import { parseInstant } from '../src/index';
import {
  parseTranscript,
  replayTranscript,
  SessionHost,
  writeTranscript,
  type TranscriptItem,
} from '../src/session';

const start = parseInstant('2026-10-07T10:00:00Z');
const session = (files: Record<string, string> = {}) => {
  const items: TranscriptItem[] = [];
  const written = new Map<string, string>();
  const host = new SessionHost({
    now: () => start,
    record: item => items.push(item),
    readStoreFile: path => {
      if (!(path in files)) {
        throw new Error(`no file ${path}`);
      }
      return files[path]!;
    },
    writeStoreFile: (path, text) => written.set(path, text),
  });
  return { host, items, written };
};

describe('The Session Store', () => {
  test('is built in, named by its Grant binding, and costs 2 or 4 Fuel', () => {
    const trace: string[] = [];
    const host = new SessionHost({
      now: () => start,
      trace: line => trace.push(line),
    });
    expect(host.input(':grant scores store')).toEqual([]);
    expect(host.input(':grant same store default')).toEqual([]);
    expect(host.input(':grant other store elsewhere')).toEqual([]);
    expect(host.input('ask scores to increment "plays", 3')).toEqual([]);
    host.input(
      'on peek\n  ask same to get "plays"\n  say it\n  ask other to keys\n  say it\nend peek',
    );
    expect(host.input('peek')).toEqual(['3', '[]']);
    expect(host.input(':store')).toEqual(['"plays" = 3']);
    expect(host.input(':store elsewhere')).toEqual([]);
    expect(host.sessionGrants.scores!.binding).toBe('default');
    expect(host.sessionGrants.other!.binding).toBe('elsewhere');
    // `increment` is 4 Fuel and `get` 2, with no declared allocation.
    expect(
      host.sessionGrants.scores!.capability.operations.get('increment')!.cost,
    ).toEqual({ fuel: 4 });
    expect(
      host.sessionGrants.scores!.capability.operations.get('keys')!.cost,
    ).toEqual({ fuel: 2 });
    expect(trace.some(l => l.includes('phase=commit status=ok'))).toBe(true);
  });

  test('takes no mock, and no binding for a mock', () => {
    const { host } = session();
    expect(host.input(':mock store.get immediate')).toEqual([
      '! bad arguments',
    ]);
    expect(host.input(':mock db.get immediate')).toEqual([]);
    expect(host.input(':grant d db name')).toEqual(['! bad arguments']);
  });

  test('outlives a reload, and is outside :save and :restore', () => {
    const { host } = session();
    host.input(':grant s store');
    host.input('script variable n = 0');
    host.input(':save');
    host.input('ask s to set "k", 1');
    host.input('on bump\n  ask s to increment "k"\nend bump');
    host.input('bump');
    expect(host.input(':store')).toEqual(['"k" = 2']);
    expect(host.input(':restore')).toEqual(['restored default']);
    expect(host.input(':store')).toEqual(['"k" = 2']);
  });

  test('rolls back with a Limit Fault, and commits with an error', () => {
    const { host } = session();
    host.input(':grant s store');
    host.input(':limits fuelPerRun 300');
    host.input(
      'on spin\n  ask s to set "a", 1\n  repeat while true\n  end repeat\nend spin',
    );
    host.input('on fail\n  ask s to set "a", 1\n  throw "stop"\nend fail');
    expect(host.input('spin')[0]).toContain('! limit');
    expect(host.input(':store')).toEqual([]);
    expect(host.input('fail')[0]).toContain('! error');
    expect(host.input(':store')).toEqual(['"a" = 1']);
  });

  test(':store load, save and clear, with refusals that leave it unchanged', () => {
    const { host, written } = session({
      'scores.json': '{"b": {"$quantity": ["2.5", "km"]}, "a": [1, "two"]}\n',
      'bad.json': '[1]',
      'empty-key.json': '{"": 1}',
      'object.json': '{"k": {"$object": ["room", "r1"]}}',
      'nothing.json': '{"k": null}',
    });
    expect(host.input(':store load scores.json')).toEqual(['loaded 2 keys']);
    expect(host.input(':store')).toEqual(['"a" = [1, "two"]', '"b" = 2.5 km']);
    for (const file of [
      'bad.json',
      'empty-key.json',
      'object.json',
      'missing.json',
    ]) {
      expect(host.input(`:store load ${file}`)).toEqual(['! bad arguments']);
    }
    expect(host.input(':store')).toEqual(['"a" = [1, "two"]', '"b" = 2.5 km']);
    expect(host.input(':store save out.json')).toEqual(['wrote out.json']);
    expect(written.get('out.json')).toBe(
      '{"a":[1,"two"],"b":{"$quantity":["2.5","km"]}}',
    );
    expect(host.input(':store load nothing.json other')).toEqual([
      'loaded 0 keys',
    ]);
    expect(host.input(':store clear')).toEqual(['cleared default']);
    expect(host.input(':store')).toEqual([]);
    expect(host.input(':store save')).toEqual(['! bad arguments']);
    expect(host.input(':store a b')).toEqual(['! bad arguments']);
    expect(host.input(':store clear a b')).toEqual(['! bad arguments']);
  });

  test(':store load refuses contents past a quota', () => {
    const big = `{${Array.from({ length: 1001 }, (_, i) => `"k${i}":1`).join(',')}}`;
    const { host } = session({ 'big.json': big });
    expect(host.input(':store load big.json')).toEqual(['! bad arguments']);
  });

  test('a Transcript records loaded contents inline, and replays without the file', () => {
    const { host, items } = session({
      'scores.json': '{\n  "best": 9\n}\n',
    });
    host.input(':grant s store');
    host.input(':store load scores.json');
    host.input('on best\n  ask s to get "best"\n  say it\nend best');
    host.input('best');
    const recorded = writeTranscript(items);
    expect(recorded).toBe(
      [
        '> :grant s store',
        '> :store load',
        '| {',
        '|   "best": 9',
        '| }',
        'loaded 1 keys',
        '% {"objects":{},"type":"setup"}',
        '> on best',
        '|   ask s to get "best"',
        '|   say it',
        '| end best',
        '> best',
        '@ 2026-10-07T10:00:00Z',
        '9',
        '',
      ].join('\n'),
    );
    expect(
      writeTranscript(replayTranscript(parseTranscript(recorded)).items),
    ).toBe(recorded);
  });
});
