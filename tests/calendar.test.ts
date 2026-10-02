import { expect, test } from 'bun:test';
import {
  calendarCapability,
  defineCapability,
  compileLibrary,
  restore,
  shape,
  civilDate,
  instant,
  newGroup,
  parseInstant,
  quantity,
  text,
  num,
  map,
  ScriptError,
  HostError,
  type CalendarImpl,
  type Costs,
  type Value,
} from '../src/index';

const now = parseInstant('2026-10-02T12:00:00Z');
const date = civilDate('2026-10-02');
const time = civilDate('2026-10-02T13:00:00');
const costs: Costs = Object.fromEntries(
  ['today', 'now', 'toCivil', 'toInstant', 'offset', 'zone'].map(name => [
    name,
    { fuel: 7 },
  ]),
);
const impl: CalendarImpl = {
  today: () => date,
  now: () => time,
  toCivil: () => time,
  toInstant: () => instant(now),
  offset: () => quantity(num(3600), 's'),
  zone: call => text(call.binding),
};
const run = (body: string, host = impl) => {
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  g.load({
    name: 's',
    source: `script variable seen = nothing\non go\n${body}\nput it into seen\nend`,
    grants: {
      cal: calendarCapability(host, costs).grant('all', 'Europe/London'),
    },
  }).deliver({ name: 'go' });
  const report = g.pump(now).reports.find(r => r.kind === 'run end')!;
  return {
    g,
    lines,
    report,
    seen: new Map(g.inspect().scripts[0]!.vars).get('seen')!,
  };
};

test('Calendar validates all methods and costs at construction and copies costs', () => {
  for (const name of Object.keys(impl)) {
    expect(() =>
      calendarCapability(
        { ...impl, [name]: undefined } as unknown as CalendarImpl,
        costs,
      ),
    ).toThrow(HostError);
    expect(() =>
      calendarCapability(impl, { ...costs, [name]: { fuel: -1 } }),
    ).toThrow(HostError);
    const missing = { ...costs };
    delete missing[name];
    expect(() => calendarCapability(impl, missing)).toThrow(HostError);
  }
  const given = { ...costs, today: { fuel: 3 } };
  const cal = calendarCapability(impl, given);
  given.today.fuel = 99;
  expect(cal.operations.get('today')!.cost.fuel).toBe(3);
});

test('Calendar forwards six operations with the Pump Clock, binding and optional zone', () => {
  const seen: unknown[] = [];
  const host: CalendarImpl = {
    today(call, zone) {
      seen.push([call.now, call.binding, zone]);
      return date;
    },
    now: (_call, zone) => {
      seen.push(zone);
      return time;
    },
    toCivil: (_call, value, zone) => {
      seen.push([value.toString(), zone]);
      return time;
    },
    toInstant: (_call, value, disambiguation, zone) => {
      seen.push([value.toString(), disambiguation, zone]);
      return instant(now);
    },
    offset: (_call, value, zone) => {
      seen.push([value.toString(), zone]);
      return quantity(num(3600), 's');
    },
    zone: (call, zone) => text(zone ?? call.binding),
  };
  const result = run(
    'ask cal to today\nask cal to now "UTC"\nask cal to toCivil "2026-10-02T12:00:00Z" as instant\nask cal to toInstant "2026-10-02T13:00:00" as civil date, "later", "Europe/London"\nask cal to offset "2026-10-02T12:00:00Z" as instant, "UTC"\nask cal to zone',
    host,
  );
  expect(result.report.outcome).toBe('completed');
  expect(result.seen.asText()).toBe('Europe/London');
  expect(seen).toEqual([
    [now, 'Europe/London', undefined],
    'UTC',
    ['2026-10-02T12:00:00Z', undefined],
    ['2026-10-02T13:00:00', 'later', 'Europe/London'],
    ['2026-10-02T12:00:00Z', 'UTC'],
  ]);
});

test('toInstant resolves omitted, Nothing, disambiguation-only and zone-only positions', () => {
  for (const [suffix, disambiguation, zone] of [
    ['', 'compatible', undefined],
    [', nothing', 'compatible', undefined],
    [', "UTC"', 'compatible', 'UTC'],
    [', "reject"', 'reject', undefined],
    [', nothing, "UTC"', 'compatible', 'UTC'],
    [', "earlier", nothing', 'earlier', undefined],
  ] as const) {
    const seen: unknown[] = [];
    const result = run(
      `ask cal to toInstant "2026-10-02T13:00:00" as civil date${suffix}`,
      {
        ...impl,
        toInstant: (_call, _civil, d, z) => {
          seen.push(d, z);
          return instant(now);
        },
      },
    );
    expect(result.report.outcome).toBe('completed');
    expect(seen).toEqual([disambiguation, zone]);
  }
});

test('Calendar rejects date-only conversion and an invalid three-argument disambiguation before calling the Host', () => {
  for (const args of [
    '"2026-10-02" as civil date',
    '"2026-10-02T13:00:00" as civil date, "UTC", "Europe/London"',
  ]) {
    let called = false;
    const result = run(`ask cal to toInstant ${args}`, {
      ...impl,
      toInstant: () => {
        called = true;
        return instant(now);
      },
    });
    expect(called).toBe(false);
    expect(result.report.error?.get('code').asText()).toBe('out of domain');
    expect(result.lines.some(line => line.startsWith('call '))).toBe(false);
  }
});

