// Asynchronous charge requests (spec/embedding/metered-operations.md).
import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  HostError,
  newGroup,
  restore,
  shape,
  text,
  type Call,
  type ChargeResult,
  type Report,
} from '../src/index';

const setup = (o: {
  fuelPerRun?: number;
  metering?: 'read-only';
  source?: string;
}) => {
  const lines: string[] = [];
  const calls: Call<void>[] = [];
  const remote = defineCapability('remote', {
    read: {
      mode: 'suspending',
      cost: { fuel: 0 },
      result: shape.text,
      ...(o.metering ? { metering: o.metering } : {}),
      start: c => {
        calls.push(c);
      },
    },
  });
  const grant = remote.grant('all', undefined);
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const source = o.source ?? 'on go\n ask remote to read and wait\nend go';
  const script = group.load({
    name: 's',
    source,
    grants: { remote: grant },
  });
  script.deliver({
    name: 'go',
    ...(o.fuelPerRun ? { limits: { fuelPerRun: o.fuelPerRun } } : {}),
  });
  const first = group.pump(0n);
  // The Fuel the Run spent reaching its call.
  const base = runFuel(first.reports)[0] ?? 0;
  return { lines, calls, group, script, grant, base };
};

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (error) {
    return error instanceof HostError ? error.code : String(error);
  }
  return null;
};

const charges = (reports: Report[]) =>
  reports.filter((r): r is ChargeResult => r.kind === 'charge result');

const runFuel = (reports: Report[]) =>
  reports.flatMap(r => (r.kind === 'run accounting' ? [r.fuel] : []));

describe('admission', () => {
  test('ids are Group-wide and in enqueue order; only a Pump records outcomes', () => {
    const { calls, group, lines } = setup({ metering: 'read-only' });
    const first = calls[0]!.requestCharge(3);
    expect(first.id).toBe('q1');
    const before = lines.length;
    const result = group.pump(0n);
    expect(lines[before]).toBe('> charge-request s/r1.c1 q1 fuel=3');
    expect(lines[before + 1]).toStartWith('> pump ');
    expect(charges(result.reports)).toEqual([
      {
        kind: 'charge result',
        request: 'q1',
        call: 's/r1.c1',
        fuel: 3,
        status: 'accepted',
      },
    ]);
    expect(lines.slice(before)).toContain(
      'charge-result s/r1.c1 q1 fuel=3 status=accepted',
    );
    expect(calls[0]!.requestCharge(1).id).toBe('q2');
  });

  test('an ineligible call, invalid amount or overlap is refused with no id', () => {
    const plain = setup({});
    expect(codeOf(() => plain.calls[0]!.requestCharge(1))).toBe(
      'invalid value',
    );
    expect(plain.lines.slice(-2)).toEqual([
      '> charge-request s/r1.c1 fuel=1',
      'refused code="invalid value"',
    ]);

    const { calls, group, lines } = setup({ metering: 'read-only' });
    for (const fuel of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(codeOf(() => calls[0]!.requestCharge(fuel))).toBe('invalid value');
      expect(lines.slice(-2)).toEqual([
        '> charge-request s/r1.c1 fuel="invalid"',
        'refused code="invalid value"',
      ]);
    }
    expect(calls[0]!.requestCharge(0).id).toBe('q1');
    expect(codeOf(() => calls[0]!.requestCharge(2))).toBe('invalid value');
    // Held behind q1, the overlap refusal is written after it (#1807).
    const before = lines.length;
    group.pump(0n);
    expect(lines.slice(before, before + 4)).toEqual([
      '> charge-request s/r1.c1 q1 fuel=0',
      '> charge-request s/r1.c1 fuel=2',
      'refused code="invalid value"',
      expect.stringMatching(/^> pump /),
    ]);
  });

  test('the outstanding slot clears when the future settles', async () => {
    const { calls, group } = setup({ metering: 'read-only' });
    const request = calls[0]!.requestCharge(1);
    group.pump(0n);
    expect(await request.result).toMatchObject({ status: 'accepted' });
    expect(calls[0]!.requestCharge(1).id).toBe('q2');
  });

  test('a request may be queued from the starting callback', async () => {
    const remote = defineCapability('remote', {
      read: {
        mode: 'suspending',
        cost: { fuel: 0 },
        metering: 'read-only',
        start: c => {
          void c.requestCharge(4).result.then(r => {
            if (r.status === 'accepted') {
              c.answer(text('done'));
            }
          });
        },
      },
    });
    const group = newGroup({ name: 'g' });
    group
      .load({
        name: 's',
        source: 'on go\n ask remote to read and wait\nend go',
        grants: { remote: remote.grant('all', undefined) },
      })
      .deliver({ name: 'go' });
    const first = group.pump(0n);
    expect(charges(first.reports)).toEqual([]);
    const second = group.pump(0n);
    expect(charges(second.reports)[0]!.status).toBe('accepted');
    expect(second.fuelUsed).toBe(4);
    await Promise.resolve();
    const third = group.pump(0n);
    expect(third.reports).toContainEqual(
      expect.objectContaining({ kind: 'run end', outcome: 'completed' }),
    );
  });
});

