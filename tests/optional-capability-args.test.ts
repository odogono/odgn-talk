import { expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  HostError,
  LoadError,
  newGroup,
  num,
  parseInstant,
  restore,
  shape,
  text,
  type Call,
  type Value,
} from '../src/index';

const now = parseInstant('2026-10-02T14:00:00Z');
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
const variable = (
  g: ReturnType<typeof newGroup>,
  script: string,
  name: string,
) => new Map(g.inspect().scripts.find(s => s.name === script)!.vars).get(name)!;

test('immediate calls omit a trailing Optional suffix without padding Host arguments or Trace records', () => {
  const received: Value[][] = [];
  const lines: string[] = [];
  const api = defineCapability('api', {
    count: {
      mode: 'immediate',
      args: [
        shape.number,
        shape.optional(shape.text),
        shape.optional(shape.number),
      ],
      result: shape.number,
      cost: { fuel: 7, alloc: 2 },
      do: (_call, ...args) => {
        received.push(args);
        return num(args.length);
      },
    },
  });
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  g.load({
    name: 's',
    source:
      'script variable counts = []\non go\n  ask api to count 1\n  put it after counts\n  ask api to count 1, "zone"\n  put it after counts\n  ask api to count 1, nothing, 3\n  put it after counts\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go' });
  expect(g.pump(now).reports.find(r => r.kind === 'run end')!.outcome).toBe(
    'completed',
  );
  expect(variable(g, 's', 'counts').toString()).toBe('[1, 2, 3]');
  expect(received.map(args => args.map(v => v.toString()))).toEqual([
    ['1'],
    ['1', '"zone"'],
    ['1', 'nothing', '3'],
  ]);
  expect(lines.filter(line => line.startsWith('call '))).toEqual([
    'call s/r1.c1 op=api.count args=[1] result=1',
    'call s/r1.c2 op=api.count args=[1, "zone"] result=2',
    'call s/r1.c3 op=api.count args=[1, nothing, 3] result=3',
  ]);
});

test('only directly Optional trailing positions can be omitted and supplied literals still fit their Shapes', () => {
  const api = defineCapability('api', {
    middle: {
      mode: 'fire-and-forget',
      args: [
        shape.optional(shape.text),
        shape.number,
        shape.optional(shape.text),
      ],
      cost: { fuel: 0 },
      fire: () => {},
    },
    choice: {
      mode: 'fire-and-forget',
      args: [shape.oneOf(shape.optional(shape.text), shape.number)],
      cost: { fuel: 0 },
      fire: () => {},
    },
    list: {
      mode: 'fire-and-forget',
      args: [shape.listOf(shape.optional(shape.text))],
      cost: { fuel: 0 },
      fire: () => {},
    },
  });
  const g = newGroup({ name: 'g' });
  const grants = { api: api.grant('all', undefined) };
  for (const body of [
    'tell api to middle',
    'tell api to middle nothing',
    'tell api to middle nothing, 1, "x", 2',
    'tell api to choice',
    'tell api to list',
  ]) {
    expect(
      codes(() =>
        g.load({ name: 'bad', source: `on go\n  ${body}\nend`, grants }),
      ),
    ).toEqual(['wrong argument count']);
  }
  expect(
    codes(() =>
      g.load({
        name: 'bad',
        source: 'on go\n  tell api to middle nothing, 1, 2\nend',
        grants,
      }),
    ),
  ).toEqual(['wrong argument']);
  const s = g.load({
    name: 's',
    source: 'on go\n  tell api to middle nothing, 1\nend',
    grants,
  });
  s.deliver({ name: 'go' });
  expect(g.pump(now).reports.find(r => r.kind === 'run end')!.outcome).toBe(
    'completed',
  );
});

