import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  newGroup,
  nothing,
  shape,
  text,
  parseInstant,
  ScriptError,
  HostError,
  restore,
  exportManifest,
  type Call,
  type Operation,
  type Shape,
  type Group,
  type Grant,
  compileLibrary,
  defineObjectKind,
  dec,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
const recordingHost = (
  options: {
    close?: (call: Call<string>) => unknown;
    open?: (call: Call<string>) => unknown;
    openResult?: Shape;
  } = {},
) => {
  const calls: { call: Call<string>; op: string }[] = [];
  const live = new Map<object, Set<string>>();
  const ops: Record<string, Operation<string>> = {};
  for (const name of ['file', 'lock']) {
    ops[`open${name}`] = {
      mode: 'immediate',
      args: [],
      result: options.openResult ?? shape.nothing,
      cost: { fuel: 1 },
      scope: { opens: name, abandon: `close${name}` },
      do: call => {
        calls.push({ op: `open${name}`, call });
        const owned = live.get(call.group) ?? new Set<string>();
        const key = `${call.scriptName}/${call.runId}/${call.grantName}/${call.scopeName}`;
        expect(owned.has(key)).toBe(false);
        owned.add(key);
        live.set(call.group, owned);
        return (options.open?.(call) ?? nothing) as typeof nothing;
      },
    };
    ops[`close${name}`] = {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 1000, alloc: 1000 },
      scope: { closes: name },
      do: call => {
        calls.push({ op: `close${name}`, call });
        const result = options.close?.(call) ?? nothing;
        const key = `${call.scriptName}/${call.runId}/${call.grantName}/${call.scopeName}`;
        expect(live.get(call.group)?.delete(key)).toBe(true);
        return result as typeof nothing;
      },
    };
  }
  ops.later = {
    mode: 'suspending',
    args: [],
    cost: { fuel: 0 },
    start: call => {
      calls.push({ op: 'later', call });
    },
  };
  ops.note = {
    mode: 'immediate',
    args: [],
    cost: { fuel: 0 },
    do: call => {
      calls.push({ op: 'note', call });
      return nothing;
    },
  };
  return { cap: defineCapability('resource', ops), calls, live };
};
const start = (
  body: string,
  host = recordingHost(),
  options: { grantsAsUsed?: boolean; limits?: object } = {},
) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const source = `on go\n${body}\nend go`;
  const grant = host.cap.grant('all', 'shared');
  const script = group.load({
    name: 's',
    source,
    grants: { r: grant },
    ...options,
  });
  script.deliver({ name: 'go' });
  return { group, script, host, lines, source, grant };
};
const errorCode = (group: Group) => {
  const report = group.pump(now).reports.find(r => r.kind === 'run end');
  return report?.kind === 'run end' ? report.error?.code : undefined;
};