describe('outcomes', () => {
  test('accepted Fuel is spent at once, with no Stretch', () => {
    const { calls, group, lines, base } = setup({ metering: 'read-only' });
    calls[0]!.requestCharge(5);
    const before = lines.length;
    const result = group.pump(0n);
    expect(result.fuelUsed).toBe(5);
    expect(runFuel(result.reports)).toEqual([base + 5]);
    expect(lines.slice(before).some(line => line.startsWith('seg'))).toBe(
      false,
    );
    expect(group.inspect().scripts[0]!.runs).toHaveLength(1);
  });

  test('a request the Run can’t pay faults it at the call, with no Stretch', async () => {
    const { calls, group, lines } = setup({
      metering: 'read-only',
      fuelPerRun: 100,
    });
    const request = calls[0]!.requestCharge(1000);
    const before = lines.length;
    const result = group.pump(0n);
    const out = lines.slice(before);
    expect(out.some(line => line.startsWith('seg'))).toBe(false);
    const at = out.findIndex(line => line.startsWith('charge-result'));
    expect(out[at]).toBe('charge-result s/r1.c1 q1 fuel=1000 status=limit');
    expect(out[at + 1]).toMatch(/^fault s\/r1 limit=fuel at=s:\d+ pos=2:\d+/);
    expect(out[at + 2]).toBe('abandon s/r1.c1');
    expect(out[at + 3]).toMatch(/^run s\/r1 outcome=limit-fault/);
    expect(result.reports.map(r => r.kind).slice(0, 2)).toEqual([
      'charge result',
      'run end',
    ]);
    expect(result.reports[1]).toMatchObject({
      outcome: 'limit fault',
      limit: 'fuel',
      at: { line: 2 },
    });
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(group.inspect().scripts[0]!.runs).toEqual([]);
    expect((await request.result).status).toBe('limit');
  });

  test('Join Members share the Run allowance; the first unaffordable request ends the Run', () => {
    const { calls, group, lines, base } = setup({
      metering: 'read-only',
      fuelPerRun: 100,
      source:
        'on go\n wait for all\n  ask remote to read and wait\n  ask remote to read and wait\n end wait\nend go',
    });
    expect(calls.map(c => c.id)).toEqual(['s/r1.c1', 's/r1.c2']);
    // The second member's request takes exactly what is left.
    calls[1]!.requestCharge(100 - base);
    calls[0]!.requestCharge(1);
    const before = lines.length;
    const result = group.pump(0n);
    expect(charges(result.reports).map(r => [r.call, r.status])).toEqual([
      ['s/r1.c2', 'accepted'],
      ['s/r1.c1', 'limit'],
    ]);
    const out = lines.slice(before);
    expect(out.find(line => line.startsWith('fault'))).toMatch(/pos=3:/);
    expect(calls.every(c => c.signal.aborted)).toBe(true);
    expect(group.inspect().scripts[0]!.runs).toEqual([]);
  });

  test('requests drain in order with answers, and are inactive after Stop or the call’s end', () => {
    for (const end of ['answer', 'stop', 'reload', 'ended'] as const) {
      const { calls, group, script } = setup({ metering: 'read-only' });
      if (end === 'reload') {
        // Reload ends the call before the queued request drains.
        calls[0]!.requestCharge(7);
        script.reload('on go\nend go', 'reset variables');
        const result = group.pump(0n);
        expect(charges(result.reports)[0]!.status).toBe('inactive');
        expect(result.fuelUsed).toBe(0);
        continue;
      }
      if (end === 'ended') {
        calls[0]!.answer(text('x'));
        group.pump(0n);
      }
      if (end === 'stop') {
        script.stop('done');
      }
      calls[0]!.requestCharge(7);
      if (end === 'answer') {
        calls[0]!.answer(text('x'));
      }
      const result = group.pump(0n);
      // Inputs drain in order: an answer queued after the request is too
      // late to make it inactive.
      expect(charges(result.reports)[0]).toMatchObject({
        call: 's/r1.c1',
        status: end === 'answer' ? 'accepted' : 'inactive',
      });
      if (end !== 'answer') {
        expect(result.fuelUsed).toBe(0);
      }
    }
  });

  test('an answer queued before the request leaves it inactive', () => {
    const { calls, group } = setup({ metering: 'read-only' });
    calls[0]!.answer(text('x'));
    calls[0]!.requestCharge(7);
    const result = group.pump(0n);
    expect(charges(result.reports)[0]!.status).toBe('inactive');
  });
});