test('all-Optional fire-and-forget Operations accept zero arguments and charge the ordinary call cost', () => {
  const received: Value[][] = [];
  const api = defineCapability('api', {
    note: {
      mode: 'fire-and-forget',
      args: [shape.optional(shape.text)],
      cost: { fuel: 9, alloc: 3 },
      fire: (call, ...args) => {
        received.push(args);
        call.charge(2);
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'on go\n  tell api to note\n  tell api to note nothing\n  tell api to note "hello"\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go' });
  const expensive = g.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(expensive.outcome).toBe('completed');
  expect(received.map(args => args.map(v => v.toString()))).toEqual([
    [],
    ['nothing'],
    ['"hello"'],
  ]);
  const cheap = newGroup({ name: 'cheap' });
  cheap
    .load({
      name: 's',
      source:
        'on go\n  tell api to note\n  tell api to note nothing\n  tell api to note "hello"\nend',
      grants: {
        api: defineCapability('api', {
          note: {
            ...api.operations.get('note')!,
            cost: { fuel: 0 },
            fire: () => {},
            mode: 'fire-and-forget',
          },
        }).grant('all', undefined),
      },
    })
    .deliver({ name: 'go' });
  const base = cheap.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(expensive.fuel - base.fuel).toBe(33);
  expect(expensive.alloc - base.alloc).toBe(9);
});

test('say keeps exactly one source argument even when a custom write declaration has Optional arguments', () => {
  const console = defineCapability('console', {
    write: {
      mode: 'fire-and-forget',
      args: [shape.optional(shape.value), shape.optional(shape.text)],
      cost: { fuel: 0 },
      fire: () => {},
    },
  });
  const g = newGroup({ name: 'g' });
  const grants = { console: console.grant('all', undefined) };
  for (const body of ['say', 'say 1, "x"']) {
    expect(
      codes(() =>
        g.load({ name: 's', source: `on go\n  ${body}\nend`, grants }),
      ),
    ).toContain('wrong argument count');
  }
  g.load({ name: 's', source: 'on go\n  say 1\nend', grants }).deliver({
    name: 'go',
  });
  expect(g.pump(now).reports.find(r => r.kind === 'run end')!.outcome).toBe(
    'completed',
  );
});

test('supplied dynamic Optional values are checked before charging or reaching the Host', () => {
  let reached = false;
  const api = defineCapability('api', {
    check: {
      mode: 'fire-and-forget',
      args: [shape.number, shape.optional(shape.text)],
      cost: { fuel: Number.MAX_SAFE_INTEGER },
      fire: () => {
        reached = true;
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go value\n  tell api to check 1, value\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go', args: [num(2)] });
  const report = g.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(reached).toBe(false);
  expect(report.error?.get('code').asText()).toBe('wrong kind');
  expect(report.error?.get('argument').toString()).toBe('2');
  expect(report.error?.get('expected').asText()).toBe('text or nothing');
});

test('an omitted Optional argument still pays declared Fuel before a Host call and rolls back on cutoff', () => {
  let reached = false;
  const api = defineCapability('api', {
    check: {
      mode: 'immediate',
      args: [shape.optional(shape.text)],
      result: shape.number,
      cost: { fuel: 100 },
      do: () => {
        reached = true;
        return num(1);
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable touched = 0\non go\n  add 1 to touched\n  ask api to check\nend',
    limits: { fuelPerRun: 40 },
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go' });
  expect(g.pump(now).reports.find(r => r.kind === 'run end')!.outcome).toBe(
    'limit fault',
  );
  expect(reached).toBe(false);
  expect(variable(g, 's', 'touched').toString()).toBe('0');
});

test('suspending Operations retain supplied argument counts across queued answers and cancellation', () => {
  const received: { args: Value[]; call: Call<void> }[] = [];
  const api = defineCapability('api', {
    read: {
      mode: 'suspending',
      args: [shape.optional(shape.text)],
      result: shape.text,
      cost: { fuel: 2 },
      start: (call, ...args) => {
        received.push({ args, call });
      },
    },
  });
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source:
      'script variable seen = []\non go\n  ask api to read and wait\n  put it after seen\n  ask api to read nothing and wait\n  put it after seen\nend',
    grants: { api: api.grant('all', undefined) },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  expect(received[0]!.args).toEqual([]);
  received[0]!.call.answer(text('first'));
  g.pump(now + 1n);
  expect(received[1]!.args.map(v => v.toString())).toEqual(['nothing']);
  s.cancelRun('s/r1');
  g.pump(now + 2n);
  expect(received[1]!.call.signal.aborted).toBe(true);
  expect(variable(g, 's', 'seen').toString()).toBe('["first"]');
});

test('Join members can call the same Operation with omitted, Nothing and supplied Optional arguments', () => {
  const received: { args: Value[]; call: Call<void> }[] = [];
  const api = defineCapability('api', {
    read: {
      mode: 'suspending',
      args: [shape.optional(shape.text)],
      result: shape.text,
      cost: { fuel: 0 },
      start: (call, ...args) => {
        received.push({ args, call });
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable seen = []\non go\n  wait for all\n    ask api to read and wait\n    ask api to read nothing and wait\n    ask api to read "x" and wait\n  end\n  put it into seen\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go' });
  g.pump(now);
  expect(received.map(r => r.args.map(v => v.toString()))).toEqual([
    [],
    ['nothing'],
    ['"x"'],
  ]);
  received.forEach((r, i) => r.call.answer(text(String(i))));
  expect(
    g.pump(now + 1n).reports.find(r => r.kind === 'run end')!.outcome,
  ).toBe('completed');
  expect(variable(g, 's', 'seen').toString()).toBe('["0", "1", "2"]');
});

test('Promise-based suspending Operations receive only supplied Optional arguments', async () => {
  const received: Value[][] = [];
  const api = defineCapability('api', {
    read: {
      mode: 'suspending',
      args: [shape.optional(shape.text)],
      result: shape.number,
      cost: { fuel: 0 },
      run: async (_call, ...args) => {
        received.push(args);
        return num(args.length);
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\n  ask api to read and wait\n  return it\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go' });
  g.pump(now);
  await Promise.resolve();
  expect(received).toEqual([[]]);
  expect(
    g
      .pump(now + 1n)
      .reports.find(r => r.kind === 'run end')!
      .result?.toString(),
  ).toBe('0');
});

test('Library calls validate omitted Optional arguments on compilation and each import', () => {
  const source = 'function fetch\n  ask api to read\n  return it\nend';
  const declarations = {
    api: {
      read: { mode: 'immediate' as const, args: [shape.optional(shape.text)] },
    },
  };
  const helper = compileLibrary(
    { name: 'helper', version: '1', source },
    [],
    declarations,
  );
  expect(helper.needs).toEqual([{ capability: 'api', operation: 'read' }]);
  expect(
    codes(() =>
      compileLibrary({ name: 'helper', version: '1', source }, [], {
        api: { read: { mode: 'immediate', args: [shape.text] } },
      }),
    ),
  ).toEqual(['wrong argument count']);
  const api = defineCapability('api', {
    read: {
      mode: 'immediate',
      args: [shape.optional(shape.text)],
      result: shape.number,
      cost: { fuel: 0 },
      do: (_call, ...args) => num(args.length),
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(helper);
  const script = 'use fetch from helper\non go\n  return fetch()\nend';
  g.load({
    name: 's',
    source: script,
    grantsAsUsed: true,
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go' });
  expect(
    g
      .pump(now)
      .reports.find(r => r.kind === 'run end')!
      .result?.toString(),
  ).toBe('0');
  const strict = defineCapability('api', {
    read: { ...api.operations.get('read')!, args: [shape.text] },
  });
  expect(
    codes(() =>
      g.load({
        name: 'bad',
        source: script,
        grants: { api: strict.grant('all', undefined) },
      }),
    ),
  ).toEqual(['wrong argument count']);
});

test('Reload, Extend and Library replacement reuse the same Optional arity checks', () => {
  const declarations = {
    api: {
      read: { mode: 'immediate' as const, args: [shape.optional(shape.text)] },
    },
  };
  const original = compileLibrary(
    {
      name: 'helper',
      version: '1',
      source: 'function fetch\n  ask api to read "x"\n  return it\nend',
    },
    [],
    declarations,
  );
  const api = defineCapability('api', {
    read: {
      mode: 'immediate',
      args: [shape.optional(shape.text)],
      result: shape.number,
      cost: { fuel: 0 },
      do: (_call, ...args) => num(args.length),
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(original);
  const s = g.load({
    name: 's',
    source: 'use fetch from helper\non go\n  return fetch()\nend',
    grantsAsUsed: true,
    grants: { api: api.grant('all', undefined) },
  });
  g.replaceLibrary(
    compileLibrary(
      {
        name: 'helper',
        version: '2',
        source: 'function fetch\n  ask api to read\n  return it\nend',
      },
      [],
      declarations,
    ),
    'carry variables',
  );
  s.deliver({ name: 'go' });
  expect(
    g
      .pump(now)
      .reports.find(r => r.kind === 'run end')!
      .result?.toString(),
  ).toBe('0');
  s.reload('on go\n  ask api to read\n  return it\nend', 'carry variables');
  s.extend('on extra\n  ask api to read nothing\n  return it\nend');
  s.deliver({ name: 'go' });
  s.deliver({ name: 'extra' });
  expect(
    g
      .pump(now + 1n)
      .reports.filter(r => r.kind === 'run end')
      .map(r => r.result?.toString()),
  ).toEqual(['0', '1']);
  expect(
    codes(() => s.extend('on bad\n  ask api to read "x", "y"\nend')),
  ).toContain('wrong argument count');
});

test('Save/Restore Reissue and Adopt preserve omitted arguments and distinguish Optional declarations', () => {
  const received: { args: Value[]; call: Call<void> }[] = [];
  const api = defineCapability('api', {
    read: {
      mode: 'suspending',
      args: [shape.number, shape.optional(shape.text)],
      result: shape.number,
      cost: { fuel: 1 },
      start: (call, ...args) => {
        received.push({ args, call });
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable seen = []\non go value\n  ask api to read value and wait\n  put it after seen\nend',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go', args: [num(1)] });
  g.script('s')!.deliver({ name: 'go', args: [num(2)] });
  g.pump(now);
  const bytes = g.save();
  const restored = restore(bytes, {
    name: 'copy',
    libraries: [],
    grants: () => api.grant('all', undefined),
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  expect(
    restored.result.pending.map(p => p.args.map(v => v.toString())),
  ).toEqual([['1'], ['2']]);
  expect(restored.group.fingerprint()).toEqual(g.fingerprint());
  restored.group.settle('s/r1.c1', { reissue: true });
  const adopted = restored.group.settle('s/r2.c1', { adopt: true })!;
  restored.group.pump(now + 1n);
  expect(received[2]!.args.map(v => v.toString())).toEqual(['1']);
  received[2]!.call.answer(num(10));
  adopted.answer(num(20));
  restored.group.pump(now + 2n);
  expect(variable(restored.group, 's', 'seen').toString()).toBe('[10, 20]');
  const strict = defineCapability('api', {
    read: { ...api.operations.get('read')!, args: [shape.number, shape.text] },
  });
  expect(() =>
    restore(bytes, {
      name: 'strict',
      libraries: [],
      grants: () => strict.grant('all', undefined),
      resolve: () => undefined,
      onMismatch: 'reject',
    }),
  ).toThrow(HostError);
});
