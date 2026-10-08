import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  defineObjectKind,
  newGroup,
  dec,
  quantity,
  parseInstant,
  ScriptError,
  shape,
  text,
  type Call,
  type Report,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
const later = (seconds: number) => now + BigInt(seconds) * 1_000_000_000n;
const failures = (reports: Report[]) =>
  reports.filter(r => r.kind === 'call failed');
const kinds = (reports: Report[]) => reports.map(r => r.kind);

describe('call failed reports', () => {
  test('a throwing immediate Operation reports its Host detail, before the Run ends', () => {
    const db = defineCapability('db', {
      get: {
        mode: 'immediate',
        cost: { fuel: 1 },
        do: () => {
          throw new Error('connection refused');
        },
      },
    });
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    g.load({
      name: 's',
      source:
        'on go\n  try\n    ask store to get\n  catch {code: c}\n    return c\n  end try\nend go',
      grants: { store: db.grant('all', undefined) },
    }).deliver({ name: 'go' });
    const { reports } = g.pump(now);
    expect(kinds(operationalReports(reports))).toEqual([
      'call failed',
      'run end',
    ]);
    const [failed] = failures(reports);
    expect(failed).toMatchObject({
      kind: 'call failed',
      script: 's',
      operation: { capability: 'db', operation: 'get' },
    });
    expect(failed!.kind === 'call failed' && failed!.detail).toContain(
      'connection refused',
    );
    // The call id is the one the Trace's `call-failed` record names.
    const id = failed!.kind === 'call failed' ? failed!.call : '';
    expect(lines).toContain(`call-failed ${id} op=store.get`);
    // The Script sees only `host error`, with no Host detail.
    expect(operationalReports(reports)[1]).toMatchObject({
      kind: 'run end',
      outcome: 'completed',
    });
    const end = operationalReports(reports)[1]!;
    expect(end.kind === 'run end' && end.result?.toString()).toBe(
      '"host error"',
    );
  });

  test('a result that breaks its Shape is reported as the Host fault it is', () => {
    const db = defineCapability('db', {
      count: {
        mode: 'immediate',
        cost: { fuel: 1 },
        result: shape.number,
        do: () => text('many'),
      },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask db to count\nend go',
      grants: { db: db.grant('all', undefined) },
    }).deliver({ name: 'go' });
    const { reports } = g.pump(now);
    expect(kinds(operationalReports(reports))).toEqual([
      'call failed',
      'run end',
    ]);
    expect(failures(reports)[0]).toMatchObject({
      script: 's',
      operation: { capability: 'db', operation: 'count' },
    });
    expect(operationalReports(reports)[1]).toMatchObject({
      outcome: 'errored',
    });
  });

  test("a suspending call's undeclared failure is reported by the Pump that resumes it", () => {
    let pending: Call<unknown> | undefined;
    const http = defineCapability('http', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 1 },
        errors: [{ code: 'not found' }],
        start: call => {
          pending = call;
        },
      },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask web to fetch and wait\nend go',
      grants: { web: http.grant('all', undefined) },
    }).deliver({ name: 'go' });
    expect(failures(operationalReports(g.pump(now).reports))).toEqual([]);
    pending!.fail(new ScriptError('teapot', 'short and stout'));
    const { reports } = g.pump(now);
    expect(kinds(operationalReports(reports))).toEqual([
      'call failed',
      'run end',
    ]);
    const [failed] = failures(reports);
    expect(failed).toMatchObject({
      call: pending!.id,
      operation: { capability: 'http', operation: 'fetch' },
    });
    expect(failed!.kind === 'call failed' && failed!.detail).toContain(
      'teapot',
    );
  });

  test('a declared failure is an ordinary Error, with no report', () => {
    const db = defineCapability('db', {
      get: {
        mode: 'immediate',
        cost: { fuel: 1 },
        errors: [{ code: 'not found' }],
        do: () => {
          throw new ScriptError('not found', 'no such row');
        },
      },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask db to get\nend go',
      grants: { db: db.grant('all', undefined) },
    }).deliver({ name: 'go' });
    expect(kinds(operationalReports(g.pump(now).reports))).toEqual(['run end']);
  });
});

describe('the next deadline', () => {
  test('a Pump gives the earliest deadline the next Pump could fire, as its `pumped` record does', () => {
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    const s = g.load({
      name: 's',
      source: 'on go n\n  wait n\nend go',
    });
    expect(g.pump(now).nextDeadline).toBeUndefined();
    s.deliver({ name: 'go', args: [quantity(dec('30'), 's')] });
    s.deliver({ name: 'go', args: [quantity(dec('5'), 's')] });
    expect(g.pump(now).nextDeadline).toBe(later(5));
    expect(lines.at(-1)).toEndWith(' next=2026-09-30T09:00:05Z');
    expect(g.pump(later(5)).nextDeadline).toBe(later(30));
    expect(g.pump(later(30)).nextDeadline).toBeUndefined();
  });
});

// The last `raise` or `fault` record's `at` and `pos`, as a Location's parts.
const lastPosition = (lines: string[], record: 'raise' | 'fault') => {
  const line = lines.filter(l => l.startsWith(`${record} `)).at(-1)!;
  const [, unit, pc] = / at=([^ :]+):(\d+)/.exec(line)!;
  const [, row, col] = / pos=(\d+):(\d+)/.exec(line)!;
  return { unit: unit!, pc: Number(pc), line: Number(row), col: Number(col) };
};

