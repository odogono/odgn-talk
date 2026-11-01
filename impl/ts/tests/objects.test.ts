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
  restore,
  ScriptError,
  shape,
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

  test('queued parent changes recheck cycles at drain and continue with later inputs', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const a = group.object(room, 'a', null);
    const b = group.object(room, 'b', null);
    const c = group.object(room, 'c', null);
    group.setParent(a, b);
    group.setParent(b, a);
    group.setParent(c, b);
    expect(lines).toEqual([]);
    expect(group.pump(now).reports).toEqual([
      {
        kind: 'host error',
        code: 'parent cycle',
        detail: expect.any(String),
      },
    ]);
    expect(lines.filter(line => line.startsWith('refused'))).toEqual([
      'refused code="parent cycle"',
    ]);
    // The refused change leaves b a root; both accepted changes remain applied.
    expect(() => group.setParent(b, a)).toThrow(
      expect.objectContaining({ code: 'parent cycle' }),
    );
    expect(() => group.setParent(b, c)).toThrow(
      expect.objectContaining({ code: 'parent cycle' }),
    );
    group.setParent(b, undefined);
    expect(group.pump(now).reports).toEqual([]);
  });

  test('a queued parent change refuses a child disposed by an earlier input', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const a = group.object(room, 'a', null);
    const b = group.object(room, 'b', null);
    group.dispose(a);
    group.setParent(a, b);
    expect(group.pump(now).reports).toEqual([
      {
        kind: 'host error',
        code: 'invalid value',
        detail: expect.any(String),
      },
    ]);
    expect(lines.filter(line => line.startsWith('refused'))).toEqual([
      'refused code="invalid value"',
    ]);
    // A disposed child still has identity, but its refused parent stays unset.
    group.setParent(b, a);
    expect(group.pump(now).reports).toEqual([]);
    expect(() => group.setParent(a, undefined)).toThrow(
      expect.objectContaining({ code: 'invalid value' }),
    );
  });

  test('a saved queued parent change rechecks a child unresolved by Restore', () => {
    const original = newGroup({ name: 'g' });
    const a = original.object(room, 'a', null);
    const b = original.object(room, 'b', null);
    original.setParent(a, b);
    const lines: string[] = [];
    const { group, result } = restore(original.save(), {
      name: 'restored',
      trace: line => lines.push(line),
      libraries: [],
      grants: () => undefined,
      resolve: (_kind, id) => (id === 'b' ? { native: null } : undefined),
      onMismatch: 'reject',
    });
    expect(result.disposed).toEqual([['room', 'a']]);
    expect(group.pump(now).reports).toEqual([
      {
        kind: 'host error',
        code: 'invalid value',
        detail: expect.any(String),
      },
    ]);
    expect(lines.filter(line => line.startsWith('refused'))).toEqual([
      'refused code="invalid value"',
    ]);
    group.setParent(
      group.objectById('room', 'b')!,
      group.objectById('room', 'a'),
    );
    expect(group.pump(now).reports).toEqual([]);
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

const loadDiagnostics = (work: () => unknown) => {
  try {
    work();
    return [];
  } catch (error) {
    if (!(error instanceof LoadError)) {
      throw error;
    }
    return error.diagnostics;
  }
};

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
    for (const target of [
      'the label of me',
      'the "label" of me',
      '((the ("label") of (me)))',
    ]) {
      const load = (kind: typeof readonly) => () => {
        const group = newGroup({ name: 'owned' });
        const owner = group.object(kind, 'owned', null);
        group.load({
          name: 'owned',
          source: `on go\n set ${target} to "off"\nend go`,
          owner,
        });
      };
      expect(loadDiagnostics(load(writable))).toEqual([]);
      expect(loadDiagnostics(load(readonly))).toMatchObject([
        { code: "can't write", unit: 'owned', line: 2, col: 2 },
      ]);
    }
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

for (const control of ['stop', 'cancel']) {
  for (const failure of [
    'getter error',
    'setter error',
    'invalid result',
    'malformed failure',
    'catalogue failure',
  ]) {
    test(`${control} at a property crossing suppresses ${failure}`, () => {
      const trace: string[] = [];
      const group = newGroup({ name: 'g', trace: line => trace.push(line) });
      let calls = 0;
      const invoke = () => {
        calls++;
        if (control === 'stop') {
          script.stop('getter');
        } else {
          script.cancelRun('s/r1');
        }
        switch (failure) {
          case 'invalid result':
            return readDisplay('1');
          case 'malformed failure':
            throw new ScriptError('lamp broken', '', readDisplay('1'));
          case 'catalogue failure':
            throw new ScriptError('object gone', '');
          default:
            throw new Error('Host secret');
        }
      };
      const kind = defineObjectKind({
        name: 'light',
        props: { label: { shape: shape.text, get: invoke, set: invoke } },
      });
      const bulb = group.object(kind, 'bulb', null);
      const statement =
        failure === 'setter error'
          ? 'set the label of bulb to "on"'
          : 'return the label of bulb';
      const script = group.load({
        name: 's',
        objects: { bulb },
        source: `on go
 try
  ${statement}
 catch e
  return "caught"
 end try
end go`,
      });
      script.deliver({ name: 'go' });
      const reports = group.pump(now).reports;
      expect(calls).toBe(1);
      expect(reports.some(report => report.kind === 'call failed')).toBe(false);
      expect(reports).toContainEqual(
        expect.objectContaining(
          control === 'stop'
            ? { kind: 'stop', script: 's', reason: 'getter' }
            : { kind: 'run end', script: 's', outcome: 'cancelled' },
        ),
      );
      const propAt = trace.findIndex(line => line.startsWith('prop s/r1 '));
      const controlAt = trace.findIndex(line =>
        line.startsWith(control === 'stop' ? '> stop ' : '> cancel-run '),
      );
      expect(propAt).toBeGreaterThanOrEqual(0);
      expect(controlAt).toBeGreaterThan(propAt);
      expect(trace[propAt]).toContain('error=');
      expect(trace[propAt]).toContain(
        failure === 'setter error' ? 'op=set' : 'op=get',
      );
      expect(trace.some(line => line.startsWith('raise '))).toBe(false);
      expect(trace.join('\n')).not.toContain('Host secret');
    });
  }
}

test('a property Host error during cancellation cleanup still reports its detail', () => {
  const trace: string[] = [];
  const group = newGroup({ name: 'g', trace: line => trace.push(line) });
  let calls = 0;
  const kind = defineObjectKind({
    name: 'light',
    props: {
      label: {
        get: () => {
          if (++calls === 1) {
            script.cancelRun('s/r1');
          }
          throw new Error('Host secret');
        },
      },
    },
  });
  const bulb = group.object(kind, 'bulb', null);
  const script = group.load({
    name: 's',
    objects: { bulb },
    source: `on go
 try
  put the label of bulb into ignored
 finally
  put the label of bulb into ignored
 end try
end go`,
  });
  script.deliver({ name: 'go' });
  const reports = group.pump(now).reports;
  expect(calls).toBe(2);
  expect(reports.filter(report => report.kind === 'call failed')).toEqual([
    {
      kind: 'call failed',
      script: 's',
      call: '',
      operation: { capability: 'light', operation: 'label' },
      detail: expect.stringContaining('Host secret'),
    },
  ]);
  expect(reports).toContainEqual(
    expect.objectContaining({ kind: 'run end', outcome: 'cancelled' }),
  );
  expect(trace.filter(line => line.startsWith('raise '))).toHaveLength(1);
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

test('optional reads reject live and disposed objects without Host calls, including Guards', () => {
  let calls = 0;
  const kind = defineObjectKind({
    name: 'optional-test',
    props: {
      value: {
        get: () => {
          calls++;
          return text('host');
        },
      },
    },
  });
  for (const disposed of [false, true]) {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const object = group.object(kind, 'o', null);
    const script = group.load({
      name: 's',
      objects: { obj: object },
      source: `script variable results = []
on go where the optional value of obj otherwise false
return 0
end go
on go
put obj into dynamic
put the optional held of {held: obj} into held
put [held = obj] into results
try
put the optional id of obj into x
catch e
put e's expected after results
end try
try
put the optional ("value") of dynamic into x
catch e
put e's expected after results
end try
end go`,
    });
    if (disposed) {
      group.dispose(object);
    }
    script.deliver({ name: 'go' });
    group.pump(now);
    group.inspect();
    expect(lines.at(-1)).toBe('vars s results=[true, "map", "map"]');
    expect(lines.some(line => line.startsWith('prop '))).toBe(false);
    expect(
      lines.some(
        line => line.startsWith('guard-skip ') && line.includes('wrong kind'),
      ),
    ).toBe(true);
  }
  expect(calls).toBe(0);
});

describe('a parent given when an object is made (ADR 0152)', () => {
  test('takes effect inside the Pump that made it, so the same Run reaches its owner', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const zone = group.object(room, 'zone', null);
    const door = defineObjectKind<null>({
      name: 'door',
      props: {
        to: {
          get: () => group.object(room, 'hall', null, { parent: zone }).value,
        },
      },
    });
    group.load({
      name: 'zone',
      owner: zone,
      source:
        'script variable seen = []\non look\nput the id of the target after seen\nend look',
    });
    const walker = group.load({
      name: 'walker',
      objects: { portal: group.object(door, 'p', null) },
      source: 'on go\nsend look to the to of portal\nend go',
    });
    walker.deliver({ name: 'go' });
    expect(group.pump(now).reports).not.toContainEqual(
      expect.objectContaining({ kind: 'unhandled' }),
    );
    const zoneScript = group.inspect().scripts.find(s => s.name === 'zone')!;
    expect(new Map(zoneScript.vars).get('seen')?.toString()).toBe('["hall"]');
    expect(lines).toContain(
      'object object=<object room "hall"> parent=<object room "zone">',
    );
  });

  test('a parentless object writes no record', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    group.object(room, 'a', null);
    expect(lines).toEqual([]);
  });

  test('a disposed or foreign parent is refused, and the id stays free', () => {
    const group = newGroup({ name: 'g' });
    const gone = group.object(room, 'gone', null);
    group.dispose(gone);
    group.pump(now);
    expect(() => group.object(room, 'a', null, { parent: gone })).toThrow(
      expect.objectContaining({ code: 'invalid value' }),
    );
    const foreign = newGroup({ name: 'h' }).object(room, 'x', null);
    expect(() => group.object(room, 'a', null, { parent: foreign })).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
    expect(group.objectById('room', 'a')).toBeUndefined();
    group.object(room, 'a', null);
  });
});
