import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import {
  consoleCapability,
  compileLibrary,
  defineCapability,
  HostError,
  LoadError,
  newGroup,
  num,
  parseInstant,
  restore,
  shape,
  ScriptError,
  text,
  type Call,
  type ConsoleImpl,
  type Value,
} from '../src/index';

const now = parseInstant('2026-10-02T12:00:00Z');
const costs = { write: { fuel: 7, alloc: 2 }, read: { fuel: 11, alloc: 3 } };
const noConsole: ConsoleImpl = { write: () => {}, read: () => {} };
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

test('Console validates its Host methods and copies each required Operation cost', () => {
  expect(() => consoleCapability(noConsole, { write: costs.write })).toThrow(
    HostError,
  );
  expect(() => consoleCapability(noConsole, { read: costs.read })).toThrow(
    HostError,
  );
  expect(() =>
    consoleCapability(noConsole, { ...costs, read: { fuel: -1 } }),
  ).toThrow(HostError);
  expect(() =>
    consoleCapability({ write: () => {} } as unknown as ConsoleImpl, costs),
  ).toThrow(HostError);
  expect(() =>
    consoleCapability({ read: () => {} } as unknown as ConsoleImpl, costs),
  ).toThrow(HostError);
  const given = { write: { fuel: 4 }, read: { fuel: 2 } };
  const console = consoleCapability(noConsole, given);
  given.write.fuel = 99;
  given.read.fuel = 99;
  expect(console.operations.get('write')!.cost.fuel).toBe(4);
  expect(console.operations.get('read')!.cost.fuel).toBe(2);
});

test('Console calls and say require Grants and the fixed modes and arities', () => {
  const g = newGroup({ name: 'g' });
  const console = consoleCapability(noConsole, costs);
  const grants = { console: console.grant('all', undefined) };
  for (const [body, code] of [
    ['tell console to read', 'wrong mode'],
    ['ask console to write 1', 'wrong mode'],
    ['ask console to read', 'wrong mode'],
    ['tell console to write', 'wrong argument count'],
    ['ask console to read 1 and wait', 'wrong argument count'],
    ['say 1, 2', 'wrong argument count'],
  ]) {
    expect(
      codes(() =>
        g.load({ name: 's', source: `on go\n  ${body}\nend`, grants }),
      ),
    ).toContain(code!);
  }
  expect(
    codes(() => g.load({ name: 's', source: 'on go\n  say 1\nend' })),
  ).toEqual(['unknown operation']);
  expect(
    codes(() =>
      g.load({
        name: 's',
        source: 'on go\n  say 1\nend',
        grants: { console: console.grant(['read'], undefined) },
      }),
    ),
  ).toEqual(['unknown operation']);
});

test('write accepts every Value, including nested Functions, and preserves its receiver and binding', () => {
  const binding = { pane: 'out' };
  const impl = {
    values: [] as Value[],
    calls: [] as Call<unknown>[],
    read: noConsole.read,
    write(call: Call<unknown>, value: Value) {
      this.values.push(value);
      this.calls.push(call);
      call.charge(5);
    },
  };
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'on go\n  say "hello" & newline\n  say 2 kg\n  put given x: x into f\n  say f\n  tell pane to write [{callback: f}]\nend',
    grants: {
      console: consoleCapability(impl, costs).grant(['write'], binding),
      pane: consoleCapability(impl, costs).grant(['write'], binding),
    },
  }).deliver({ name: 'go' });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  expect(report.outcome).toBe('completed');
  expect(impl.values.map(v => v.kind)).toEqual([
    'text',
    'quantity',
    'function',
    'list',
  ]);
  expect(impl.values[0]!.asText()).toBe('hello\n');
  expect(impl.values[1]!.toString()).toBe('2 kg');
  expect(impl.values[3]!.index(1).get('callback')).toBe(impl.values[2]!);
  expect(
    impl.calls.every(
      c => c.binding === binding && c.scriptName === 's' && c.now === now,
    ),
  ).toBe(true);
  expect(() => impl.calls[0]!.charge(1)).toThrow(HostError);
});

