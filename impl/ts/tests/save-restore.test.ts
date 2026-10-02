import { describe, expect, test } from 'bun:test';
import {
  newGroup,
  restore,
  num,
  HostError,
  text as importText,
  defineCapability,
  shape,
  ScriptError,
  type Call,
  compileLibrary,
  defineObjectKind,
  type Value,
  list,
} from '../src/index';
import { sha256 } from '../src/sha256';

const options = (trace: string[]) => ({
  name: 'resumed',
  trace: (line: string) => trace.push(line),
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
});
const output = (lines: string[]) =>
  lines.filter(
    line => !line.startsWith('> save') && !line.startsWith('> restore'),
  );

describe('save and full restore', () => {
  test('restored timers give the same later Trace and ids', () => {
    const original: string[] = [];
    const g = newGroup({
      name: 'original',
      trace: line => original.push(line),
    });
    g.load({
      name: 's',
      source:
        'script variable n = 0\non go x\n  wait x * 1 s\n  add 1 to n\nend go',
    });
    g.script('s')!.deliver({ name: 'go', args: [num(2)] });
    g.script('s')!.deliver({ name: 'go', args: [num(1)] });
    g.pump(0n);
    const saved = g.save();
    expect(new TextDecoder().decode(saved)).not.toContain('request');
    expect(g.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
    const resumed: string[] = [];
    const { group: copy, result } = restore(saved, options(resumed));
    expect(result).toMatchObject({
      variablesOnly: false,
      pending: [],
      disposed: [],
    });
    expect(copy.fingerprint()).toEqual(g.fingerprint());
    original.length = 0;
    resumed.length = 0;
    g.pump(3_000_000_000n);
    copy.pump(3_000_000_000n);
    expect(output(resumed)).toEqual(output(original));
    expect(copy.script('s')!.deliver({ name: 'go' })).toBe(
      g.script('s')!.deliver({ name: 'go' }),
    );
    expect(() => copy.pump(0n)).toThrow('clock backwards');
  });

  test('preempted loops keep their frames, counters, debt and rollback base', () => {
    const original: string[] = [];
    const g = newGroup({
      name: 'original',
      trace: line => original.push(line),
    });
    g.load({
      name: 's',
      source:
        'script variable n = 0\non spin\n  add 1 to n\n  repeat forever\n  end repeat\nend spin',
      limits: { fuelPerRun: 1000 },
    });
    g.script('s')!.deliver({ name: 'spin' });
    g.pump(0n, { fuelSlice: 100 });
    const resumed: string[] = [];
    const { group: copy } = restore(g.save(), options(resumed));
    original.length = 0;
    resumed.length = 0;
    g.pump(1n);
    copy.pump(1n);
    expect(output(resumed)).toEqual(output(original));
    expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
  });

  test('queued inputs survive, while old Host futures belong to the original Group', () => {
    const original: string[] = [];
    const g = newGroup({
      name: 'original',
      trace: line => original.push(line),
    });
    g.load({ name: 's', source: 'on go x\n  return x + 1\nend go' });
    g.script('s')!.request({ name: 'go', args: [num(2)] });
    const resumed: string[] = [];
    const { group: copy } = restore(g.save(), options(resumed));
    original.length = 0;
    resumed.length = 0;
    expect(copy.pump(0n).reports[0]).toMatchObject({
      delivery: 'd1',
      outcome: 'completed',
    });
    g.pump(0n);
    expect(output(resumed)).toEqual(output(original));
  });

  test('corrupt, truncated and foreign-family saves are invalid save', () => {
    const saved = newGroup({ name: 'g' }).save();
    const corrupt = saved.slice();
    corrupt[corrupt.length - 1] = corrupt.at(-1)! ^ 1;
    for (const value of [
      corrupt,
      saved.slice(0, 12),
      new TextEncoder().encode('{}'),
    ]) {
      expect(() => restore(value, options([]))).toThrow(HostError);
      expect(() => restore(value, options([]))).toThrow('invalid save');
    }
  });
});

describe('pending calls after restore', () => {
  test('answers and failures settle in input order, while an unsettled call is lost before timers', () => {
    const calls: Call<void>[] = [];
    const capability = defineCapability('stock', {
      check: {
        mode: 'suspending',
        args: [shape.text],
        result: shape.number,
        cost: { fuel: 100 },
        start: call => calls.push(call),
        errors: [{ code: 'out of stock' }],
      },
    });
    const grant = capability.grant('all', undefined);
    const g = newGroup({ name: 'g' });
    g.load({
      name: 'shop',
      source:
        'script variable results = []\non check sku\n  try\n    ask stock to check sku and wait\n    put it after results\n  catch {code: code}\n    put code after results\n  end try\nend check',
      grants: { stock: grant },
    });
    for (const sku of ['A1', 'B2', 'C3']) {
      g.script('shop')!.deliver({ name: 'check', args: [importText(sku)] });
    }
    g.pump(0n);
    const lines: string[] = [];
    const { group: copy, result } = restore(g.save(), {
      ...options(lines),
      grants: () => grant,
    });
    expect(result.pending.map(p => p.id)).toEqual([
      'shop/r1.c1',
      'shop/r2.c1',
      'shop/r3.c1',
    ]);
    expect(result.pending[0]!.args[0]!.toString()).toBe('"A1"');
    copy.settle('shop/r2.c1', {
      fail: new ScriptError('out of stock', 'No stock'),
    });
    copy.settle('shop/r1.c1', { answer: num(12) });
    expect(() => copy.settle('shop/r1.c1', { adopt: true })).toThrow(
      'unknown call',
    );
    copy.pump(60_000_000_000n);
    expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe(
      '["out of stock", 12, "call lost"]',
    );
    expect(() => copy.settle('shop/r3.c1', { answer: num(1) })).toThrow(
      'unknown call',
    );
    expect(calls).toHaveLength(3);
  });

  test('reissue starts under the saved id at the first Pump Clock and adopt returns a new Call', () => {
    const calls: Call<void>[] = [];
    const capability = defineCapability('stock', {
      check: {
        mode: 'suspending',
        result: shape.number,
        cost: { fuel: 100 },
        start: call => calls.push(call),
      },
    });
    const grant = capability.grant('all', undefined);
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask stock to check and wait\n  return it\nend go',
      grants: { stock: grant },
    });
    g.script('s')!.deliver({ name: 'go' });
    g.script('s')!.deliver({ name: 'go' });
    g.pump(0n);
    const { group: copy } = restore(g.save(), {
      ...options([]),
      grants: () => grant,
    });
    copy.settle('s/r1.c1', { reissue: true });
    const adopted = copy.settle('s/r2.c1', { adopt: true })!;
    expect(adopted.id).toBe('s/r2.c1');
    expect(calls).toHaveLength(2);
    expect(copy.pump(5_000_000_000n).fuelUsed).toBe(0);
    expect(calls[2]!.id).toBe('s/r1.c1');
    expect(calls[2]!.now).toBe(5_000_000_000n);
    adopted.answer(num(7));
    const r = copy.pump(6_000_000_000n).reports[0]!;
    expect(r).toMatchObject({ delivery: 'd2', outcome: 'completed' });
  });
});