test('Calendar enforces civil result refinements and exact seconds offsets', () => {
  for (const [operation, value] of [
    ['today', time],
    ['now', date],
    ['toCivil', date],
    ['offset', quantity(num(1), 'hr')],
    ['zone', num(1)],
    ['toInstant', date],
  ] as [string, Value][]) {
    const args =
      operation === 'toCivil' || operation === 'offset'
        ? ' "2026-10-02T12:00:00Z" as instant'
        : operation === 'toInstant'
          ? ' "2026-10-02T13:00:00" as civil date'
          : '';
    expect(
      run(`ask cal to ${operation}${args}`, {
        ...impl,
        [operation]: () => value,
      })
        .report.error?.get('code')
        .asText(),
    ).toBe('host error');
  }
});

test('Calendar admits only its declared catalogue errors with valid fields', () => {
  for (const [code, data, expected] of [
    ['unknown zone', map([['zone', text('Mars')]]), 'unknown zone'],
    ['unknown zone', map([['zone', num(1)]]), 'host error'],
    ['unknown zone', map([]), 'host error'],
    [
      'ambiguous time',
      map([
        ['civil', time],
        ['zone', text('Europe/London')],
      ]),
      'ambiguous time',
    ],
    [
      'ambiguous time',
      map([
        ['civil', text('wrong')],
        ['zone', text('Europe/London')],
      ]),
      'host error',
    ],
    ['out of domain', map([]), 'host error'],
  ] as const) {
    const result = run(
      'ask cal to toInstant "2026-10-02T13:00:00" as civil date, "reject"',
      {
        ...impl,
        toInstant: () => {
          throw new ScriptError(code, 'failure', data);
        },
      },
    );
    expect(result.report.error?.get('code').asText()).toBe(expected);
    if (expected !== 'host error') {
      expect(result.report.error?.get('capability').asText()).toBe('cal');
    }
  }
  expect(
    run('ask cal to today', {
      ...impl,
      today: () => {
        throw new ScriptError(
          'ambiguous time',
          '',
          map([
            ['civil', time],
            ['zone', text('UTC')],
          ]),
        );
      },
    })
      .report.error?.get('code')
      .asText(),
  ).toBe('host error');
});

test('Calendar rejects dynamic argument kinds without reaching the Host or charging a call', () => {
  let called = false;
  const result = run('put 42 into badZone\nask cal to today badZone', {
    ...impl,
    today: () => {
      called = true;
      return date;
    },
  });
  expect(called).toBe(false);
  expect(result.report.error?.get('code').asText()).toBe('wrong kind');
  expect(result.report.error?.get('argument').toString()).toBe('1');
  expect(result.lines.some(line => line.startsWith('call '))).toBe(false);
});

test('Calendar pays declared costs before the Host and rolls back on insufficient Fuel', () => {
  let called = false;
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable touched = 0\non go\nadd 1 to touched\nask cal to today\nend',
    limits: { fuelPerRun: 40 },
    grants: {
      cal: calendarCapability(
        {
          ...impl,
          today: () => {
            called = true;
            return date;
          },
        },
        { ...costs, today: { fuel: 100 } },
      ).grant('all', 'UTC'),
    },
  }).deliver({ name: 'go' });
  expect(g.pump(now).reports.find(r => r.kind === 'run end')!.outcome).toBe(
    'limit fault',
  );
  expect(called).toBe(false);
  expect(new Map(g.inspect().scripts[0]!.vars).get('touched')!.toString()).toBe(
    '0',
  );
});

test('ordinary Capabilities cannot impersonate Calendar catalogue failures', () => {
  const g = newGroup({ name: 'g' });
  const calendar = defineCapability('calendar', {
    today: {
      mode: 'immediate',
      args: [],
      cost: { fuel: 0 },
      errors: [{ code: 'unknown zone' }],
      do: () => {
        throw new ScriptError(
          'unknown zone',
          '',
          map([['zone', text('Mars')]]),
        );
      },
    },
  });
  g.load({
    name: 's',
    source: 'on go\nask calendar to today\nend',
    grants: { calendar: calendar.grant('all', undefined) },
  }).deliver({ name: 'go' });
  expect(
    g
      .pump(now)
      .reports.find(r => r.kind === 'run end')!
      .error?.get('code')
      .asText(),
  ).toBe('host error');
});

test('Calendar calls from a Library retain their refinements and grants across Restore', () => {
  const calendar = calendarCapability(impl, costs);
  const helper = compileLibrary(
    {
      name: 'helper',
      version: '1',
      source: 'function currentDay\nask cal to today\nreturn it\nend',
    },
    [],
    {
      cal: { today: { mode: 'immediate', args: [shape.optional(shape.text)] } },
    },
  );
  const g = newGroup({ name: 'g' });
  g.addLibrary(helper);
  const script = g.load({
    name: 's',
    source:
      'use currentDay from helper\nscript variable seen = nothing\non go\nput currentDay() into seen\nend',
    grantsAsUsed: true,
    grants: { cal: calendar.grant('all', 'UTC') },
  });
  expect(script.grants()).toEqual({ cal: ['today'] });
  const copy = restore(g.save(), {
    name: 'copy',
    libraries: [helper],
    grants: () =>
      calendarCapability({ ...impl, today: () => time }, costs).grant(
        'all',
        'UTC',
      ),
    resolve: () => undefined,
    onMismatch: 'reject',
  }).group;
  expect(copy.fingerprint()).toEqual(g.fingerprint());
  copy.script('s')!.deliver({ name: 'go' });
  expect(
    copy
      .pump(now)
      .reports.find(r => r.kind === 'run end')!
      .error?.get('code')
      .asText(),
  ).toBe('host error');
});