test('value Shapes admit Function Values while any data Shapes still refuse them', () => {
  const seen: Value[] = [];
  const data = defineCapability('data', {
    put: {
      mode: 'fire-and-forget',
      args: [shape.any],
      cost: { fuel: 0 },
      fire: () => {
        throw new Error('must not reach Host');
      },
    },
  });
  const values = defineCapability('values', {
    put: {
      mode: 'fire-and-forget',
      args: [shape.value],
      cost: { fuel: 0 },
      fire: (_call, value) => {
        seen.push(value!);
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'on go\n  put given: 1 into f\n  tell values to put [{callback: f}]\n  tell data to put [{callback: f}]\nend',
    grants: {
      data: data.grant('all', undefined),
      values: values.grant('all', undefined),
    },
  }).deliver({ name: 'go' });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  expect(seen).toHaveLength(1);
  expect(report.error?.code).toBe('not encodable');
  expect(report.error?.data.get('path').toString()).toBe('[1, 1, "callback"]');
});

test('read suspends and resumes on a queued text answer, including an empty line and late Fuel', () => {
  const calls: Call<unknown>[] = [];
  const lines: string[] = [];
  const impl = {
    ...noConsole,
    read: (call: Call<unknown>) => {
      calls.push(call);
      call.charge(3);
    },
  };
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const s = g.load({
    name: 's',
    source:
      'script variable seen = []\non go\n  ask input to read and wait\n  put it after seen\nend',
    grants: {
      input: consoleCapability(impl, costs).grant(['read'], 'terminal'),
    },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  expect(g.inspect().scripts[0]!.runs[0]!.status).toBe('suspended');
  expect(calls[0]!.binding).toBe('terminal');
  calls[0]!.answer(text(''), { fuel: 4 });
  expect(
    new Map(g.inspect().scripts.find(script => script.name === 's')!.vars)
      .get('seen')!
      .toString(),
  ).toBe('[]');
  g.pump(now + 1n);
  expect(
    new Map(g.inspect().scripts.find(script => script.name === 's')!.vars)
      .get('seen')!
      .toString(),
  ).toBe('[""]');
  expect(lines).toContain('> answer s/r1.c1 value="" fuel=4');
  expect(lines).toContain('call s/r1.c1 op=input.read args=[] charged=3');
});

test('Console read uses its human-input timeout instead of a shorter Script MaxWait', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\n  ask console to read and wait\nend',
    limits: { maxWaitMs: 1 },
    grants: {
      console: consoleCapability(noConsole, costs).grant('all', undefined),
    },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  g.pump(now + 2_000_000n);
  expect(g.inspect().scripts[0]!.runs[0]!.status).toBe('suspended');
  const report = operationalReports(
    g.pump(now + 2_147_483_647_000_000n).reports,
  ).find(r => r.kind === 'run end')!;
  expect(report.error?.code).toBe('timeout');
});

test('cancelling a pending Console read aborts its Call and ignores a late answer', () => {
  const calls: Call<unknown>[] = [];
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source:
      'script variable seen = "unchanged"\non go\n  ask console to read and wait\n  put it into seen\nend',
    grants: {
      console: consoleCapability(
        {
          ...noConsole,
          read: call => {
            calls.push(call);
          },
        },
        costs,
      ).grant('all', undefined),
    },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  s.cancelRun('s/r1');
  g.pump(now + 1n);
  expect(calls[0]!.signal.aborted).toBe(true);
  calls[0]!.answer(text('late'));
  g.pump(now + 2n);
  expect(
    new Map(g.inspect().scripts.find(script => script.name === 's')!.vars)
      .get('seen')!
      .asText(),
  ).toBe('unchanged');
});

test('Console result Shape and undeclared failures become host error', () => {
  for (const wrong of [true, false]) {
    const calls: Call<unknown>[] = [];
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask console to read and wait\nend',
      grants: {
        console: consoleCapability(
          {
            ...noConsole,
            read: call => {
              calls.push(call);
            },
          },
          costs,
        ).grant('all', undefined),
      },
    }).deliver({ name: 'go' });
    g.pump(now);
    if (wrong) {
      calls[0]!.answer(num(1));
    } else {
      calls[0]!.fail(new ScriptError('refused', 'no'));
    }
    const report = operationalReports(g.pump(now + 1n).reports).find(
      r => r.kind === 'run end',
    )!;
    expect(report.error?.code).toBe('host error');
  }
});

test('Console write pays its declared cost before reaching the Host or retaining Segment state', () => {
  let written = false;
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source:
      'script variable touched = 0\non go\n  add 1 to touched\n  say "hello"\nend',
    limits: { fuelPerRun: 40 },
    grants: {
      console: consoleCapability(
        {
          ...noConsole,
          write: () => {
            written = true;
          },
        },
        { write: { fuel: 100 }, read: { fuel: 0 } },
      ).grant('all', undefined),
    },
  });
  s.deliver({ name: 'go' });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  expect(report.outcome).toBe('limit fault');
  expect(written).toBe(false);
  expect(
    new Map(g.inspect().scripts.find(script => script.name === 's')!.vars)
      .get('touched')!
      .toString(),
  ).toBe('0');
});

test('Library say needs keep only write, and Console declarations and reissued reads survive Restore', () => {
  const helper = compileLibrary(
    {
      name: 'helper',
      version: '1',
      source: 'function show value\n  say value\nend',
    },
    [],
    { console: { write: { mode: 'fire-and-forget', args: [shape.value] } } },
  );
  const console = consoleCapability(noConsole, costs);
  const g = newGroup({ name: 'g' });
  g.addLibrary(helper);
  const writer = g.load({
    name: 'writer',
    source: 'use show from helper\non go\n  show(1)\nend',
    grantsAsUsed: true,
    grants: { console: console.grant('all', undefined) },
  });
  expect(writer.grants()).toEqual({ console: ['write'] });
  g.load({
    name: 'reader',
    source:
      'script variable seen = ""\non go\n  ask console to read and wait\n  put it into seen\nend',
    grants: { console: console.grant('all', undefined) },
  }).deliver({ name: 'go' });
  g.pump(now);
  const calls: Call<unknown>[] = [];
  const restored = restore(g.save(), {
    name: 'copy',
    libraries: [helper],
    grants: () =>
      consoleCapability(
        {
          ...noConsole,
          read: call => {
            calls.push(call);
          },
        },
        costs,
      ).grant('all', undefined),
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  const dataOnlyConsole = defineCapability(
    'console',
    Object.fromEntries(
      [...console.operations].map(([name, op]) => [
        name,
        name === 'write' ? { ...op, args: [shape.any] } : op,
      ]),
    ),
  );
  expect(() =>
    restore(g.save(), {
      name: 'mismatch',
      libraries: [helper],
      grants: () => dataOnlyConsole.grant('all', undefined),
      resolve: () => undefined,
      onMismatch: 'reject',
    }),
  ).toThrow(HostError);
  expect(restored.group.fingerprint()).toEqual(g.fingerprint());
  restored.group.settle('reader/r1.c1', { reissue: true });
  restored.group.pump(now + 1n);
  calls[0]!.answer(text('restored'));
  restored.group.pump(now + 2n);
  expect(
    new Map(
      restored.group.inspect().scripts.find(script => script.name === 'reader')!
        .vars,
    )
      .get('seen')!
      .asText(),
  ).toBe('restored');
});