describe('restore compatibility and durable values', () => {
  test('a withheld Library rejects or restores variables only, dropping work and keeping ids', () => {
    const library = compileLibrary({
      name: 'fmt',
      version: '1',
      source: 'function label\n  return 1\nend label',
    });
    const g = newGroup({ name: 'g' });
    g.addLibrary(library);
    g.load({
      name: 's',
      source: 'script variable n = 0\non go\n  add 1 to n\n  wait 10 s\nend go',
    });
    g.script('s')!.deliver({ name: 'go' });
    g.pump(0n);
    g.script('s')!.deliver({ name: 'go' });
    const saved = g.save();
    expect(() => restore(saved, options([]))).toThrow('save mismatch');
    const { group: copy, result } = restore(saved, {
      ...options([]),
      onMismatch: 'variables only',
    });
    expect(result).toMatchObject({
      variablesOnly: true,
      discardedRuns: ['s/r1'],
      droppedMessages: ['d2'],
      pending: [],
    });
    expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe('1');
    expect(copy.script('s')!.deliver({ name: 'go' })).toBe('d3');
    expect(copy.pump(1n).reports).toEqual([]);
  });

  test('unbound Grants keep their declarations and unresolved objects become disposed', () => {
    const capability = defineCapability('log', {
      write: {
        mode: 'fire-and-forget',
        args: [shape.text],
        cost: { fuel: 1 },
        fire: () => {},
      },
    });
    const kind = defineObjectKind<{ state: Value }>({
      name: 'light',
      props: { state: { get: object => object.native.state } },
    });
    const g = newGroup({ name: 'g' });
    const object = g.object(kind, 'bulb-1', { state: importText('off') });
    g.load({
      name: 's',
      source:
        'script variable seen = []\non go\n  try\n    tell log to write "poke"\n  catch {code: code}\n    put code after seen\n  end try\n  try\n    put the state of lamp after seen\n  catch {code: code}\n    put code after seen\n  end try\nend go',
      grants: { log: capability.grant('all', undefined) },
      objects: { lamp: object },
    });
    const fingerprint = g.fingerprint();
    const { group: copy, result } = restore(g.save(), options([]));
    expect(result).toMatchObject({
      variablesOnly: false,
      disposed: [['light', 'bulb-1']],
    });
    expect(copy.fingerprint()).toEqual(fingerprint);
    copy.script('s')!.deliver({ name: 'go' });
    copy.pump(0n);
    expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe(
      '["capability revoked", "object gone"]',
    );
  });

  test('extension Lambdas, captured values and wait-for bodies restore live, and variables-only makes them stale', () => {
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'script variable callback = nothing\nscript variable n = 0',
    });
    g.script('s')!.extend(
      'on make x\n  put (given y: x + y) into callback\n  wait for answer value\n  put value into n\nend make\non useit\n  return callback(n)\nend useit',
    );
    g.script('s')!.deliver({ name: 'make', args: [num(4)] });
    g.pump(0n);
    const saved = g.save();
    const { group: copy } = restore(saved, options([]));
    copy.script('s')!.deliver({ name: 'answer', args: [num(3)] });
    copy.pump(1n);
    copy.script('s')!.deliver({ name: 'useit' });
    const r = copy.pump(2n).reports.find(r => r.kind === 'run end')!;
    expect('result' in r && r.result!.toString()).toBe('7');
    const extra = compileLibrary({
      name: 'extra',
      version: '1',
      source: 'constant value = 1',
    });
    const { group: changed } = restore(saved, {
      ...options([]),
      libraries: [extra],
      onMismatch: 'variables only',
    });
    changed.script('s')!.deliver({ name: 'useit' });
    expect(changed.pump(1n).reports[0]).toMatchObject({ outcome: 'errored' });
  });

  test('a changed Operation declaration is a mismatch and bindings are never saved', () => {
    const capability = defineCapability<string>('log', {
      write: { mode: 'fire-and-forget', cost: { fuel: 1 }, fire: () => {} },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  tell log to write\nend go',
      grants: { log: capability.grant('all', 'secret-binding') },
    });
    const saved = g.save();
    expect(new TextDecoder().decode(saved)).not.toContain('secret-binding');
    const changed = defineCapability('log', {
      write: { mode: 'fire-and-forget', cost: { fuel: 2 }, fire: () => {} },
    });
    expect(() =>
      restore(saved, {
        ...options([]),
        grants: () => changed.grant('all', undefined),
      }),
    ).toThrow('save mismatch');
  });
});

