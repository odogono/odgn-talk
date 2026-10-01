import { describe, expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  LoadError,
  newGroup,
  parseInstant,
  ScriptError,
  shape,
  text,
  type Call,
  type Library,
} from '../src/index';

const t0 = parseInstant('2026-09-30T09:00:00Z');
const at = (s: number) => t0 + BigInt(s) * 1_000_000_000n;

// Each load diagnostic as `code line:col`.
const diagnostics = (source: string, libraries: Library[] = []) => {
  const group = newGroup({ name: 'g' });
  for (const l of libraries) {
    group.addLibrary(l);
  }
  try {
    group.load({ name: 's', source });
    return [];
  } catch (error) {
    return (error as LoadError).diagnostics.map(
      d => `${d.code} ${d.line}:${d.col}`,
    );
  }
};
const napper = 'on nap\n  wait 1 s\nend nap\n';

describe('Suspension Points at load', () => {
  test('a Command Call to a Handler that may suspend needs `and wait`', () => {
    expect(diagnostics(`${napper}on go\n  nap\nend go`)).toEqual([
      'missing and wait 5:3',
    ]);
    expect(diagnostics(`${napper}on go\n  nap and wait\nend go`)).toEqual([]);
  });

  test('may-suspend follows `and wait` calls to a fixpoint', () => {
    const source = `${napper}on outer\n  inner and wait\nend outer\non inner\n  nap and wait\nend inner\non go\n  outer\nend go`;
    expect(diagnostics(source)).toEqual(['missing and wait 11:3']);
  });

  test('`and wait` on a Handler that can’t suspend, or on `say`, is needless', () => {
    expect(
      diagnostics(
        'on quick\n  return 1\nend quick\non go\n  quick and wait\nend go',
      ),
    ).toEqual(['needless and wait 5:3']);
    // Without a `console` Grant, `say` is an unknown operation too.
    expect(diagnostics('on go\n  say 1 and wait\nend go')).toEqual([
      'unknown operation 2:3',
      'needless and wait 2:3',
    ]);
  });

  test('no Suspension Point in `finally`, a function, or a Handler called function-style', () => {
    expect(
      diagnostics(
        'on go\n  try\n    put 1 into x\n  finally\n    wait 1 s\n  end try\nend go',
      ),
    ).toEqual(["can't suspend here 5:5"]);
    expect(diagnostics('function f\n  wait 1 s\n  return 1\nend f')).toEqual([
      "can't suspend here 2:3",
    ]);
    expect(
      diagnostics(
        `${napper}function g\n  return nap()\nend g\non go\n  put nap() into x\nend go`,
      ),
    ).toEqual(["can't suspend here 5:10", "can't suspend here 8:7"]);
  });

  test('an imported Handler that may suspend needs `and wait` too', () => {
    const lib = compileLibrary({ name: 'naps', version: '1', source: napper });
    expect(
      diagnostics('use nap from naps\non go\n  nap\nend go', [lib]),
    ).toEqual(['missing and wait 3:3']);
    expect(
      diagnostics('use nap from naps\non go\n  nap and wait\nend go', [lib]),
    ).toEqual([]);
  });
});

describe('suspending Operations from the Host', () => {
  test('`start` gets a Call it answers later, and `run` a Promise', async () => {
    const started: Call<unknown>[] = [];
    const feed = defineCapability('feed', {
      get: {
        mode: 'suspending',
        args: [shape.text],
        result: shape.text,
        cost: { fuel: 1 },
        start: call => {
          started.push(call);
        },
      },
      soon: {
        mode: 'suspending',
        result: shape.text,
        cost: { fuel: 1 },
        run: async () => text('promised'),
      },
      never: {
        mode: 'suspending',
        result: shape.text,
        cost: { fuel: 1 },
        run: async () => {
          throw new ScriptError('nope', 'no', undefined);
        },
      },
    });
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const s = group.load({
      name: 's',
      source:
        'script variable out = []\non go\n  ask feed to get "a" and wait\n  put it after out\n  ask feed to soon and wait\n  put it after out\n  try\n    ask feed to never and wait\n  catch e\n    put the code of e after out\n  end try\nend go',
      grants: { feed: feed.grant('all', undefined) },
    });
    s.deliver({ name: 'go' });
    group.pump(at(0));
    expect(group.inspect().scripts[0]!.runs).toEqual([
      { id: 's/r1', status: 'suspended', handler: 'go' },
    ]);
    started[0]!.answer(text('given'));
    group.pump(at(1));
    await Promise.resolve();
    group.pump(at(2));
    await Promise.resolve();
    group.pump(at(3));
    group.inspect();
    expect(lines).toContain('> answer s/r1.c1 value="given"');
    expect(lines).toContain('> answer s/r1.c2 value="promised"');
    expect(lines).toContain(
      '> fail s/r1.c3 error={code: "nope", message: "no"}',
    );
    expect(lines.at(-1)).toBe('vars s out=["given", "promised", "nope"]');
  });
});
