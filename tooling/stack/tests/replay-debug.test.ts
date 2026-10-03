import { expect, test } from 'bun:test';
import {
  compileSource,
  newGroup,
  defineCapability,
  shape,
  num,
  text,
  clockCapability,
  defineObjectKind,
} from '@odgn/northtalk';
import { ReplayDebugger } from '../src/debug';
import { parseRecord } from '@odgn/northtalk/replay';

const source =
  'script variable n = 0\non go\n put 1 into n\n put 2 into n\n return n\nend';
const fixture = () => {
  const lines: string[] = [];
  const group = newGroup({ name: 'case', trace: line => lines.push(line) });
  group.load({ name: 's', source }).deliver({ name: 'go' });
  group.pump(42n);
  return {
    lines,
    setup: { scripts: [{ name: 's', source: 's.talk', text: source }] },
  };
};

test('Trace fields inside quoted or nested Host results remain part of the value', () => {
  const result =
    '{message: "something error={} charged=99", values: ["error={}"]}';
  const record = parseRecord(
    `call s/r1.c1 op=api.get args=[] result=${result} charged=3`,
  );
  expect(record.fields.get('result')).toBe(result);
  expect(record.fields.has('error')).toBe(false);
  expect(record.fields.get('charged')).toBe('3');
});

test('Trace Clock readings drive stepping over a deadline wait', () => {
  const source =
    'on go\n ask clock to now\n wait 1 s\n ask clock to now\n return it\nend';
  const lines: string[] = [];
  const group = newGroup({ name: 'case', trace: l => lines.push(l) });
  group
    .load({
      name: 's',
      source,
      grants: { clock: clockCapability({ now: { fuel: 0 } }).grant('all') },
    })
    .deliver({ name: 'go' });
  group.pump(1_000_000_000n);
  group.pump(2_000_000_000n);
  const debug = new ReplayDebugger(
    {
      scripts: [
        {
          name: 's',
          source: '',
          text: source,
          grants: { clock: { ops: 'all' } },
        },
      ],
      standard: [{ capability: 'clock', costs: { now: { fuel: 0 } } }],
    },
    lines,
  );
  debug.setBreakpoints([{ unit: 's', line: 3 }]);
  debug.resume();
  expect(debug.current?.line).toBe(3);
  debug.clearBreakpoints();
  debug.stepOver();
  expect(debug.current?.line).toBe(4);
  debug.reverseStep();
  expect(debug.current?.line).toBe(3);
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});

for (const fault of ['error', 'limitFault'] as const) {
  test(`replay ${fault} breaks expose state before unwinding or rollback`, () => {
    const source =
      'script variable n = 0\non go\n put 9 into n\n try\n  throw "oops"\n catch e\n  put 10 into n\n end try\n return n\nend';
    const limits = fault === 'limitFault' ? { fuelPerRun: 20 } : {};
    const lines: string[] = [];
    const group = newGroup({ name: 'case', trace: l => lines.push(l) });
    group.load({ name: 's', source, limits }).deliver({ name: 'go' });
    group.pump(0n);
    const debug = new ReplayDebugger(
      { scripts: [{ name: 's', source: '', text: source, limits }] },
      lines,
    );
    debug.pauseOn({ [fault]: true });
    expect(debug.resume().state).toBe('paused');
    expect(debug.current?.reason).toBe(fault);
    expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('9');
    debug.reverseStep();
    expect(debug.isPaused).toBe(true);
    while (debug.resume().state === 'paused') {
      debug.snapshot();
    }
    expect(debug.trace).toEqual(lines);
  });
}

