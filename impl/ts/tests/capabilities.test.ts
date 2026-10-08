import { describe, expect, test } from 'bun:test';
import { mismatch } from '../src/capabilities';
import {
  defineCapability,
  dec,
  HostError,
  LoadError,
  list,
  map,
  newGroup,
  parseInstant,
  quantity,
  ScriptError,
  shape,
  text,
  type Call,
  type Grant,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
// Load one Script with Grants, deliver `go`, and give the Trace.
const run = (source: string, grants: Record<string, Grant<unknown>>) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  group.load({ name: 's', source, grants }).deliver({ name: 'go' });
  group.pump(now);
  group.inspect();
  return lines;
};
const loadCodes = (source: string, grants: Record<string, Grant<unknown>>) => {
  try {
    newGroup({ name: 'g' }).load({ name: 's', source, grants });
    return [];
  } catch (error) {
    return (error as LoadError).diagnostics.map(d => d.code);
  }
};

describe('Shapes', () => {
  test('a value fits, or breaks at its first node depth-first', () => {
    const s = shape.map({
      name: shape.text,
      tags: shape.listOf(shape.text),
      note: { shape: shape.text, optional: true },
    });
    expect(
      mismatch(
        map([
          ['name', text('a')],
          ['tags', list()],
        ]),
        s,
      ),
    ).toBeNull();
    expect(
      mismatch(
        map([
          ['name', text('a')],
          ['tags', list(text('x'), dec('1'))],
        ]),
        s,
      ),
    ).toMatchObject({ expected: 'text', got: 'number', path: ['tags', 2] });
    expect(mismatch(map([['tags', list()]]), s)).toMatchObject({
      expected: 'text',
      got: 'nothing',
      path: ['name'],
    });
    expect(
      mismatch(dec('1'), shape.oneOf(shape.text, shape.bool)),
    ).toMatchObject({
      expected: 'text or boolean',
    });
    expect(
      mismatch(quantity(dec('2'), 'g'), shape.quantityKind('mass')),
    ).toBeNull();
    expect(
      mismatch(quantity(dec('2'), 'g'), shape.quantityOf('kg')),
    ).toMatchObject({
      expected: 'kg',
      got: 'g',
    });
    expect(
      mismatch(quantity(dec('2'), 'm/s'), shape.quantityKind('length')),
    ).not.toBeNull();
  });
});

describe('defining and granting', () => {
  test('refuses an Operation named ask, tell, send, wait or end, and an unknown grant', () => {
    const fire = {
      mode: 'fire-and-forget' as const,
      cost: { fuel: 0 },
      fire: () => {},
    };
    // `end` closes a `tell` block, so no line could call it (ADR 0063).
    for (const name of ['ask', 'tell', 'send', 'wait', 'end']) {
      expect(() => defineCapability('x', { [name]: fire })).toThrow(HostError);
    }
    expect(() =>
      defineCapability('x', { a: fire }).grant(['b'], undefined),
    ).toThrow(HostError);
  });

  test('a Host function gets the call id, Script, binding and Clock', () => {
    const calls: Call<string>[] = [];
    const stamp = defineCapability<string>('stamp', {
      now: {
        mode: 'immediate',
        result: shape.text,
        cost: { fuel: 1 },
        do: call => {
          calls.push(call);
          return text(`${call.binding}@${call.now}`);
        },
      },
    });
    const lines = run(
      'script variable v\non go\n  ask clock to now\n  put it into v\nend go',
      {
        clock: stamp.grant('all', 'eu'),
      },
    );
    expect(calls.map(c => [c.id, c.scriptName, c.binding, c.now])).toEqual([
      ['s/r1.c1', 's', 'eu', now],
    ]);
    expect(lines.at(-1)).toBe(`vars s v="eu@${now}"`);
  });

  test('a Fail raises its code with its message and Data as fields', () => {
    const shop = defineCapability('shop', {
      buy: {
        mode: 'immediate',
        cost: { fuel: 0 },
        do: () => {
          throw new ScriptError(
            'sold out',
            'none left',
            map([['left', dec('0')]]),
          );
        },
      },
    });
    const lines = run(
      'script variable e\non go\n  try\n    ask shop to buy\n  catch err\n    put err into e\n  end try\nend go',
      {
        shop: shop.grant('all', undefined),
      },
    );
    expect(lines.at(-1)).toBe(
      'vars s e={code: "sold out", message: "none left", left: 0, capability: "shop", operation: "buy", at: {unit: "s", handler: "go", line: 4, column: 5}}',
    );
  });
});

describe('load checks', () => {
  const clock = defineCapability('clock', {
    now: {
      mode: 'immediate',
      result: shape.number,
      cost: { fuel: 0 },
      do: () => dec('1'),
    },
    tick: {
      mode: 'fire-and-forget',
      args: [shape.number],
      cost: { fuel: 0 },
      fire: () => {},
    },
    later: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 0 },
      start: () => {},
    },
  });
  const grants = { clock: clock.grant(['now', 'tick', 'later'], undefined) };
  test.each([
    ['ask nobody to now', 'unknown operation'],
    ['ask clock to never', 'unknown operation'],
    ['tell clock to now', 'wrong mode'],
    ['ask clock to tick 1', 'wrong mode'],
    ['ask clock to now and wait', 'wrong mode'],
    ['ask clock to later', 'wrong mode'],
    ['tell clock to tick', 'wrong argument count'],
    ['tell clock to tick "x"', 'wrong argument'],
    ['say 1', 'unknown operation'],
  ])('%s', (line, code) => {
    expect(loadCodes(`on go\n  ${line}\nend go`, grants)).toEqual([code]);
  });
  test('an Operation the Grant leaves out is unknown', () => {
    expect(
      loadCodes('on go\n  ask clock to now\nend go', {
        clock: clock.grant(['tick'], undefined),
      }),
    ).toEqual(['unknown operation']);
  });
});

describe('sending', () => {
  test('a send to a name that is no Script of the Group raises `object gone`', () => {
    const lines = run(
      'script variable e\non go\n  try\n    send ping to nowhere\n  catch err\n    put err into e\n  end try\nend go',
      {},
    );
    expect(lines.at(-1)).toBe(
      'vars s e={code: "object gone", object: "nowhere", at: {unit: "s", handler: "go", line: 4, column: 18}}',
    );
  });

  test('a Script may send to one loaded after it', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    group.load({ name: 'a', source: 'on go\n  send hi with 1 to b\nend go' });
    group.load({
      name: 'b',
      source: 'script variable n\non hi x\n  put x into n\nend hi',
    });
    group.script('a')!.deliver({ name: 'go' });
    group.pump(now);
    group.inspect();
    expect(lines).toContain('send a/r1 to=b message=hi args=[1]');
    expect(lines.at(-1)).toBe('vars b n=1');
  });
});