describe('saves', () => {
  test('a pending metered call or unresolved request refuses the save', () => {
    const { calls, group, lines } = setup({ metering: 'read-only' });
    expect(() => group.save()).toThrow('effects pending');
    expect(lines.at(-1)).toBe('refused code="effects pending"');
    calls[0]!.requestCharge(1);
    calls[0]!.answer(text('x'));
    expect(() => group.save()).toThrow('effects pending');
    group.pump(0n);
    expect(() => group.save()).not.toThrow();
  });

  test('the request counter and issued eligibility survive a save', () => {
    const { calls, group, script, grant } = setup({ metering: 'read-only' });
    calls[0]!.requestCharge(1);
    calls[0]!.answer(text('x'));
    group.pump(0n);
    const { group: copy } = restore(group.save(), {
      name: 'g',
      libraries: [],
      grants: () => grant,
      resolve: () => undefined,
      onMismatch: 'reject',
    });
    copy.script('s')!.deliver({ name: 'go' });
    copy.pump(0n);
    // The restored Group made a second call on its own Grant's Host.
    expect(calls.map(c => c.id)).toEqual(['s/r1.c1', 's/r2.c1']);
    expect(calls[1]!.requestCharge(1).id).toBe('q2');
    expect(script.name).toBe('s');
  });
});