test('deep values restore without a JavaScript recursion limit', () => {
  const g = newGroup({ name: 'g' });
  g.load({ name: 's', source: 'on echo x\n  return x\nend echo' });
  let value: Value = num(1);
  for (let i = 0; i < 20_000; i++) {
    value = list(value);
  }
  g.script('s')!.deliver({ name: 'echo', args: [value] });
  const { group: copy } = restore(g.save(), options([]));
  const r = copy.pump(0n).reports[0]!;
  expect('result' in r && r.result!.equals(value)).toBe(true);
});

test('a rejected restore checks compatibility before asking the Host to resolve objects', () => {
  const kind = defineObjectKind({ name: 'marker', props: {} });
  const g = newGroup({ name: 'g' });
  g.object(kind, 'id', null);
  const library = compileLibrary({
    name: 'missing',
    version: '1',
    source: 'constant value = 1',
  });
  g.addLibrary(library);
  let resolved = 0;
  expect(() =>
    restore(g.save(), {
      ...options([]),
      resolve: () => {
        resolved++;
        return { native: null };
      },
    }),
  ).toThrow('save mismatch');
  expect(resolved).toBe(0);
});

test('variables-only restore reports discarded and queued Decisions with their Script and Run ids', () => {
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go, deciding\n  repeat forever\n  end repeat\nend go',
  });
  g.script('s')!.decide({ name: 'go' });
  g.pump(0n, { fuelSlice: 5 });
  g.script('s')!.decide({ name: 'go' });
  const library = compileLibrary({
    name: 'extra',
    version: '1',
    source: 'constant value = 1',
  });
  const { group: copy } = restore(g.save(), {
    ...options([]),
    libraries: [library],
    onMismatch: 'variables only',
  });
  const reports = copy.pump(1n).reports;
  expect(reports.filter(r => r.kind === 'decided')).toMatchObject([
    {
      delivery: 'd1',
      verdict: 'undecided',
      undecided: [{ script: 's', run: 's/r1', outcome: 'cancelled' }],
    },
    {
      delivery: 'd2',
      verdict: 'undecided',
      undecided: [{ script: 's', outcome: 'cancelled' }],
    },
  ]);
});

