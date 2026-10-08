import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import { mismatch } from '../src/capabilities';
import { canonicalJSON, operationData, shapeData } from '../src/manifest';
import {
  compileLibrary,
  defineCapability,
  defineObjectKind,
  HostError,
  list,
  LoadError,
  map,
  newGroup,
  nothing,
  num,
  restore,
  shape,
  text,
  type Call,
  type Value,
} from '../src/index';

const door = defineObjectKind<{ open: boolean }>({
  name: 'shape-door',
  props: {},
});
const room = defineObjectKind<null>({ name: 'shape-room', props: {} });
const codes = (work: () => unknown) => {
  try {
    work();
    return [];
  } catch (error) {
    if (!(error instanceof LoadError)) {
      throw error;
    }
    return error.diagnostics.map(d => d.code);
  }
};

test('object Shapes accept only their named Object Kind, including disposed handles and fresh definitions', () => {
  const g = newGroup({ name: 'g' });
  const a = g.object(door, 'a', { open: false });
  const b = g.object(room, 'b', null);
  const s = shape.object(door);
  expect(mismatch(a.value, s)).toBeNull();
  expect(mismatch(b.value, s)).toMatchObject({
    expected: 'shape-door',
    got: 'object',
    path: [],
    value: b.value,
  });
  expect(mismatch(text('a'), s)).toMatchObject({
    expected: 'shape-door',
    got: 'text',
  });
  expect(mismatch(nothing, s)).toMatchObject({ got: 'nothing' });
  g.dispose(a);
  g.pump(0n);
  expect(mismatch(a.value, s)).toBeNull();
  const sameName = defineObjectKind<null>({ name: door.name, props: {} });
  expect(mismatch(g.object(sameName, 'c', null).value, s)).toBeNull();
  expect(mismatch(nothing, shape.optional(s))).toBeNull();
  expect(mismatch(b.value, shape.oneOf(s, shape.object(room)))).toBeNull();
  expect(
    mismatch(
      map([['doors', list(a.value, b.value)]]),
      shape.map({
        doors: shape.listOf(s),
      }),
    ),
  ).toMatchObject({
    expected: 'shape-door',
    got: 'object',
    path: ['doors', 2],
  });
});

test('literal object arguments are refused at load and Library compilation, while dynamic values load', () => {
  const s = shape.object(door);
  const api = defineCapability('api', {
    use: {
      mode: 'fire-and-forget',
      args: [s],
      cost: { fuel: 0 },
      fire: () => {},
    },
  });
  const grants = { api: api.grant('all', undefined) };
  for (const literal of [
    '1',
    '"door"',
    'true',
    'nothing',
    '1 kg',
    '[]',
    '{}',
  ]) {
    expect(
      codes(() =>
        newGroup({ name: 'g' }).load({
          name: 's',
          source: `on go\n  tell api to use ${literal}\nend`,
          grants,
        }),
      ),
    ).toEqual(['wrong argument']);
  }
  const source = 'function useDoor x\n  tell api to use x\nend';
  const declarations = {
    api: { use: { mode: 'fire-and-forget' as const, args: [s] } },
  };
  expect(
    codes(() =>
      compileLibrary(
        { name: 'helper', version: '1', source },
        [],
        declarations,
      ),
    ),
  ).toEqual([]);
  expect(
    codes(() =>
      compileLibrary(
        {
          name: 'bad-helper',
          version: '1',
          source: source.replace('use x', 'use 1'),
        },
        [],
        declarations,
      ),
    ),
  ).toEqual(['wrong argument']);
  const g = newGroup({ name: 'g' });
  const a = g.object(door, 'a', { open: false });
  g.load({
    name: 's',
    source: 'on go x\n  tell api to use x\n  tell api to use named\nend',
    grants,
    objects: { named: a },
  }).deliver({ name: 'go', args: [a.value] });
  expect(
    operationalReports(g.pump(0n).reports).find(r => r.kind === 'run end')!
      .outcome,
  ).toBe('completed');
});

