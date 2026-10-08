import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  defineObjectKind,
  newGroup,
  nothing,
  num,
  type Call,
  ScriptError,
} from '../src/index';

// A Request or Call that rejects with `send failed`, giving the reason in its data.
const expectSendFailed = async (result: Promise<unknown>, reason: string) => {
  const error = await result.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(ScriptError);
  expect((error as ScriptError).code).toBe('send failed');
  expect((error as ScriptError).data.get('reason').asText()).toBe(reason);
};

const setup = () => {
  const trace: string[] = [];
  return { g: newGroup({ name: 'g', trace: line => trace.push(line) }), trace };
};
const vars = (g: ReturnType<typeof newGroup>, index = 0) =>
  g
    .inspect()
    .scripts[index]!.vars.map(([name, value]) => [name, value.toString()]);

describe('Broadcast and cancellation', () => {
  test('Broadcast chooses recipients at drain, keeps load order, and never climbs', () => {
    const { g, trace } = setup();
    const id = g.broadcast({ name: 'go' });
    g.load({ name: 'a', source: 'on go\n  pass go\nend go' });
    g.load({ name: 'silent', source: 'on other\nend other' });
    g.load({ name: 'b', source: 'on go\nend go' });
    expect(
      operationalReports(g.pump(0n).reports).map(r =>
        'broadcast' in r ? r.broadcast : null,
      ),
    ).toEqual([id, id]);
    expect(trace.find(l => l.startsWith('> broadcast'))).toBe(
      '> broadcast b1 message=go recipients=[a:d1, b:d2]',
    );
    expect(trace.some(l => l.startsWith('unhandled '))).toBe(false);
  });

  test('aborting before dispatch removes the Delivery; a sealed Decision ignores abort', async () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      source: 'on go, deciding\n  wait 1 s\n  return 7\nend go',
    });
    const abort = new AbortController();
    const d = s.decide({ name: 'go' }, { signal: abort.signal });
    abort.abort();
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { kind: 'run end', outcome: 'cancelled', delivery: d.id, fuel: 0 },
      {
        kind: 'decided',
        verdict: 'undecided',
        undecided: [{ script: 's', outcome: 'cancelled' }],
      },
    ]);
    expect(await d.decided).toMatchObject({ verdict: 'undecided' });
    const sealedAbort = new AbortController();
    const sealed = s.decide({ name: 'go' }, { signal: sealedAbort.signal });
    g.pump(0n);
    expect(await sealed.decided).toMatchObject({ verdict: 'allowed' });
    const before = trace.length;
    sealedAbort.abort();
    expect(operationalReports(g.pump(1_000_000_000n).reports)).toMatchObject([
      { outcome: 'completed' },
    ]);
    expect(
      trace.slice(before).some(l => l.startsWith('> cancel-delivery')),
    ).toBe(false);
  });

  test('cancellation rolls back a preempted Segment and runs nested finally without catches', async () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\nscript variable clean = []\non go\n  try\n    try\n      put 9 into n\n      repeat forever\n      end repeat\n    catch e\n      put 99 into n\n    finally\n      put 1 after clean\n    end try\n  finally\n    put 2 after clean\n  end try\nend go',
    });
    const request = s.request({ name: 'go' });
    g.pump(0n, { fuelSlice: 20 });
    expect(vars(g)[0]).toEqual(['n', '9']);
    s.cancelRun('s/r1');
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(vars(g)).toEqual([
      ['n', '0'],
      ['clean', '[1, 2]'],
    ]);
    await expectSendFailed(request.result, 'cancelled');
  });

  test('suspended cancellation preserves committed writes, abandons calls, and ignores late answers', () => {
    const { g, trace } = setup();
    let aborted = false;
    let pending!: Call<unknown>;
    const cap = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          c.signal.addEventListener('abort', () => {
            aborted = true;
          });
          pending = c;
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: cap.grant(['hold'], undefined) },
      source:
        'script variable n = 0\non go\n  try\n    put 9 into n\n    ask api to hold and wait\n  finally\n    add 1 to n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r1');
    g.pump(0n);
    expect(aborted).toBe(true);
    expect(vars(g)).toEqual([['n', '10']]);
    expect(trace.filter(l => l.startsWith('run '))).toEqual([
      expect.stringContaining('outcome=cancelled'),
    ]);
    pending.answer(nothing);
    g.pump(0n);
    expect(trace).toContain('note s/r1.c1 kind=late-answer');
  });

  test('cleanup errors retain writes; cleanup limits roll them back and skip outer finally', () => {
    for (const budget of [1000, 8]) {
      const { g, trace } = setup();
      const s = g.load({
        name: 's',
        limits: { cleanupBudget: budget },
        source:
          'script variable n = 0\non go\n  try\n    try\n      wait 1 s\n    finally\n      put 1 into n\n      throw "cleanup broke"\n    end try\n  finally\n    put 2 into n\n  end try\nend go',
      });
      s.deliver({ name: 'go' });
      g.pump(0n);
      s.cancelRun('s/r1');
      const p = g.pump(0n);
      expect(operationalReports(p.reports)).toMatchObject([
        {
          outcome: 'cancelled',
          cleanupFailed:
            budget === 1000 ? { code: 'cleanup broke' } : { limit: 'cleanup' },
        },
      ]);
      expect(vars(g)).toEqual([['n', budget === 1000 ? '1' : '0']]);
      expect(trace.some(l => l.startsWith('cleanup-failed s/r1'))).toBe(true);
    }
  });

  test('Stop is sticky, discards work without cleanup, and owner disposal uses Stop', async () => {
    const { g, trace } = setup();
    const owner = g.object(
      defineObjectKind<null>({ name: 'widget', props: {} }),
      'w',
      null,
    );
    const s = g.load({
      name: 's',
      owner,
      source:
        'script variable n = 0\non go\n  try\n    wait 1 s\n  finally\n    put 9 into n\n  end try\nend go',
    });
    const request = s.request({ name: 'go' });
    g.pump(0n);
    s.deliver({ name: 'go' });
    g.dispose(owner);
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      {
        kind: 'stop',
        reason: 'owner disposed',
        discardedRuns: ['s/r1'],
        droppedMessages: ['d2'],
      },
    ]);
    await expectSendFailed(request.result, 'stopped');
    s.deliver({ name: 'go' });
    expect(g.pump(2_000_000_000n).state).toBe('stopped');
    expect(vars(g)).toEqual([['n', '0']]);
    expect(trace.some(l => l.startsWith('run '))).toBe(false);
  });
});