const pendingGroup = (
  grant: ReturnType<ReturnType<typeof defineCapability>['grant']>,
) => {
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\n  ask api to hold and wait\nend go',
    grants: { api: grant },
  });
  g.script('s')!.deliver({ name: 'go' });
  g.pump(0n);
  return g;
};

test('reissue Charge counts against Pump cap, Script slice and later debt', () => {
  let reissued = false;
  const cap = defineCapability('api', {
    hold: {
      mode: 'suspending',
      cost: { fuel: 1 },
      start: c => {
        if (reissued) {
          c.charge(50);
        }
      },
    },
  });
  const grant = cap.grant('all', undefined);
  const { group: copy } = restore(pendingGroup(grant).save(), {
    ...options([]),
    grants: () => grant,
  });
  reissued = true;
  copy.settle('s/r1.c1', { reissue: true });
  copy.script('s')!.deliver({ name: 'go' });
  expect(copy.pump(1n, { fuelCap: 10, fuelSlice: 10 })).toMatchObject({
    fuelUsed: 50,
    state: 'sliced',
  });
  expect(copy.pump(2n, { fuelSlice: 10 }).fuelUsed).toBe(0);
});

test('queued reissue and adopt stay settled through another save before Pump', () => {
  const cap = defineCapability('api', {
    hold: { mode: 'suspending', cost: { fuel: 1 }, start: () => {} },
  });
  const grant = cap.grant('all', undefined);
  for (const settlement of [{ reissue: true }, { adopt: true }] as const) {
    const { group: copy } = restore(pendingGroup(grant).save(), {
      ...options([]),
      grants: () => grant,
    });
    copy.settle('s/r1.c1', settlement);
    const { group: again } = restore(copy.save(), {
      ...options([]),
      grants: () => grant,
    });
    expect(() => again.settle('s/r1.c1', { reissue: true })).toThrow(
      'unknown call',
    );
    expect(again.pump(1n).reports).toEqual([]);
  }
});

test('adoptability belongs to the original call, not its rebound implementation', () => {
  const started = defineCapability('api', {
    hold: { mode: 'suspending', cost: { fuel: 1 }, start: () => {} },
  }).grant('all', undefined);
  const promised = defineCapability('api', {
    hold: {
      mode: 'suspending',
      cost: { fuel: 1 },
      run: () => new Promise<Value>(() => {}),
    },
  }).grant('all', undefined);
  const { group: promiseCopy } = restore(pendingGroup(promised).save(), {
    ...options([]),
    grants: () => started,
  });
  expect(() => promiseCopy.settle('s/r1.c1', { adopt: true })).toThrow(
    'not adoptable',
  );
  const { group: startCopy } = restore(pendingGroup(started).save(), {
    ...options([]),
    grants: () => promised,
  });
  expect(startCopy.settle('s/r1.c1', { adopt: true })!.id).toBe('s/r1.c1');
});