test.each(['immediate', 'suspending', 'fire-and-forget'] as const)(
  '%s arguments reject another Object Kind before charging or reaching the Host',
  mode => {
    let reached = false;
    const doWork = () => {
      reached = true;
      return nothing;
    };
    const api = defineCapability('api', {
      use: {
        mode,
        args: [shape.map({ doors: shape.listOf(shape.object(door)) })],
        cost: { fuel: Number.MAX_SAFE_INTEGER },
        do: doWork,
        start: doWork,
        fire: doWork,
      },
    });
    const g = newGroup({ name: 'g' });
    const b = g.object(room, 'b', null);
    const statement =
      mode === 'fire-and-forget'
        ? 'tell api to use x'
        : `ask api to use x${mode === 'suspending' ? ' and wait' : ''}`;
    g.load({
      name: 's',
      source: `on go x\n  ${statement}\nend`,
      grants: { api: api.grant('all', undefined) },
    }).deliver({ name: 'go', args: [map([['doors', list(b.value)]])] });
    const report = operationalReports(g.pump(0n).reports).find(
      r => r.kind === 'run end',
    )!;
    expect(reached).toBe(false);
    expect(report.error?.code).toBe('wrong kind');
    expect(report.error?.data.get('expected').asText()).toBe('shape-door');
    expect(report.error?.data.get('got').asText()).toBe('object');
    expect(report.error?.data.get('argument').toString()).toBe('1');
    expect(report.error?.data.get('path').toString()).toBe('["doors", 1]');
  },
);

test.each(['immediate', 'suspending'] as const)(
  '%s results accept the declared Object Kind and report bad Host results',
  mode => {
    const g = newGroup({ name: 'g' });
    const a = g.object(door, 'a', { open: false });
    const b = g.object(room, 'b', null);
    const pending: Call<void>[] = [];
    const api = defineCapability('api', {
      read: {
        mode,
        args: [shape.value],
        result: shape.object(door),
        cost: { fuel: 0 },
        do: (_call: Call<void>, value: Value) => value,
        start: (call: Call<void>) => {
          pending.push(call);
        },
      },
    });
    const script = g.load({
      name: 's',
      source: `on go x\n  ask api to read x${mode === 'suspending' ? ' and wait' : ''}\n  return it\nend`,
      grants: { api: api.grant('all', undefined) },
    });
    for (const value of [a.value, b.value, num(1)]) {
      script.deliver({ name: 'go', args: [value] });
      let pumped = g.pump(0n);
      if (mode === 'suspending') {
        pending.at(-1)!.answer(value);
        pumped = g.pump(0n);
      }
      const report = operationalReports(pumped.reports).find(
        r => r.kind === 'run end',
      )!;
      if (value === a.value) {
        expect(report.result?.equals(a.value)).toBe(true);
      } else {
        expect(report.error?.code).toBe('host error');
        expect(
          operationalReports(pumped.reports).find(
            r => r.kind === 'call failed',
          )!.detail,
        ).toContain(`expected shape-door, got ${value.kind}`);
      }
    }
  },
);

test('object property Shapes check writes before Set and report invalid Get results', () => {
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const a = g.object(door, 'a', { open: false });
  const b = g.object(room, 'b', null);
  let stored = a.value;
  let sets = 0;
  const holder = defineObjectKind<null>({
    name: 'shape-holder',
    props: {
      door: {
        shape: shape.object(door),
        get: () => stored,
        set: (_o, value) => {
          stored = value;
          sets++;
        },
      },
    },
  });
  const h = g.object(holder, 'h', null);
  const script = g.load({
    name: 's',
    objects: { holder: h },
    source:
      'on write x\n  set the door of holder to x\nend\non read\n  return the door of holder\nend',
  });
  script.deliver({ name: 'write', args: [a.value] });
  expect(
    operationalReports(g.pump(0n).reports).find(r => r.kind === 'run end')!
      .outcome,
  ).toBe('completed');
  expect(sets).toBe(1);
  script.deliver({ name: 'write', args: [b.value] });
  const badWrite = operationalReports(g.pump(0n).reports).find(
    r => r.kind === 'run end',
  )!;
  expect(badWrite.error?.code).toBe('wrong kind');
  expect(badWrite.error?.data.get('expected').asText()).toBe('shape-door');
  expect(badWrite.error?.data.get('got').asText()).toBe('object');
  expect(sets).toBe(1);
  script.deliver({ name: 'read' });
  expect(
    operationalReports(g.pump(0n).reports)
      .find(r => r.kind === 'run end')!
      .result?.equals(a.value),
  ).toBe(true);
  stored = b.value;
  script.deliver({ name: 'read' });
  const pumped = g.pump(0n);
  expect(
    operationalReports(pumped.reports).find(r => r.kind === 'run end')!.error
      ?.code,
  ).toBe('host error');
  expect(lines).toContain(
    'prop s/r4 object=<object shape-holder "h"> name=door op=get error={}',
  );
});

