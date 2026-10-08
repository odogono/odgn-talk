import { describe, expect, test } from 'bun:test';
import {
  decodeValue,
  defineObjectKind,
  encodeValue,
  HostError,
  LoadError,
  newGroup,
  parseInstant,
  readDisplay,
  ScriptError,
  text,
} from '../src/index';

const room = defineObjectKind<null>({ name: 'room', props: {} });
const now = parseInstant('2026-09-30T09:00:00Z');

test('a getter refusal follows its crossing record', () => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const kind = defineObjectKind({
    name: 'item',
    props: {
      value: {
        get: object => {
          expect(() => group.setParent(object, object)).toThrow(HostError);
          return text('ok');
        },
      },
    },
  });
  const object = group.object(kind, 'a', null);
  const script = group.load({
    name: 's',
    objects: { item: object },
    source: 'on go\nreturn the value of item\nend go',
  });
  script.deliver({ name: 'go' });
  group.pump(now);
  const at = lines.findIndex(line => line.startsWith('prop '));
  expect(lines.slice(at, at + 3)).toEqual([
    'prop s/r1 object=<object item "a"> name=value op=get value="ok"',
    '> set-parent object=<object item "a"> parent=<object item "a">',
    'refused code="parent cycle"',
  ]);
});

describe('Host Objects', () => {
  test('a handle is made once per kind and id, and is equal only to itself', () => {
    const group = newGroup({ name: 'g' });
    const a = group.object(room, 'a', null);
    const b = group.object(room, 'b', null);
    expect(() => group.object(room, 'a', null)).toThrow(HostError);
    expect(a.value.equals(a.value)).toBe(true);
    expect(a.value.equals(b.value)).toBe(false);
    expect(a.value.toString()).toBe('<object room "a">');
    expect(a.value.asObject()).toBe(a);
  });

  test('another Group’s handle is refused', () => {
    const a = newGroup({ name: 'g' }).object(room, 'a', null);
    expect(() => newGroup({ name: 'h' }).setParent(a, undefined)).toThrow(
      HostError,
    );
  });

  test('a parent cycle is refused at the call', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const a = group.object(room, 'a', null);
    const b = group.object(room, 'b', null);
    group.setParent(a, b);
    group.pump(now);
    expect(() => group.setParent(b, a)).toThrow(HostError);
    expect(lines.at(-1)).toBe('refused code="parent cycle"');
  });

  test('an object has at most one Owning Script', () => {
    const group = newGroup({ name: 'g' });
    const a = group.object(room, 'a', null);
    group.load({ name: 's', source: 'on go\nend go', owner: a });
    expect(() =>
      group.load({ name: 't', source: 'on go\nend go', owner: a }),
    ).toThrow(HostError);
  });

  test('the Value Encoding and display form name an object by kind and id', () => {
    const group = newGroup({ name: 'g' });
    const a = group.object(room, 'a', null);
    const resolve = (kind: string, id: string) =>
      kind === 'room' && id === 'a' ? a : undefined;
    expect(encodeValue(a.value)).toBe('{"$object":["room","a"]}');
    expect(decodeValue('{"$object":["room","a"]}', resolve).asObject()).toBe(a);
    expect(readDisplay('<object room "a">', resolve).asObject()).toBe(a);
    expect(() => readDisplay('<object room "z">', resolve)).toThrow(HostError);
  });

  test('a Request to an object settles with the Run that handles it, or fails unhandled', async () => {
    const group = newGroup({ name: 'g' });
    const top = group.object(room, 'top', null);
    const leaf = group.object(room, 'leaf', null);
    const lone = group.object(room, 'lone', null);
    group.load({
      name: 's',
      source: 'on query x\n  return x & "!"\nend query',
      owner: top,
    });
    group.setParent(leaf, top);
    const ok = group.request(leaf, { name: 'query', args: [text('hi')] });
    const lost = group.request(lone, { name: 'query', args: [text('no')] });
    group.pump(now);
    expect((await ok.result).toString()).toBe('"hi!"');
    const error = await lost.result.catch((error_: unknown) => error_);
    expect((error as ScriptError).code).toBe('send failed');
  });
});