test('recorded property answers replace changing Host state', () => {
  const source = 'on go\n return the state of bulb\nend';
  const lines: string[] = [];
  const group = newGroup({ name: 'case', trace: l => lines.push(l) });
  const kind = defineObjectKind({
    name: 'light',
    props: { state: { shape: shape.text, get: () => text('live') } },
  });
  group
    .load({
      name: 's',
      source,
      objects: { bulb: group.object(kind, 'bulb', null) },
    })
    .deliver({ name: 'go' });
  group.pump(0n);
  const debug = new ReplayDebugger(
    {
      scripts: [
        {
          name: 's',
          source: '',
          text: source,
          objects: { bulb: { kind: 'light', id: 'bulb' } },
        },
      ],
      objectKinds: [
        {
          name: 'light',
          props: [{ name: 'state', shape: 'text', readOnly: true }],
        },
      ],
      objects: [{ kind: 'light', id: 'bulb', props: { state: '"initial"' } }],
    },
    lines,
  );
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});

test('repeated instruction positions reverse to the preceding loop iteration', () => {
  const source =
    'script variable n = 0\non go\n repeat 3 times\n  put n + 1 into n\n end repeat\n return n\nend';
  const lines: string[] = [];
  const group = newGroup({ name: 'case', trace: l => lines.push(l) });
  group.load({ name: 's', source }).deliver({ name: 'go' });
  group.pump(0n);
  const debug = new ReplayDebugger(
    { scripts: [{ name: 's', source: '', text: source }] },
    lines,
  );
  debug.setBreakpoints([{ unit: 's', line: 4 }]);
  for (let n = 0; n < 3; n++) {
    debug.resume();
    expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe(String(n));
  }
  debug.reverseStep();
  expect(debug.current?.line).toBe(3);
  expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('2');
  debug.reverseStep();
  expect(debug.current?.line).toBe(4);
  expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('1');
});

test('a differing recorded output reports its first divergence', () => {
  const { lines, setup } = fixture();
  const changed = lines.map(l =>
    l.startsWith('run ') ? l.replace('value=2', 'value=99') : l,
  );
  expect(() => new ReplayDebugger(setup, changed).resume()).toThrow(
    'Trace diverged',
  );
});

test('a suspending Host failure is replayed without its Host function', () => {
  const source = 'on go\n ask api to later and wait\nend';
  const lines: string[] = [];
  const api = defineCapability('api', {
    later: {
      mode: 'suspending',
      cost: { fuel: 0 },
      start: call => {
        call.charge(2);
        throw new Error('offline');
      },
    },
  });
  const group = newGroup({ name: 'case', trace: l => lines.push(l) });
  group
    .load({ name: 's', source, grants: { api: api.grant('all') } })
    .deliver({ name: 'go' });
  group.pump(0n);
  const debug = new ReplayDebugger(
    {
      operations: [{ capability: 'api', name: 'later', mode: 'suspending' }],
      scripts: [
        {
          name: 's',
          source: '',
          text: source,
          grants: { api: { ops: 'all' } },
        },
      ],
    },
    lines,
  );
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});

test('replay breakpoints, inspection, forward and reverse steps preserve the recorded Trace', () => {
  const { lines, setup } = fixture();
  const debug = new ReplayDebugger(setup, lines);
  debug.setBreakpoints([{ unit: 's', line: 3 }]);
  expect(debug.resume().state).toBe('paused');
  expect(debug.current?.line).toBe(3);
  expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('0');
  expect(debug.stepOver().state).toBe('paused');
  expect(debug.current?.line).toBe(4);
  expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('1');
  expect(debug.reverseStep().state).toBe('paused');
  expect(debug.current?.line).toBe(3);
  expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('0');
  debug.clearBreakpoints();
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
  expect(debug.reverseStep().state).toBe('paused');
  expect(debug.current?.line).toBe(5);
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});