test('object Shapes use the Host Manifest data model in nested declarations and fingerprints', () => {
  const s = shape.object(door);
  expect(shapeData(s)).toEqual({ object: 'shape-door' });
  const api = defineCapability('api', {
    read: {
      mode: 'immediate',
      args: [shape.listOf(s)],
      result: shape.optional(s),
      cost: { fuel: 0 },
      errors: [{ code: 'gone', fields: { door: s } }],
      do: () => nothing,
    },
  });
  expect(
    canonicalJSON(operationData('read', api.operations.get('read')!)),
  ).toContain(
    '"args":[{"list":{"object":"shape-door"}}],"result":{"optional":{"object":"shape-door"}}',
  );
  expect(
    canonicalJSON(operationData('read', api.operations.get('read')!)),
  ).toContain('"shape":{"object":"shape-door"}');
  const fingerprint = (s: ReturnType<typeof shape.object>) => {
    const g = newGroup({ name: 'g' });
    const cap = defineCapability('api', {
      read: { ...api.operations.get('read')!, args: [s] },
    });
    g.load({
      name: 's',
      source: 'on go\nend',
      grants: { api: cap.grant('all', undefined) },
    });
    return g.fingerprint();
  };
  expect(fingerprint(shape.object(door))).toEqual(
    fingerprint(shape.object(door)),
  );
  expect(fingerprint(shape.object(door))).not.toEqual(
    fingerprint(shape.object(room)),
  );
});

test('saved object declarations survive unbound restore and distinguish argument and result kinds', () => {
  const g = newGroup({ name: 'g' });
  const a = g.object(door, 'a', { open: false });
  const api = defineCapability('api', {
    read: {
      mode: 'suspending',
      args: [shape.object(door)],
      result: shape.object(door),
      cost: { fuel: 0 },
      start: () => {},
    },
  });
  g.load({
    name: 's',
    source: 'on go x\n  ask api to read x and wait\n  return it\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go', args: [a.value] });
  g.pump(0n);
  const saved = g.save();
  const options = {
    name: 'copy',
    libraries: [],
    resolve: () => a,
    onMismatch: 'reject' as const,
  };
  const { group: copy, result } = restore(saved, {
    ...options,
    grants: () => api.grant('all', undefined),
  });
  expect(copy.fingerprint()).toEqual(g.fingerprint());
  expect(result.pending[0]!.args[0]!.asObject()!.kind.name).toBe(door.name);
  const answer = copy.settle('s/r1.c1', { adopt: true })!;
  answer.answer(result.pending[0]!.args[0]!);
  expect(
    operationalReports(copy.pump(0n).reports)
      .find(r => r.kind === 'run end')!
      .result?.asObject()!.kind.name,
  ).toBe(door.name);
  const lines: string[] = [];
  const unbound = restore(saved, {
    ...options,
    grants: () => undefined,
    trace: line => lines.push(line),
  });
  expect(
    lines.some(
      line => line.startsWith('> restore ') && line.includes('unbound=[s.api]'),
    ),
  ).toBe(true);
  expect(unbound.group.fingerprint()).toEqual(g.fingerprint());
  for (const changed of [
    { args: [shape.object(room)] },
    { result: shape.object(room) },
  ]) {
    const different = defineCapability('api', {
      read: { ...api.operations.get('read')!, ...changed },
    });
    expect(() =>
      restore(saved, {
        ...options,
        grants: () => different.grant('all', undefined),
      }),
    ).toThrow(HostError);
    expect(() =>
      restore(saved, {
        ...options,
        grants: () => different.grant('all', undefined),
      }),
    ).toThrow('save mismatch');
  }
});