describe('Capability Scopes', () => {
  test.each([
    ['ask r to closefile', 'scope not open', 8],
    ['ask r to openfile\nask r to openfile', 'scope already open', 21],
    ['ask r to openfile\nwait 0 ms', 'scope open', 22],
    ['ask r to openfile\nwait for ping', 'scope open', 21],
    [
      'ask r to openfile\nwait for\nafter 0 ms then\nend wait',
      'scope open',
      22,
    ],
    ['ask r to openfile\nsend ping to me and wait', 'scope open', 22],
    ['ask r to openfile\nask r to later and wait', 'scope open', 21],
    [
      'ask r to openfile\nwait for all\nif false then ask r to later and wait\nend wait',
      'scope open',
      21,
    ],
    [
      'wait for all\nask r to openfile\nask r to later and wait\nend wait',
      'scope in join',
      18,
    ],
  ])(
    '%s rejects without the guarded instruction charge',
    (body, code, fuel) => {
      const { group } = start(body);
      const result = group.pump(now);
      expect(result.reports).toContainEqual(
        expect.objectContaining({ error: expect.objectContaining({ code }) }),
      );
      // Dispatch and popped-frame unwind still cost 4 each. Acquisition costs
      // 12 plus its 1-Fuel store into `it`; Join entry costs 10 when it is allowed.
      expect(result.fuelUsed).toBe(fuel);
    },
  );
  test('a guarded first instruction still pays local Handler dispatch', () => {
    const host = recordingHost();
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      grants: { r: host.cap.grant('all', 'x') },
      source:
        'on go\nask r to openfile\nhelper and wait\nend go\non helper\nwait for ping\nend helper',
    });
    script.deliver({ name: 'go' });
    const result = group.pump(now);
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'scope open' }),
      }),
    );
    // 4 outer dispatch + 12 acquisition + 1 store into `it` + 8 local call
    // + 4 helper dispatch + 8 for unwinding both frames.
    expect(result.fuelUsed).toBe(37);
  });
  test('a caught guard at the first instruction pays dispatch before preemption', () => {
    const { group, host } = start(
      'try\nask r to closefile\ncatch e\nreturn 1\nend try',
    );
    const result = group.pump(now, { fuelSlice: 4, fuelCap: 4 });
    expect(result.state).toBe('sliced');
    expect(result.fuelUsed).toBe(4);
    expect(result.reports).toEqual([]);
    expect(host.calls).toEqual([]);
    expect(group.pump(now).reports).toContainEqual(
      expect.objectContaining({ outcome: 'completed', result: dec('1') }),
    );
  });
  test('a scope rejection fits a budget covering only dispatch and unwind', () => {
    const { group } = start('ask r to closefile', recordingHost(), {
      limits: { fuelPerRun: 8 },
    });
    const result = group.pump(now);
    expect(result.fuelUsed).toBe(8);
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'scope not open' }),
      }),
    );
  });
  test('dispatch can exhaust Fuel before a first-instruction scope rejection', () => {
    const { group, host } = start('ask r to closefile', recordingHost(), {
      limits: { fuelPerRun: 3 },
    });
    const result = group.pump(now);
    expect(result.fuelUsed).toBe(0);
    expect(result.reports).toContainEqual(
      expect.objectContaining({ outcome: 'limit fault', limit: 'fuel' }),
    );
    expect(host.calls).toEqual([]);
  });
  test('a guarded waiting send allocates no message', () => {
    const { group } = start('ask r to openfile\nsend ping to me and wait');
    expect(group.pump(now).reports).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'scope open' }),
        // Only the successful opener's Nothing result is converted.
        alloc: 8,
      }),
    );
  });
  test('a caught first-instruction Grant rejection still pays dispatch', () => {
    const { group, script, host } = start(
      'try\nask r to closefile\ncatch e\nreturn 1\nend try',
    );
    script.revoke('r');
    const result = group.pump(now, { fuelSlice: 4, fuelCap: 4 });
    expect(result.state).toBe('sliced');
    expect(result.fuelUsed).toBe(4);
    expect(host.calls).toEqual([]);
    expect(group.pump(now).reports).toContainEqual(
      expect.objectContaining({ outcome: 'completed', result: dec('1') }),
    );
  });
  test('local call depth faults before its charge with an open scope', () => {
    const host = recordingHost();
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      grants: { r: host.cap.grant('all', 'x') },
      source:
        'on go\nask r to openfile\nhelper and wait\nend go\non helper\nwait for ping\nend helper',
      limits: { callDepth: 1 },
    });
    script.deliver({ name: 'go' });
    const result = group.pump(now);
    expect(result.fuelUsed).toBe(17);
    expect(result.reports).toContainEqual(
      expect.objectContaining({ outcome: 'limit fault', limit: 'depth' }),
    );
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test('explicit close, independent closes and reopening preserve resource ownership', () => {
    const { group, host } = start(
      'ask r to openfile\nask r to openlock\nask r to closefile\nask r to openfile',
    );
    group.pump(now);
    expect(host.calls.map(c => [c.op, c.call.automatic])).toEqual([
      ['openfile', false],
      ['openlock', false],
      ['closefile', false],
      ['openfile', false],
      ['closefile', true],
      ['closelock', true],
    ]);
    expect([...host.live.values()].every(s => s.size === 0)).toBe(true);
    expect(host.calls[0]!.call).toMatchObject({
      group,
      scriptName: 's',
      runId: 's/r1',
      grantName: 'r',
      segmentId: 's/r1.s1',
      scopeName: 'file',
    });
  });
  test.each([
    [
      'ask r to openfile\nask r to openfile',
      'scope already open',
      ['openfile', 'closefile'],
    ],
    ['ask r to closefile', 'scope not open', []],
    ['ask r to openfile\nwait 0 ms', 'scope open', ['openfile', 'closefile']],
    [
      'ask r to openfile\nask r to later and wait',
      'scope open',
      ['openfile', 'closefile'],
    ],
    [
      'ask r to openfile\nwait for all\nif false then ask r to later and wait\nend wait',
      'scope open',
      ['openfile', 'closefile'],
    ],
    [
      'wait for all\nask r to openfile\nask r to later and wait\nend wait',
      'scope in join',
      [],
    ],
  ])('%s rejects before Host work', (body, code, calls) => {
    const { group, host } = start(body);
    expect(errorCode(group)).toBe(code);
    expect(host.calls.map(c => c.op)).toEqual(calls);
  });
  test('malformed acquisition result still abandons before the errored Run report', () => {
    const { group, host, lines } = start(
      'ask r to openfile',
      recordingHost({ open: () => text('wrong') }),
    );
    expect(errorCode(group)).toBe('host error');
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    expect(lines.findIndex(l => l.includes('action=opened'))).toBeGreaterThan(
      lines.findIndex(l => l.startsWith('call ')),
    );
    expect(lines.findIndex(l => l.includes('action=abandoned'))).toBeLessThan(
      lines.findIndex(l => l.startsWith('run ')),
    );
  });
  test('conversion exhaustion after acquisition abandons without charging cleanup', () => {
    const { group, host } = start(
      'ask r to openfile',
      recordingHost({
        openResult: shape.text,
        open: () => text('x'.repeat(2000)),
      }),
      { limits: { allocPerRun: 500 } },
    );
    expect(group.pump(now).reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        outcome: 'limit fault',
        limit: 'alloc',
      }),
    );
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    expect(host.live.get(group)?.size).toBe(0);
  });
  test.each([
    'wait "bad"',
    'send ping to 1 and wait',
    'wait for ping or "bad"',
  ])('operand validation precedes scope guards: %s', boundary => {
    const { group, host } = start(`ask r to openfile\n${boundary}`);
    expect(errorCode(group)).toBe('wrong kind');
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test('successful malformed explicit closure is never abandoned again', () => {
    const { group, host } = start(
      'ask r to openfile\nask r to closefile',
      recordingHost({ close: () => text('bad') }),
    );
    expect(errorCode(group)).toBe('host error');
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    expect(host.live.get(group)?.size).toBe(0);
  });
  test('Stop queued during acquisition records ownership before discarding', () => {
    const { group, script, host } = start(
      'ask r to openfile',
      recordingHost({
        open: () => {
          script.stop('host');
          return nothing;
        },
      }),
    );
    group.pump(now);
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test.each(['open', 'close'])(
    'queued cancellation during successful %s preserves ownership transitions',
    operation => {
      const host = recordingHost({
        [operation]: () => {
          script.cancelRun('s/r1');
          return nothing;
        },
      });
      const body =
        operation === 'open'
          ? 'ask r to openfile'
          : 'ask r to openfile\nask r to closefile';
      const { group, script } = start(
        `try\n${body}\nfinally\nask r to note\nend try`,
        host,
      );
      const result = group.pump(now);
      expect(result.reports).toContainEqual(
        expect.objectContaining({ kind: 'run end', outcome: 'cancelled' }),
      );
      expect(host.calls.map(c => [c.op, c.call.automatic])).toEqual(
        operation === 'open'
          ? [
              ['openfile', false],
              ['note', false],
              ['closefile', true],
            ]
          : [
              ['openfile', false],
              ['closefile', false],
              ['note', false],
            ],
      );
      expect(host.calls.find(c => c.op === 'note')!.call.segmentId).toBe(
        's/r1.s2',
      );
    },
  );
  test('successful close followed by conversion exhaustion is not repeated', () => {
    const host = recordingHost();
    const cap = defineCapability('resource', {
      ...Object.fromEntries(host.cap.operations),
      finish: {
        mode: 'immediate',
        args: [],
        result: shape.text,
        cost: { fuel: 0 },
        scope: { closes: 'file' },
        do: (call: Call<string>) => {
          const close = host.cap.operations.get('closefile')!;
          if (close.mode === 'immediate') {
            close.do(call);
          }
          return text('x'.repeat(2000));
        },
      },
    });
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source: 'on go\nask r to openfile\nask r to finish\nend go',
      grants: { r: cap.grant('all', 'x') },
      limits: { allocPerRun: 500 },
    });
    script.deliver({ name: 'go' });
    expect(group.pump(now).reports).toContainEqual(
      expect.objectContaining({ outcome: 'limit fault', limit: 'alloc' }),
    );
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    expect(host.live.get(group)?.size).toBe(0);
  });
  test('named Grant aliases own independent slots and failed cleanup disables only its alias', () => {
    const host = recordingHost({
      close: call => {
        if (call.grantName === 'a') {
          throw new Error('broken');
        }
        return nothing;
      },
    });
    const group = newGroup({ name: 'g' });
    const grant = host.cap.grant('all', 'shared');
    const script = group.load({
      name: 's',
      grants: { a: grant, b: grant },
      source: 'on go\nask a to openfile\nask b to openfile\nend go',
    });
    script.deliver({ name: 'go' });
    group.pump(now);
    expect(host.calls.map(c => [c.op, c.call.grantName])).toEqual([
      ['openfile', 'a'],
      ['openfile', 'b'],
      ['closefile', 'b'],
      ['closefile', 'a'],
    ]);
    expect(group.inspect().scripts[0]!.disabledGrants).toEqual(['a']);
    script.revoke('a');
    script.deliver({ name: 'go' });
    expect(errorCode(group)).toBe('capability disabled');
  });
  test('Fuel Slice preemption preserves ownership and Save refuses without advancing', () => {
    const { group, host, script } = start(
      'ask r to openfile\nrepeat forever\nend repeat',
    );
    group.pump(now, { fuelSlice: 20 });
    expect(host.calls.map(c => c.op)).toEqual(['openfile']);
    expect(() => group.save()).toThrow('effects pending');
    expect(host.calls).toHaveLength(1);
    script.stop('done');
    group.pump(now);
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test('Limit Fault cleanup ignores declared costs and consumes no Script Fuel', () => {
    const { group, host, script, lines } = start(
      'ask r to openfile\nrepeat forever\nend repeat',
      recordingHost(),
      { limits: { fuelPerRun: 50, allocPerRun: 500 } },
    );
    const result = group.pump(now);
    expect(
      result.reports.some(
        r => r.kind === 'run end' && r.outcome === 'limit fault',
      ),
    ).toBe(true);
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    expect(script.counters().fuelTotal).toBeLessThanOrEqual(50);
    expect(lines.findIndex(l => l.startsWith('fault '))).toBeLessThan(
      lines.findIndex(l => l.includes('automatic=yes')),
    );
  });
  test('failed explicit close remains open for automatic abandonment', () => {
    const host = recordingHost({
      close: call => {
        if (!call.automatic) {
          throw new ScriptError('busy', 'busy');
        }
        return nothing;
      },
    });
    const { group } = start('ask r to openfile\nask r to closefile', host);
    expect(errorCode(group)).toBe('busy');
    expect(host.calls.map(c => [c.op, c.call.automatic])).toEqual([
      ['openfile', false],
      ['closefile', false],
      ['closefile', true],
    ]);
  });
  test('failed abandonment disables the named Grant and continues remaining cleanup', () => {
    const host = recordingHost({
      close: call => {
        if (call.scopeName === 'lock') {
          throw new Error('broken');
        }
        return nothing;
      },
    });
    const { group, script } = start(
      'ask r to openfile\nask r to openlock',
      host,
    );
    const result = group.pump(now);
    expect(host.calls.map(c => c.op)).toEqual([
      'openfile',
      'openlock',
      'closelock',
      'closefile',
    ]);
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        kind: 'effect failure',
        grant: 'r',
        phase: 'abandon',
        scope: 'lock',
        status: 'unknown',
      }),
    );
    script.deliver({ name: 'go' });
    expect(errorCode(group)).toBe('capability disabled');
    expect(script.grants().r).toContain('openfile');
  });
  test('automatic declared failure is recorded without converting or charging its data', () => {
    const { group, lines } = start(
      'ask r to openfile',
      recordingHost({
        close: () => {
          throw new ScriptError('busy', 'try later');
        },
      }),
    );
    const result = group.pump(now);
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        kind: 'effect failure',
        status: 'failed',
        scope: 'file',
      }),
    );
    expect(lines.find(l => l.includes('automatic=yes'))).toContain(
      'error={code: "busy", message: "try later"}',
    );
  });
  test('GrantsAsUsed retains only already granted abandonment dependencies', () => {
    const { group, script } = start('ask r to openfile', recordingHost(), {
      grantsAsUsed: true,
    });
    expect(script.grants()).toEqual({ r: ['closefile', 'openfile'] });
    group.pump(now);
    expect(() => recordingHost().cap.grant(['openfile'], 'x')).toThrow(
      HostError,
    );
  });
  test('two Groups with the same names and shared binding have independent ownership', () => {
    const host = recordingHost();
    const a = start('ask r to openfile\nrepeat forever\nend repeat', host);
    const b = start('ask r to openfile\nrepeat forever\nend repeat', host);
    a.group.pump(now, { fuelSlice: 20 });
    b.group.pump(now, { fuelSlice: 20 });
    expect(host.live.size).toBe(2);
    a.script.stop('done');
    a.group.pump(now);
    expect(host.live.get(b.group)?.size).toBe(1);
    b.script.stop('done');
    b.group.pump(now);
    expect([...host.live.values()].every(s => s.size === 0)).toBe(true);
  });
  test.each(['completion', 'error', 'cancellation', 'fault'])(
    'finally ordering for %s',
    reason => {
      const body =
        reason === 'error'
          ? 'throw {code: "bad"}'
          : reason === 'completion'
            ? 'put 1 into x'
            : 'repeat forever\nend repeat';
      const { group, script, host } = start(
        `try\nask r to openfile\n${body}\nfinally\nask r to note\nend try`,
        recordingHost(),
        { limits: { fuelPerRun: 1000 } },
      );
      group.pump(now, {
        fuelSlice: reason === 'completion' || reason === 'error' ? 1000 : 40,
      });
      if (reason === 'cancellation') {
        script.cancelRun('s/r1');
        group.pump(now);
      }
      if (reason === 'fault') {
        group.pump(now, { fuelSlice: 2000 });
      }
      expect(host.calls.map(c => c.op)).toEqual(
        reason === 'fault'
          ? ['openfile', 'closefile']
          : ['openfile', 'note', 'closefile'],
      );
    },
  );
  test('local wait-marked calls run until an executed forbidden boundary', () => {
    const host = recordingHost();
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      grants: { r: host.cap.grant('all', 'x') },
      source: `on helper flag\nif flag then wait 0 ms\nask r to note\nend helper\non go\nask r to openfile\nhelper false and wait\nhelper true and wait\nend go`,
    });
    script.deliver({ name: 'go' });
    expect(errorCode(group)).toBe('scope open');
    expect(host.calls.map(c => c.op)).toEqual([
      'openfile',
      'note',
      'closefile',
    ]);
  });
  test('waiting sends fail before receiver work', () => {
    const { group, host } = start(
      'ask r to openfile\nsend ping to other and wait',
    );
    group.load({ name: 'other', source: 'on ping\nreturn 1\nend ping' });
    expect(errorCode(group)).toBe('scope open');
    expect(group.inspect().scripts.find(s => s.name === 'other')?.runs).toEqual(
      [],
    );
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test('revocation cannot revoke reserved cleanup authority', () => {
    const host = recordingHost({
      open: () => {
        script.revoke('r');
        return nothing;
      },
    });
    const { group, script } = start(
      'ask r to openfile\nrepeat forever\nend repeat',
      host,
    );
    group.pump(now, { fuelSlice: 20 });
    script.stop('done');
    group.pump(now);
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test('owner disposal abandons preempted resources', () => {
    const host = recordingHost();
    const group = newGroup({ name: 'g' });
    const owner = group.object(
      defineObjectKind({ name: 'widget', props: {} }),
      'o',
      undefined,
    );
    const script = group.load({
      name: 's',
      source: 'on go\nask r to openfile\nrepeat forever\nend repeat\nend go',
      owner,
      grants: { r: host.cap.grant('all', 'x') },
    });
    script.deliver({ name: 'go' });
    group.pump(now, { fuelSlice: 20 });
    group.dispose(owner);
    group.pump(now);
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test('Reload validates first, cleans before publication, refuses callback reentry and carries rolled-back variables', () => {
    let reentry = false;
    const host = recordingHost({
      close: () => {
        try {
          group.save();
        } catch (error) {
          reentry =
            error instanceof HostError && error.code === 'reentrant call';
        }
        return nothing;
      },
    });
    const group = newGroup({ name: 'g' });
    const source =
      'script variable v = 1\non go\nput 2 into v\nask r to openfile\nrepeat forever\nend repeat\nend go';
    const script = group.load({
      name: 's',
      source,
      grants: { r: host.cap.grant('all', 'x') },
    });
    script.deliver({ name: 'go' });
    group.pump(now, { fuelSlice: 40 });
    expect(() => script.reload('on', 'carry variables')).toThrow();
    expect(host.calls.map(c => c.op)).toEqual(['openfile']);
    script.reload(
      'script variable v = 3\non go\nreturn v\nend go',
      'carry variables',
    );
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    expect(reentry).toBe(true);
    expect(group.inspect().scripts[0]!.vars[0]![1].equals(dec('1'))).toBe(true);
  });
  test('outside-Pump cleanup defers readiness notifications until replacement is published', async () => {
    const failures: string[] = [];
    const host = recordingHost({
      close: () => {
        script.deliver({ name: 'ping' });
        return nothing;
      },
    });
    const group = newGroup({
      name: 'g',
      onReady: () => {
        try {
          group.inspect();
        } catch (error) {
          failures.push((error as HostError).code);
        }
      },
    });
    const script = group.load({
      name: 's',
      grants: { r: host.cap.grant('all', 'x') },
      source: 'on go\nask r to openfile\nrepeat forever\nend repeat\nend go',
    });
    script.deliver({ name: 'go' });
    group.pump(now, { fuelSlice: 20 });
    script.reload('on ping\nreturn 1\nend ping', 'carry variables');
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
  });
  test.each(['reject', 'variables only'] as const)(
    'disablement survives %s restore and Reload',
    policy => {
      const host = recordingHost({
        close: () => {
          throw new Error('broken');
        },
      });
      const { group, script, source, grant } = start('ask r to openfile', host);
      group.pump(now);
      const altered = defineCapability(
        'resource',
        Object.fromEntries(
          [...host.cap.operations].map(([name, op]) => [
            name,
            { ...op, cost: { fuel: op.cost.fuel + 1 } },
          ]),
        ),
      );
      const grants: Record<string, Grant<string>> = {
        r: policy === 'variables only' ? altered.grant('all', 'shared') : grant,
      };
      const { group: copy, result: restored } = restore(group.save(), {
        name: 'copy',
        onMismatch: policy,
        grants: (_script, name) => grants[name],
        resolve: () => undefined,
        libraries: [],
      });
      expect(restored.variablesOnly).toBe(policy === 'variables only');
      copy.script('s')!.deliver({ name: 'go' });
      expect(errorCode(copy)).toBe('capability disabled');
      expect(copy.inspect().scripts[0]!.disabledGrants).toEqual(['r']);
      script.reload(source, 'carry variables');
      script.deliver({ name: 'go' });
      expect(errorCode(group)).toBe('capability disabled');
    },
  );
  test('replacement cleans resources and keeps disablement', () => {
    const host = recordingHost({
      close: () => {
        throw new Error('broken');
      },
    });
    const group = newGroup({ name: 'g' });
    group.addLibrary(
      compileLibrary({
        name: 'lib',
        version: '1',
        source: 'function one\nreturn 1\nend one',
      }),
    );
    const script = group.load({
      name: 's',
      grants: { r: host.cap.grant('all', 'x') },
      source:
        'use one from lib\non go\nask r to openfile\nrepeat forever\nend repeat\nend go',
    });
    script.deliver({ name: 'go' });
    group.pump(now, { fuelSlice: 20 });
    group.replaceLibrary(
      compileLibrary({
        name: 'lib',
        version: '2',
        source: 'function one\nreturn 2\nend one',
      }),
      'carry variables',
    );
    expect(host.calls.map(c => c.op)).toEqual(['openfile', 'closefile']);
    script.deliver({ name: 'go' });
    expect(errorCode(group)).toBe('capability disabled');
  });
  test('restoring a retained closer needs no ungranted opener', () => {
    const { group, script, grant } = start(
      'ask r to closefile',
      recordingHost(),
      { grantsAsUsed: true },
    );
    expect(errorCode(group)).toBe('scope not open');
    expect(script.grants()).toEqual({ r: ['closefile'] });
    const { group: copy } = restore(group.save(), {
      name: 'copy',
      onMismatch: 'reject',
      grants: () => grant,
      resolve: () => undefined,
      libraries: [],
    });
    copy.script('s')!.deliver({ name: 'go' });
    expect(errorCode(copy)).toBe('scope not open');
  });
  test('attempting Charge during automatic cleanup disables even if the Host catches it', () => {
    const { group } = start(
      'ask r to openfile',
      recordingHost({
        close: call => {
          try {
            call.charge(1);
          } catch {
            // Even a swallowed Charge attempt violates reserved cleanup.
          }
          return nothing;
        },
      }),
    );
    const result = group.pump(now);
    expect(result.reports.some(r => r.kind === 'effect failure')).toBe(true);
    expect(group.inspect().scripts[0]!.disabledGrants).toEqual(['r']);
  });
});

describe('scope declarations', () => {
  const immediate = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    do: () => nothing,
  };
  test.each([
    { scope: { opens: 'file', abandon: 'missing' } },
    { scope: { closes: 'missing' } },
    { scope: { opens: '', abandon: 'close' } },
    { scope: { opens: 'file', abandon: 'close', closes: 'file' } },
    { segmentBound: true },
  ])('invalid or unsupported metadata is refused: %j', metadata => {
    expect(() =>
      defineCapability('r', {
        open: { ...immediate, ...metadata } as Operation<void>,
        close: { ...immediate, scope: { closes: 'file' } },
      }),
    ).toThrow(HostError);
  });
  test('scope metadata survives copying and appears in the manifest', () => {
    const scope = { opens: 'file', abandon: 'close' };
    const cap = defineCapability('r', {
      open: { ...immediate, scope },
      close: { ...immediate, scope: { closes: 'file' } },
    });
    scope.opens = 'changed';
    const manifest = JSON.parse(
      exportManifest({
        kind: 'test',
        version: '1',
        grants: { r: cap.grant('all', undefined) },
      }),
    );
    expect(manifest.grants[0].operations[1].scope).toEqual({
      opens: 'file',
      abandon: 'close',
    });
  });
});