for (const stop of [true, false]) {
  test(`early ${stop ? 'Stop' : 'CancelRun'} lands at its recorded pc and remains reversible`, () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'case', trace: l => lines.push(l) });
    const s = group.load({ name: 's', source });
    const pc = compileSource(source, { name: 's' }).unit!.code.findIndex(
      i => i.line === 4,
    );
    s.deliver({ name: 'go' });
    group.debug().landAt(3, { pc, unit: 's' });
    group.pump(0n);
    if (stop) {
      s.stop('early');
    } else {
      s.cancelRun('s/r1');
    }
    group.debug().resume();
    const debug = new ReplayDebugger(
      { scripts: [{ name: 's', source: '', text: source }] },
      lines,
    );
    expect(debug.resume().state).toBe('paused');
    expect(debug.current).toMatchObject({
      reason: 'replay',
      pc,
      hostInputIndex: 3,
    });
    expect(debug.snapshot().scripts[0]!.vars[0]![1].toString()).toBe('1');
    debug.reverseStep();
    expect(debug.current?.line).toBe(3);
    expect(debug.resume().state).toBe('paused');
    expect(debug.resume().state).toBe('ended');
    expect(debug.trace).toEqual(lines);
  });
}

test('an early Stop of a different suspended Script lands in the executing Run', () => {
  const lines: string[] = [];
  const waiting = 'on go\n wait 10 s\nend';
  const group = newGroup({ name: 'case', trace: l => lines.push(l) });
  const t = group.load({ name: 't', source: waiting });
  const s = group.load({ name: 's', source });
  t.deliver({ name: 'go' });
  s.deliver({ name: 'go' });
  const pc = compileSource(source, { name: 's' }).unit!.code.findIndex(
    i => i.line === 4,
  );
  group.debug().landAt(5, { pc, unit: 's', run: 's/r1' });
  group.pump(0n);
  t.stop('early');
  group.debug().resume();
  const debug = new ReplayDebugger(
    {
      scripts: [
        { name: 't', source: '', text: waiting },
        { name: 's', source: '', text: source },
      ],
    },
    lines,
  );
  expect(debug.resume().state).toBe('paused');
  expect(debug.current).toMatchObject({ reason: 'replay', script: 's', pc });
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});

test('recorded charges and results replace live immediate and suspending Host functions', () => {
  const lines: string[] = [];
  const calls: import('@odgn/northtalk').Call<unknown>[] = [];
  const api = defineCapability('api', {
    get: {
      mode: 'immediate',
      cost: { fuel: 0 },
      result: shape.number,
      do: call => {
        call.charge(3);
        return num(7);
      },
    },
    later: {
      mode: 'suspending',
      cost: { fuel: 0 },
      result: shape.number,
      start: call => {
        call.charge(4);
        calls.push(call);
      },
    },
  });
  const source =
    'on go\n ask api to get\n put it into n\n ask api to later and wait\n return n + it\nend';
  const group = newGroup({ name: 'case', trace: l => lines.push(l) });
  group
    .load({ name: 's', source, grants: { api: api.grant('all') } })
    .deliver({ name: 'go' });
  group.pump(1n);
  calls[0]!.answer(num(2));
  group.pump(2n);
  const debug = new ReplayDebugger(
    {
      operations: [
        { capability: 'api', name: 'get', mode: 'immediate', result: 'number' },
        {
          capability: 'api',
          name: 'later',
          mode: 'suspending',
          result: 'number',
        },
      ],
      scripts: [
        {
          name: 's',
          source: '',
          text: source,
          grants: { api: { ops: 'all' } },
        },
      ],
    },
    lines,
  );
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});

test('run to Host Input uses zero-based indices and can seek backwards', () => {
  const { lines, setup } = fixture();
  const debug = new ReplayDebugger(setup, lines);
  expect(debug.runToHostInput(2).state).toBe('input');
  expect(debug.hostInputIndex).toBe(2);
  expect(debug.trace).toEqual([lines[0]!]);
  expect(debug.resume().state).toBe('ended');
  expect(debug.runToHostInput(0).state).toBe('input');
  expect(debug.trace).toEqual([]);
  expect(() => debug.runToHostInput(99)).toThrow('Host Input');
  expect(debug.resume().state).toBe('ended');
  expect(debug.trace).toEqual(lines);
});