describe('Queueing Policies', () => {
  test('a clause with no parameters pays dispatch Fuel before a policy or Verdict', async () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source: 'on go, dropping\n  wait 1 s\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.deliver({ name: 'go' });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'dropped', fuel: 4 },
    ]);
    const d = s.decide({ name: 'go', limits: { fuelPerRun: 3 } });
    g.pump(0n);
    expect(await d.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ outcome: 'limit fault' }],
    });
  });

  test('queued parks after dispatch while other clauses keep flowing and releases FIFO', () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable got = []\non go n, queued\n  wait 1 s\n  put n after got\nend go\non other\n  put 9 after got\nend other',
    });
    s.deliver({ name: 'go', args: [num(1)] });
    s.deliver({ name: 'go', args: [num(2)] });
    s.deliver({ name: 'other' });
    g.pump(0n);
    expect(g.inspect().scripts[0]!.runs.map(r => [r.id, r.status])).toEqual([
      ['s/r1', 'suspended'],
      ['s/r2', 'parked'],
    ]);
    g.pump(1_000_000_000n);
    g.pump(2_000_000_000n);
    expect(vars(g)).toEqual([['got', '[9, 1, 2]']]);
    expect(
      trace.some(l => l.startsWith('seg s/r2 start') && l.endsWith('end=park')),
    ).toBe(true);
    expect(
      trace.filter(l => l.startsWith('seg s/r2')).map(l => l.split(' ')[2]),
    ).toEqual(['start', 'resume', 'resume']);
  });

  test('dropping dispatches before discarding and leaves a Decision undecided', async () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source: 'on go, dropping, deciding\n  wait 1 s\nend go',
    });
    const a = s.decide({ name: 'go' });
    const b = s.decide({ name: 'go' });
    const p = g.pump(0n);
    expect(await a.decided).toMatchObject({ verdict: 'allowed' });
    expect(await b.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ outcome: 'dropped' }],
    });
    expect(operationalReports(p.reports)).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        outcome: 'dropped',
        run: 's/r2',
      }),
    );
  });

  test('replacing schedules earlier cleanup in its own turn after the new Run', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable got = []\non go n, replacing\n  try\n    put n after got\n    wait 1 s\n  finally\n    put n * 10 after got\n  end try\nend go',
    });
    s.deliver({ name: 'go', args: [num(1)] });
    s.deliver({ name: 'go', args: [num(2)] });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled', run: 's/r1' },
    ]);
    expect(vars(g)).toEqual([['got', '[1, 2, 10]']]);
  });
});