describe('Object property Load checks', () => {
  test('read-only literal writes reject Load, Reload and cached source declarations', () => {
    const readonly = defineObjectKind({
      name: 'checked-light',
      props: { label: { get: () => text('on') } },
    });
    const writable = defineObjectKind({
      name: 'checked-light',
      props: { label: { get: () => text('on'), set: () => {} } },
    });
    for (const target of [
      'the label of bulb',
      'the "label" of bulb',
      'the ("label") of bulb',
      'the (("label")) of bulb',
      "bulb's label",
    ]) {
      const source = `on go\n set ${target} to "off"\nend go`;
      for (const kind of [writable, readonly, writable]) {
        const g = newGroup({ name: 'g' });
        const bulb = g.object(kind, 'bulb', null);
        if (kind === readonly) {
          expect(() =>
            g.load({ name: 's', source, objects: { bulb } }),
          ).toThrow(LoadError);
        } else {
          expect(() =>
            g.load({ name: 's', source, objects: { bulb } }),
          ).not.toThrow();
        }
      }
    }
    const g = newGroup({ name: 'g' });
    const bulb = g.object(readonly, 'bulb', null);
    const s = g.load({
      name: 's',
      source: 'on go\n return 1\nend go',
      objects: { bulb },
    });
    expect(() =>
      s.reload(
        'on go\n set the label of bulb to "off"\nend go',
        'carry variables',
      ),
    ).toThrow(LoadError);
    expect(() =>
      s.extend('on write\n set the label of bulb to "off"\nend write'),
    ).toThrow(LoadError);
    expect(() =>
      g.load({
        name: 'missing',
        source: 'on go\n set the absent of bulb to 1\nend go',
        objects: { bulb },
      }),
    ).toThrow(LoadError);
    const owned = g.object(readonly, 'owned', null);
    expect(() =>
      g.load({
        name: 'owned',
        source: 'on go\n set the label of me to "off"\nend go',
        owner: owned,
      }),
    ).toThrow(LoadError);
  });
});

describe('Object Guard keys', () => {
  test('dynamic keys skip Objects without calling Host and retain map lookup', () => {
    let calls = 0;
    const kind = defineObjectKind({
      name: 'guard-light',
      props: {
        label: {
          get: () => {
            calls++;
            return text('on');
          },
        },
      },
    });
    for (const expression of [
      'the label of o',
      'the "label" of o',
      'the "length" of o',
      'the (k) of o',
    ]) {
      const lines: string[] = [];
      const g = newGroup({ name: 'g', trace: line => lines.push(line) });
      const bulb = g.object(kind, 'bulb', null);
      const s = g.load({
        name: 's',
        source: `on go o, k where ${expression} = "on"\n return 1\nend go\non go o, k\n return 2\nend go`,
      });
      s.deliver({
        name: 'go',
        args: [readDisplay('{label: "on", length: "on"}'), text('label')],
      });
      g.pump(now);
      s.deliver({ name: 'go', args: [bulb.value, text('label')] });
      g.pump(now);
      expect(
        lines
          .filter(line => line.startsWith('run '))
          .map(line => line.match(/value=(\d+)/)?.[1]),
      ).toEqual(['1', '2']);
      expect(
        lines.some(
          line =>
            line.startsWith('guard-skip s/r2 ') &&
            line.includes('code="wrong kind"'),
        ),
      ).toBe(true);
      expect(calls).toBe(0);
    }
  });
  test('known Object computed Guard keys require literal id', () => {
    const g = newGroup({ name: 'g' });
    const bulb = g.object(room, 'bulb', null);
    for (const expression of [
      'the (k) of bulb',
      'the ("label") of bulb',
      'the (("label")) of bulb',
      'the label of the target',
      'the (k) of me',
      'the label of (bulb)',
      'the label of (me)',
      'the label of (the target)',
      'the "length" of bulb',
    ]) {
      expect(() =>
        g.load({
          name: 's',
          objects: { bulb },
          source: `on go k where ${expression} = "on"\nend go`,
        }),
      ).toThrow(LoadError);
    }
    expect(() =>
      g.load({
        name: 'id',
        objects: { bulb },
        source: 'on go where the (("id")) of bulb = "bulb"\nend go',
      }),
    ).not.toThrow();
  });
});

test('property Host errors return Host-only detail without a fabricated Trace call', () => {
  const trace: string[] = [];
  const group = newGroup({
    name: 'property-detail',
    trace: l => trace.push(l),
  });
  const kind = defineObjectKind({
    name: 'FailureDetail',
    props: {
      x: {
        get: () => {
          throw new Error('Host secret');
        },
      },
    },
  });
  const object = group.object(kind, 'o', {});
  const script = group.load({
    name: 's',
    objects: { object },
    source:
      'on go\ntry\nreturn the x of object\ncatch e\nreturn e\nend try\nend go',
  });
  script.deliver({ name: 'go' });
  const reports = group.pump(now).reports;
  expect(reports).toContainEqual(
    expect.objectContaining({
      kind: 'call failed',
      call: '',
      operation: { capability: 'FailureDetail', operation: 'x' },
      detail: expect.stringContaining('Host secret'),
    }),
  );
  expect(trace.join('\n')).not.toContain('Host secret');
  expect(trace.some(l => l.startsWith('call-failed'))).toBe(false);
});