describe('run end reports', () => {
  test('an errored Run gives its error as a ScriptError, and where it went uncaught', () => {
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    g.load({
      name: 's',
      source:
        'on go\n  try\n    put 1 / 0 into x\n  finally\n    try\n      throw {code: "inner"}\n    catch e\n    end try\n  end try\nend go',
    }).deliver({ name: 'go' });
    const [end] = operationalReports(g.pump(now).reports);
    expect(end).toMatchObject({ kind: 'run end', outcome: 'errored' });
    if (end?.kind !== 'run end') {
      throw new Error('no run end');
    }
    expect(end.error).toBeInstanceOf(ScriptError);
    expect(end.error!.code).toBe('division by zero');
    expect(end.error!.message).toBeString();
    // Its other fields are its data, `at` among them; never `code` or `message`.
    expect(end.error!.data.get('at').get('line').toString()).toBe('3');
    expect(end.error!.data.get('code').kind).toBe('nothing');
    // The uncaught raise is the rethrow at the `finally`'s end, not the inner one.
    expect(end.at).toEqual({ ...lastPosition(lines, 'raise'), handler: 'go' });
    expect(end.at!.line).not.toBe(6);
  });

  test("a Limit Fault gives its limit's name and its faulting instruction", () => {
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    g.load({
      name: 's',
      source:
        'on go\n  put 0 into n\n  repeat forever\n    add 1 to n\n  end repeat\nend go',
    }).deliver({ name: 'go', limits: { fuelPerRun: 50 } });
    const [end] = operationalReports(g.pump(now).reports);
    expect(end).toMatchObject({
      kind: 'run end',
      outcome: 'limit fault',
      limit: 'fuel',
    });
    expect(end?.kind === 'run end' && end.at).toEqual({
      ...lastPosition(lines, 'fault'),
      handler: 'go',
    });
  });

  test('a completed Run has no error or position', () => {
    const g = newGroup({ name: 'g' });
    g.load({ name: 's', source: 'on go\n  return 1\nend go' }).deliver({
      name: 'go',
    });
    const [end] = operationalReports(g.pump(now).reports);
    expect(end).not.toHaveProperty('error');
    expect(end).not.toHaveProperty('at');
  });
});

describe('unhandled reports', () => {
  test('a Delivery to an object gives the object it was delivered to', () => {
    const room = defineObjectKind<null>({ name: 'room', props: {} });
    const g = newGroup({ name: 'g' });
    const hall = g.object(room, 'hall', null);
    g.load({ name: 's', source: 'on other\nend other', owner: hall });
    g.deliver(hall, { name: 'knock' });
    const report = operationalReports(g.pump(now).reports).find(
      r => r.kind === 'unhandled',
    );
    expect(report).toMatchObject({ kind: 'unhandled' });
    expect(report?.kind === 'unhandled' && report.target).toBe(hall);
  });

  test('a Delivery addressed to a Script has no target', () => {
    const g = newGroup({ name: 'g' });
    g.load({ name: 's', source: 'on other\nend other' }).deliver({
      name: 'knock',
    });
    const report = operationalReports(g.pump(now).reports).find(
      r => r.kind === 'unhandled',
    );
    expect(report).toMatchObject({ kind: 'unhandled' });
    expect(report).not.toHaveProperty('target');
  });
});

describe('Inspection', () => {
  test('a suspended Run says what it waits for, as its `seg` record does', () => {
    let pending: Call<unknown> | undefined;
    const http = defineCapability('http', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 1 },
        start: call => {
          pending = call;
        },
      },
    });
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source: [
        'on nap',
        '  wait 5 s',
        'end nap',
        'on fetch',
        '  ask web to fetch and wait',
        'end fetch',
        'on watch',
        '  wait for ping or 10 s',
        'end watch',
        'on both',
        '  wait for all',
        '    ask web to fetch and wait',
        '    ask web to fetch and wait',
        '  end wait',
        'end both',
      ].join('\n'),
      grants: { web: http.grant('all', undefined) },
    });
    for (const name of ['nap', 'fetch', 'watch', 'both']) {
      s.deliver({ name });
    }
    g.pump(now);
    const runs = g.inspect().scripts[0]!.runs;
    expect(runs.map(r => [r.handler, r.status, r.wait])).toEqual([
      ['nap', 'suspended', 'wait'],
      ['fetch', 'suspended', 'ask-wait'],
      ['watch', 'suspended', 'wait-for'],
      ['both', 'suspended', 'join-end'],
    ]);
    expect(runs.map(r => r.until)).toEqual([
      later(5),
      undefined,
      later(10),
      undefined,
    ]);
    expect(runs[0]).not.toHaveProperty('calls');
    expect(runs[1]!.calls).toEqual(['s/r2.c1']);
    expect(runs[3]!.calls).toEqual(['s/r4.c1', 's/r4.c2']);
    // An answered member is no longer waited for.
    pending!.answer(text('done'));
    g.pump(now);
    expect(g.inspect().scripts[0]!.runs.at(-1)!.calls).toEqual(['s/r4.c1']);
  });

  test('a ready or preempted Run, and a mailbox message, carry no empty fields', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'on spin\n  put 0 into n\n  repeat 100 times\n    add 1 to n\n  end repeat\nend spin',
    });
    s.deliver({ name: 'spin' });
    s.deliver({ name: 'spin' });
    g.pump(now, { fuelSlice: 20 });
    const [view] = g.inspect().scripts;
    expect(view!.runs[0]).toEqual({
      id: 's/r1',
      status: 'preempted',
      handler: 'spin',
    });
    expect(view!.mailbox).toHaveLength(1);
    expect(view!.mailbox[0]).toHaveProperty('delivery');
    expect(view!.mailbox[0]).not.toHaveProperty('from');
  });
});