test('shared declarations reissue through each owning Script rebound Grant', () => {
  const common = defineCapability('api', {
    hold: { mode: 'suspending', cost: { fuel: 1 }, start: () => {} },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  for (const name of ['a', 'b']) {
    g.load({
      name,
      source: 'on go\n  ask api to hold and wait\nend go',
      grants: { api: common },
    });
    g.script(name)!.deliver({ name: 'go' });
  }
  g.pump(0n);
  const starts: string[] = [];
  const { group: copy } = restore(g.save(), {
    ...options([]),
    grants: name =>
      defineCapability('api', {
        hold: {
          mode: 'suspending',
          cost: { fuel: 1 },
          start: c => {
            starts.push(`${name}:${c.scriptName}`);
          },
        },
      }).grant('all', undefined),
  });
  copy.settle('a/r1.c1', { reissue: true });
  copy.settle('b/r1.c1', { reissue: true });
  copy.pump(1n);
  expect(starts).toEqual(['a:a', 'b:b']);
});

test('checksummed malformed graphs and unsupported formats are invalid saves', () => {
  const bytes = newGroup({ name: 'g' }).save();
  for (const mutate of [
    (s: { format: number; graph: { nodes: { data: unknown }[] } }) => {
      s.graph.nodes[0]!.data = null;
    },
    (s: { format: number; graph: { nodes: { data: unknown }[] } }) => {
      s.format = 1;
    },
  ]) {
    const outer = JSON.parse(new TextDecoder().decode(bytes));
    const saved = JSON.parse(outer.payload);
    mutate(saved);
    outer.payload = JSON.stringify(saved);
    outer.hash = sha256(outer.payload);
    try {
      restore(new TextEncoder().encode(JSON.stringify(outer)), options([]));
      throw new Error('Accepted invalid save');
    } catch (error) {
      expect(error).toBeInstanceOf(HostError);
      expect((error as HostError).code).toBe('invalid save');
    }
  }
});

const errorFingerprint = (errors?: []) => {
  const g = newGroup({ name: 'g' });
  const grant = defineCapability('api', {
    hold: {
      mode: 'suspending',
      cost: { fuel: 1 },
      ...(errors ? { errors } : {}),
      start: () => {},
    },
  }).grant('all', undefined);
  g.load({ name: 's', source: '', grants: { api: grant } });
  return g.fingerprint();
};

test('omitted and empty error catalogues have different Fingerprints', () => {
  expect(errorFingerprint()).not.toEqual(errorFingerprint([]));
});

test('equal complete state produces equal bytes and Save ids survive restore', () => {
  const a = newGroup({ name: 'g' });
  const b = newGroup({ name: 'g' });
  const saved = a.save();
  expect(saved).toEqual(b.save());
  const lines: string[] = [];
  const { group: copy } = restore(saved, options(lines));
  copy.save();
  expect(lines.at(-1)).toBe('> save s2');
});

test('pending and lost calls use numeric Run counters after the Script name', () => {
  const grant = defineCapability('api', {
    hold: { mode: 'suspending', cost: { fuel: 1 }, start: () => {} },
  }).grant('all', undefined);
  const g = pendingGroup(grant);
  for (let i = 0; i < 10; i++) {
    g.script('s')!.deliver({ name: 'go' });
  }
  g.pump(1n);
  const { group: copy, result } = restore(g.save(), {
    ...options([]),
    grants: () => grant,
  });
  expect(result.pending.map(p => p.id)).toEqual(
    Array.from({ length: 11 }, (_, i) => `s/r${i + 1}.c1`),
  );
  expect(
    copy
      .pump(2n)
      .reports.filter(r => r.kind === 'run end')
      .map(r => r.run),
  ).toEqual(Array.from({ length: 11 }, (_, i) => `s/r${i + 1}`));
});

test('partly sealed Broadcasts keep their ballots and discarded reports survive another save', () => {
  const g = newGroup({ name: 'g' });
  g.load({ name: 'a', source: 'on go, deciding\n  veto "no"\nend go' });
  g.load({
    name: 'b',
    source: 'on go, deciding\n  repeat 100 times\n  end repeat\nend go',
  });
  g.decideBroadcast({ name: 'go' });
  expect(
    g.pump(0n, { fuelSlice: 30 }).reports.filter(r => r.kind === 'decided'),
  ).toEqual([]);
  const bytes = g.save();
  const { group: full } = restore(bytes, options([]));
  expect(full.pump(1n).reports.find(r => r.kind === 'decided')).toMatchObject({
    broadcast: 'b1',
    verdict: 'vetoed',
    vetoes: [{ script: 'a' }],
    undecided: [],
  });
  const library = compileLibrary({
    name: 'extra',
    version: '1',
    source: 'constant value = 1',
  });
  const settings = {
    ...options([]),
    libraries: [library],
    onMismatch: 'variables only' as const,
  };
  const { group: variables } = restore(bytes, settings);
  const { group: again } = restore(variables.save(), settings);
  expect(again.pump(1n).reports.find(r => r.kind === 'decided')).toMatchObject({
    broadcast: 'b1',
    verdict: 'vetoed',
    vetoes: [{ script: 'a', run: 'a/r1' }],
    undecided: [{ script: 'b', run: 'b/r1', outcome: 'cancelled' }],
  });
});

test('Stop inside reissue lands after its crossing and before due waits run', () => {
  const stopping: { group?: ReturnType<typeof newGroup> } = {};
  const grant = defineCapability('api', {
    hold: {
      mode: 'suspending',
      cost: { fuel: 1 },
      start: () => {
        stopping.group?.script('s')!.stop('done');
      },
    },
  }).grant('all', undefined);
  const g = pendingGroup(grant);
  g.script('s')!.extend('on nap\n  wait 1 s\nend nap');
  g.script('s')!.deliver({ name: 'nap' });
  g.pump(1n);
  const lines: string[] = [];
  const { group: copy } = restore(g.save(), {
    ...options(lines),
    grants: () => grant,
  });
  stopping.group = copy;
  copy.settle('s/r1.c1', { reissue: true });
  copy.pump(2_000_000_000n);
  expect(lines.some(line => line.startsWith('seg s/r2 resume'))).toBe(false);
  const crossing = lines.findIndex(line => line.startsWith('call s/r1.c1'));
  expect(lines[crossing + 1]).toBe('> stop s reason="done"');
});

test('a withheld imported Library rejects as mismatch before rebuilding source', () => {
  const library = compileLibrary({
    name: 'base',
    version: '1',
    source: 'constant n = 1',
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(library);
  g.load({ name: 's', source: 'use n from base\nscript variable x = n' });
  expect(() => restore(g.save(), options([]))).toThrow('save mismatch');
});

test('a backwards restored Pump records its refusal and keeps queued work', () => {
  const g = newGroup({ name: 'g' });
  g.load({ name: 's', source: 'on go\n  return 1\nend go' });
  g.pump(5n);
  const lines: string[] = [];
  const { group: copy } = restore(g.save(), options(lines));
  copy.script('s')!.deliver({ name: 'go' });
  expect(() => copy.pump(4n)).toThrow('clock backwards');
  expect(lines.slice(-2)).toEqual([
    '> pump clock=1970-01-01T00:00:00.000000004Z',
    'refused code="clock backwards"',
  ]);
  expect(copy.pump(5n).reports[0]).toMatchObject({
    outcome: 'completed',
    delivery: 'd1',
  });
});

test('reissue Fuel exhaustion preserves committed variables and abandons its Call', () => {
  let reissued = false;
  let signal: AbortSignal | undefined;
  const grant = defineCapability('api', {
    hold: {
      mode: 'suspending',
      cost: { fuel: 1 },
      start: c => {
        if (reissued) {
          signal = c.signal;
          try {
            c.charge(1000);
          } catch {
            /* A Host cannot swallow the cutoff. */
          }
        }
      },
    },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable n = 0\non go\n  put 9 into n\n  ask api to hold and wait\nend go',
    grants: { api: grant },
    limits: { fuelPerRun: 100 },
  });
  g.script('s')!.deliver({ name: 'go' });
  g.pump(0n);
  const lines: string[] = [];
  const { group: copy } = restore(g.save(), {
    ...options(lines),
    grants: () => grant,
  });
  reissued = true;
  copy.settle('s/r1.c1', { reissue: true });
  expect(copy.pump(1n).reports[0]).toMatchObject({ outcome: 'limit fault' });
  expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe('9');
  expect(signal!.aborted).toBe(true);
  expect(lines).toContain('abandon s/r1.c1');
});

test('a reissue fault abandons only unanswered Join members', () => {
  let reissued = false;
  const calls: Call<unknown>[] = [];
  const grant = defineCapability('api', {
    hold: {
      mode: 'suspending',
      cost: { fuel: 0 },
      start: c => {
        calls.push(c);
        if (reissued) {
          try {
            c.charge(1000);
          } catch {
            /* Keep going to exercise the cutoff. */
          }
        }
      },
    },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    limits: { fuelPerRun: 200 },
    grants: { api: grant },
    source:
      'on go\n  wait for all\n    ask api to hold and wait\n    ask api to hold and wait\n    ask api to hold and wait\n  end wait\nend go',
  }).deliver({ name: 'go' });
  g.pump(0n);
  calls[0]!.answer(num(1));
  g.pump(1n);
  const lines: string[] = [];
  const { group: copy } = restore(g.save(), {
    ...options(lines),
    grants: () => grant,
  });
  reissued = true;
  copy.settle('s/r1.c2', { reissue: true });
  copy.settle('s/r1.c3', { adopt: true });
  copy.pump(2n);
  expect(lines.filter(line => line.startsWith('abandon '))).toEqual([
    'abandon s/r1.c2',
    'abandon s/r1.c3',
  ]);
});