describe('cancellation boundaries', () => {
  test('dropping checks the kept Persistent State at the Run end', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      limits: { persistentState: 180 },
      source: 'on go, dropping\n  wait 1 s\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    for (let i = 0; i < 3; i++) {
      s.deliver({ name: 'go' });
    }
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'limit fault', limit: 'persistent' },
      { outcome: 'limit fault', limit: 'persistent' },
      { outcome: 'dropped' },
    ]);
  });

  test('Stop calls chained through abort callbacks all land before Pump returns', () => {
    const { g, trace } = setup();
    const api = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          const next = c.id.startsWith('s/')
            ? 't'
            : c.id.startsWith('t/')
              ? 'u'
              : null;
          if (next) {
            c.signal.addEventListener('abort', () =>
              g.script(next)!.stop('chained'),
            );
          }
        },
      },
    });
    for (const name of ['s', 't', 'u']) {
      g.load({
        name,
        grants: { api: api.grant('all', undefined) },
        source: 'on go\n  ask api to hold and wait\nend go',
      }).deliver({ name: 'go' });
    }
    g.pump(0n);
    g.script('s')!.stop('first');
    const p = g.pump(0n);
    expect(
      operationalReports(p.reports)
        .filter(r => r.kind === 'stop')
        .map(r => r.script),
    ).toEqual(['s', 't', 'u']);
    expect(p.state).toBe('stopped');
    expect(
      trace.filter(l => l.startsWith('> stop')).map(l => l.split(' ')[2]),
    ).toEqual(['s', 't', 'u']);
  });

  test('Stop preserves call abandonment when queued cancellation has not stretched', () => {
    const { g, trace } = setup();
    let pending!: Call<unknown>;
    const api = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          pending = c;
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: api.grant('all', undefined) },
      source:
        'script variable n = 0\non go\n  try\n    ask api to hold and wait\n  finally\n    put 1 into n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r1');
    s.stop('done');
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { kind: 'stop', pendingCalls: ['s/r1.c1'] },
    ]);
    expect(pending.signal.aborted).toBe(true);
    expect(vars(g)).toEqual([['n', '0']]);
    expect(trace.find(l => l.startsWith('stopped '))).toContain(
      'abandoned=[s/r1.c1]',
    );
    expect(trace.some(l => l.startsWith('abandon '))).toBe(false);
  });

  test('discarding a ready failed Join preserves deferred abandonment without aborting the failed call', () => {
    for (const stop of [false, true]) {
      const { g, trace } = setup();
      const other = g.load({
        name: 'other',
        source: 'on tick\n  return 1\nend tick',
      });
      const calls: Call<unknown>[] = [];
      const api = defineCapability('api', {
        hold: {
          mode: 'suspending',
          cost: { fuel: 0 },
          start: c => {
            calls.push(c);
          },
        },
      });
      const s = g.load({
        name: 's',
        grants: { api: api.grant('all', undefined) },
        source:
          'on go\n  wait for all\n    ask api to hold and wait\n    ask api to hold and wait\n  end wait\nend go',
      });
      s.deliver({ name: 'go' });
      g.pump(0n);
      calls[0]!.fail(
        new Error('failure') as Parameters<Call<unknown>['fail']>[0],
      );
      other.deliver({ name: 'tick' });
      g.pump(0n, { fuelCap: 1 });
      expect(calls.map(c => c.signal.aborted)).toEqual([false, true]);
      if (stop) {
        s.stop('done');
      } else {
        s.cancelRun('s/r1');
      }
      const p = g.pump(0n);
      expect(calls.map(c => c.signal.aborted)).toEqual([false, true]);
      if (stop) {
        expect(
          operationalReports(p.reports).filter(r => r.kind === 'stop'),
        ).toMatchObject([{ kind: 'stop', pendingCalls: ['s/r1.c2'] }]);
        expect(trace.find(l => l.startsWith('stopped '))).toContain(
          'abandoned=[s/r1.c2]',
        );
      } else {
        expect(trace.filter(l => l.startsWith('abandon '))).toEqual([
          'abandon s/r1.c2',
        ]);
      }
    }
  });

  test('worker calls from abort listeners during the input drain are reentrant calls', () => {
    const { g, trace } = setup();
    let code = '';
    const api = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          c.signal.addEventListener('abort', () => {
            try {
              g.inspect();
            } catch (error) {
              code = (error as { code: string }).code;
            }
          });
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: api.grant('all', undefined) },
      source: 'on go\n  ask api to hold and wait\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r1');
    g.pump(0n);
    expect(code).toBe('reentrant call');
    expect(trace.some(l => l.startsWith('> vars'))).toBe(false);
  });

  test('cancelling at a suspending crossing abandons that just-started call', () => {
    const { g, trace } = setup();
    let pending!: Call<unknown>;
    const api = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          pending = c;
          g.script('s')!.cancelRun('s/r1');
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: api.grant('all', undefined) },
      source: 'on go\n  ask api to hold and wait\nend go',
    });
    s.deliver({ name: 'go' });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(pending.signal.aborted).toBe(true);
    expect(trace).toContain('abandon s/r1.c1');
    expect(trace.some(l => l.includes('end=ask-wait'))).toBe(false);
  });

  test('cancellation inside an inlined finally does not run that block again', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\non go\n  try\n    put 9 into n\n    wait 0 s\n  finally\n    add 1 to n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    g.pump(0n, { fuelSlice: 1 });
    s.cancelRun('s/r1');
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(vars(g)).toEqual([['n', '9']]);
  });

  test('cancelling a sender abandons its reply while the receiver keeps running', async () => {
    const { g, trace } = setup();
    const front = g.load({
      name: 'front',
      source: 'on go\n  send work to back and wait\nend go',
    });
    g.load({
      name: 'back',
      source:
        'script variable n = 0\non work\n  wait 1 s\n  put 1 into n\n  return 7\nend work',
    });
    const abort = new AbortController();
    const request = front.request({ name: 'go' }, { signal: abort.signal });
    g.pump(0n);
    abort.abort();
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { script: 'front', outcome: 'cancelled' },
    ]);
    await expectSendFailed(request.result, 'cancelled');
    expect(trace).toContain('abandon front/r1.c1');
    expect(operationalReports(g.pump(1_000_000_000n).reports)).toMatchObject([
      { script: 'back', outcome: 'completed' },
    ]);
    expect(vars(g, 1)).toEqual([['n', '1']]);
  });

  test('Join cancellation abandons pending members in start order and drops early answers', () => {
    const { g, trace } = setup();
    const calls: Call<unknown>[] = [];
    const api = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 0 },
        start: c => {
          calls.push(c);
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: api.grant('all', undefined) },
      source:
        'script variable n = 0\non go\n  try\n    wait for all\n      ask api to hold and wait\n      ask api to hold and wait\n      ask api to hold and wait\n    end wait\n  finally\n    put 1 into n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    calls[0]!.answer(num(1));
    g.pump(0n);
    s.cancelRun('s/r1');
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(calls.map(c => c.signal.aborted)).toEqual([false, true, true]);
    expect(trace.filter(l => l.startsWith('abandon '))).toEqual([
      'abandon s/r1.c2',
      'abandon s/r1.c3',
    ]);
    expect(vars(g)).toEqual([['n', '1']]);
  });

  test('cancellation visits finally in called frames before the caller, with no unwind charge', () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable got = []\non go\n  try\n    helper and wait\n  finally\n    put 2 after got\n  end try\nend go\non helper\n  try\n    wait 1 s\n  finally\n    put 1 after got\n  end try\nend helper',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r1');
    g.pump(0n);
    expect(vars(g)).toEqual([['got', '[1, 2]']]);
    // Each copy: const 1 + load-var 1 + append 3 + store-var 4 + end-cleanup 2.
    expect(trace.find(l => l.startsWith('seg s/r1 resume'))).toContain(
      'fuel=22 alloc=48',
    );
  });

  test('Queueing Policies distinguish clauses and do not affect local Handler calls', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\non go 1, dropping\n  wait 1 s\n  add 1 to n\nend go\non go 2, dropping\n  wait 1 s\n  add 2 to n\nend go\non call\n  go 1 and wait\n  add 4 to n\nend call',
    });
    s.deliver({ name: 'go', args: [num(1)] });
    s.deliver({ name: 'go', args: [num(2)] });
    s.deliver({ name: 'call' });
    expect(operationalReports(g.pump(0n).reports)).toEqual([]);
    g.pump(1_000_000_000n);
    expect(vars(g)).toEqual([['n', '8']]);
  });

  test('cancelRun lands after an Operation crossing and continues cleanup in that turn', () => {
    const { g, trace } = setup();
    const api = defineCapability('api', {
      cancel: {
        mode: 'immediate',
        cost: { fuel: 0 },
        do: () => {
          g.script('s')!.cancelRun('s/r1');
          return nothing;
        },
      },
    });
    const s = g.load({
      name: 's',
      grants: { api: api.grant('all', undefined) },
      source:
        'script variable n = 0\non go\n  try\n    put 9 into n\n    ask api to cancel\n    put 99 into n\n  finally\n    add 1 to n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(vars(g)).toEqual([['n', '1']]);
    const crossing = trace.findIndex(l => l.startsWith('call '));
    expect(trace[crossing + 1]).toBe('> cancel-run s/r1');
    expect(
      trace.some(
        l => l.startsWith('seg s/r1 start') && l.endsWith('end=cancel'),
      ),
    ).toBe(true);
  });

  test('cancellation at a crossing lands before a result conversion can fault', () => {
    const { g, trace } = setup();
    const api = defineCapability('api', {
      cancel: {
        mode: 'immediate',
        cost: { fuel: 0 },
        do: () => {
          g.script('s')!.cancelRun('s/r1');
          return num(100);
        },
      },
    });
    const s = g.load({
      name: 's',
      limits: { allocPerRun: 0 },
      grants: { api: api.grant('all', undefined) },
      source: 'on go\n  ask api to cancel\nend go',
    });
    s.deliver({ name: 'go' });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'cancelled' },
    ]);
    expect(trace.some(l => l.startsWith('fault '))).toBe(false);
  });

  test('Stop at a property crossing rolls back, ends the active Stretch, and seals after stopped', async () => {
    const { g, trace } = setup();
    const kind = defineObjectKind<null>({
      name: 'switch',
      props: {
        value: {
          get: () => {
            g.script('s')!.stop('off');
            return num(1);
          },
        },
      },
    });
    const o = g.object(kind, 'w', null);
    const s = g.load({
      name: 's',
      objects: { switcher: o },
      source:
        'script variable n = 0\non go, deciding\n  try\n    put 9 into n\n    put the value of switcher into n\n  finally\n    put 99 into n\n  end try\nend go',
    });
    const d = s.decide({ name: 'go' });
    expect(operationalReports(g.pump(0n).reports).map(r => r.kind)).toEqual([
      'stop',
      'decided',
    ]);
    expect(await d.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ outcome: 'cancelled', run: 's/r1' }],
    });
    expect(vars(g)).toEqual([['n', '0']]);
    const crossing = trace.findIndex(l => l.startsWith('prop '));
    expect(trace[crossing + 1]).toBe('> stop s reason="off"');
    expect(trace[crossing + 2]).toContain('end=stop');
    expect(trace[crossing + 3]).toContain('stopped s');
    expect(trace[crossing + 4]).toContain('decided d1');
  });

  test('a preempted Decision is undecided on cancellation, but another recipient already sealed keeps running', async () => {
    const { g } = setup();
    g.load({
      name: 'a',
      source:
        'script variable n = 0\non go, deciding\n  wait 1 s\n  put 1 into n\nend go',
    });
    g.load({
      name: 'b',
      source: 'on go, deciding\n  repeat forever\n  end repeat\nend go',
    });
    const abort = new AbortController();
    const d = g.decideBroadcast({ name: 'go' }, { signal: abort.signal });
    g.pump(0n, { fuelSlice: 30 });
    abort.abort();
    g.pump(0n);
    expect(await d.decided).toMatchObject({
      verdict: 'undecided',
      undecided: [{ script: 'b', run: 'b/r1', outcome: 'cancelled' }],
    });
    expect(operationalReports(g.pump(1_000_000_000n).reports)).toMatchObject([
      { outcome: 'completed', script: 'a' },
    ]);
    expect(vars(g)).toEqual([['n', '1']]);
  });

  test('Broadcast recipient selection observes earlier Stop and cancellation inputs', () => {
    const { g, trace } = setup();
    const a = g.load({ name: 'a', source: 'on go\nend go' });
    const b = g.load({
      name: 'b',
      source: 'on watch\n  wait for go\nend watch',
    });
    b.deliver({ name: 'watch' });
    g.pump(0n);
    a.stop('done');
    b.cancelRun('b/r1');
    g.broadcast({ name: 'go' });
    g.pump(0n);
    expect(trace.find(l => l.startsWith('> broadcast'))).toBe(
      '> broadcast b1 message=go',
    );
  });

  test('a ready Run has no uncommitted writes to roll back', () => {
    const { g } = setup();
    const other = g.load({
      name: 'other',
      source: 'on tick\n  return 1\nend tick',
    });
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\non go\n  try\n    put 9 into n\n    wait 0 s\n  finally\n    add 1 to n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    other.deliver({ name: 'tick' });
    g.pump(0n, { fuelCap: 1 });
    s.cancelRun('s/r1');
    g.pump(0n);
    expect(vars(g, 1)).toEqual([['n', '10']]);
  });

  test('cleanup has its own Fuel budget and can be preempted by a Group cap', () => {
    const { g, trace } = setup();
    const s = g.load({
      name: 's',
      limits: { fuelPerRun: 20, cleanupBudget: 1000 },
      source:
        'script variable n = 0\non go\n  try\n    wait 1 s\n  finally\n    repeat 10 times\n      add 1 to n\n    end repeat\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r1');
    expect(g.pump(0n, { fuelCap: 10 }).state).toBe('sliced');
    const p = g.pump(0n);
    expect(operationalReports(p.reports)).toMatchObject([
      { outcome: 'cancelled', fuel: expect.any(Number) },
    ]);
    expect(vars(g)).toEqual([['n', '10']]);
    expect(
      trace.some(
        l => l.startsWith('preempt s/r1 resume') && l.includes('by=cap'),
      ),
    ).toBe(true);
  });

  test('cancelling a parked Run follows its finally table and does not disturb the active clause', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\non go, queued\n  try\n    wait 1 s\n    add 1 to n\n  finally\n    add 10 to n\n  end try\nend go',
    });
    s.deliver({ name: 'go' });
    s.deliver({ name: 'go' });
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r2');
    g.pump(0n);
    expect(vars(g)).toEqual([['n', '10']]);
    expect(g.inspect().scripts[0]!.runs.map(r => r.status)).toEqual([
      'suspended',
      'parked',
    ]);
    g.pump(1_000_000_000n);
    g.pump(2_000_000_000n);
    expect(vars(g)).toEqual([['n', '32']]);
  });

  test('Queueing Policies belong to the selected clause, and parked state can fault', () => {
    const { g } = setup();
    const s = g.load({
      name: 's',
      limits: { persistentState: 200 },
      source: 'on go n, queued\n  wait 1 s\nend go\non other\nend other',
    });
    s.deliver({ name: 'go', args: [num(1)] });
    g.pump(0n);
    s.deliver({ name: 'go', args: [num(2)] });
    expect(operationalReports(g.pump(0n).reports)).toMatchObject([
      { outcome: 'limit fault', limit: 'persistent' },
    ]);
    expect(g.inspect().scripts[0]!.runs.map(r => r.status)).toEqual([
      'suspended',
    ]);
  });
});