// A Group's Fingerprint with one suspending Operation, metered or not.
const fingerprint = (metering: boolean) => {
  const remote = defineCapability('remote', {
    read: {
      mode: 'suspending',
      cost: { fuel: 0 },
      ...(metering ? { metering: 'read-only' as const } : {}),
      start: () => {},
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\nend go',
    grants: { remote: remote.grant('all', undefined) },
  });
  return Buffer.from(g.fingerprint()).toString('hex');
};

describe('declarations', () => {
  for (const [name, op] of [
    ['fire-and-forget', { mode: 'fire-and-forget', fire: () => {} }],
    [
      'segment-bound suspending',
      { mode: 'suspending', start: () => {}, metering: 'segment-bound' },
    ],
    ['unknown value', { mode: 'immediate', do: () => {}, metering: 'yes' }],
    [
      'segment-bound without segmentBound',
      { mode: 'immediate', do: () => {}, metering: 'segment-bound' },
    ],
  ] as const) {
    test(`${name} metering is invalid value`, () => {
      expect(
        codeOf(() =>
          defineCapability('bad', {
            op: {
              cost: { fuel: 0 },
              ...op,
              metering: 'metering' in op ? op.metering : 'read-only',
            },
          } as never),
        ),
      ).toBe('invalid value');
    });
  }

  test('metering changes the Group Fingerprint', () => {
    expect(fingerprint(true)).not.toBe(fingerprint(false));
  });
});

// An immediate Operation charging 13, 17, then more than the Run has.
const refusing = (metering: boolean, suppress: boolean) => {
  const lines: string[] = [];
  const api = defineCapability('api', {
    fetch: {
      mode: 'immediate',
      cost: { fuel: 0 },
      ...(metering ? { metering: 'read-only' as const } : {}),
      do: call => {
        for (const fuel of [0, 13, 17, 1_000_000]) {
          try {
            call.charge(fuel);
          } catch (error) {
            if (!suppress) {
              throw error;
            }
          }
        }
        return text('done');
      },
    },
  });
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  g.load({
    name: 's',
    source: 'on go\n  ask api to fetch\n  return it\nend go',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go', limits: { fuelPerRun: 100 } });
  const result = g.pump(0n);
  return {
    call: lines.find(line => line.startsWith('call ')),
    end: result.reports.find(r => r.kind === 'run end'),
  };
};

describe('synchronous refusal', () => {
  for (const suppress of [false, true]) {
    test(`a metered call records its refusal after the accepted prefix${suppress ? ', even suppressed' : ''}`, () => {
      const { call, end } = refusing(true, suppress);
      expect(call).toBe(
        'call s/r1.c1 op=api.fetch args=[] charged=30 charge-refused=yes',
      );
      expect(end).toMatchObject({ outcome: 'limit fault', limit: 'fuel' });
    });
  }

  test('an unmetered call keeps its legacy record', () => {
    expect(refusing(false, false).call).toBe(
      'call s/r1.c1 op=api.fetch args=[] charged=30',
    );
  });
});

describe('a preempted Join body', () => {
  test('a limit rolls back its open Segment, with no Stretch', () => {
    const lines: string[] = [];
    const calls: Call<void>[] = [];
    const remote = defineCapability('remote', {
      read: {
        mode: 'suspending',
        cost: { fuel: 0 },
        metering: 'read-only',
        start: c => {
          calls.push(c);
        },
      },
    });
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    g.load({
      name: 's',
      source:
        'script variable results = []\non go\n  put 1 after results\n  wait for all\n    ask remote to read and wait\n    ask remote to read and wait\n  end wait\nend go',
      grants: { remote: remote.grant('all', undefined) },
    }).deliver({ name: 'go', limits: { fuelPerRun: 100 } });
    // The slice preempts the body after both members start.
    g.pump(0n, { fuelSlice: 35 });
    expect(calls).toHaveLength(2);
    expect(g.inspect().scripts[0]!.runs[0]!.status).toBe('preempted');
    calls[1]!.requestCharge(1_000_000);
    const before = lines.length;
    const result = g.pump(0n);
    const out = lines.slice(before);
    expect(out.some(line => /^(seg|preempt) /.test(line))).toBe(false);
    expect(out.find(line => line.startsWith('fault'))).toMatch(
      /^fault s\/r1 limit=fuel at=s:\d+ pos=6:\d+ rollback=\[results]$/,
    );
    expect(out.filter(line => line.startsWith('abandon'))).toEqual([
      'abandon s/r1.c1',
      'abandon s/r1.c2',
    ]);
    expect(calls.every(c => c.signal.aborted)).toBe(true);
    expect(result.reports).toContainEqual(
      expect.objectContaining({ kind: 'run end', outcome: 'limit fault' }),
    );
    const vars = g.inspect().scripts[0]!.vars;
    expect(vars.map(([name, value]) => [name, value.toString()])).toEqual([
      ['results', '[]'],
    ]);
  });
});
