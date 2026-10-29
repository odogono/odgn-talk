import { expect, test } from 'bun:test';
import {
  checkSource,
  compileSource,
  defineCapability,
  newGroup,
  num,
  restore,
  shape,
  type Call,
} from '../src/index';

const ordinary = [
  ['tell g\n    op into x\n  end tell', 'ask'],
  ['tell g\n    op into x and wait\n  end tell', 'ask-wait'],
  ['h 1 into x', 'call-handler'],
  ['move 1 to 2 into x', 'call-handler'],
  ['slow 1 into x and wait', 'call-handler-wait'],
  ['sqrt(4) into x', 'call-builtin'],
  ['f(4) into x', 'call-value'],
  ['f(4) into x and wait', 'call-value-wait'],
  ['send m with 1 to me into x and wait', 'send-wait'],
  ['send to me: move 1 to 2 into x and wait', 'send-wait'],
  ['send ("m") with 1 to me into x and wait', 'send-named-wait'],
  ['send m with ...[1] to me into x and wait', 'send-spread-wait'],
  ['unknown 1 into x and wait', 'send-up-wait'],
] as const;
const source = (line: string) =>
  `on h n\n return n\nend h\non slow n\n wait 1 ms\n return n\nend slow\non move n to p\n return p\nend move\non t\n put given n: n into f\n ${line}\n return x\nend t\n`;

test.each(ordinary)('%s writes the target after setting it', (line, op) => {
  const result = compileSource(source(line), { name: 's' });
  expect(result.error).toBeNull();
  expect(result.diagnostics).toEqual([]);
  const unit = result.unit!;
  const body = unit.bodies.find(b => b.name === 't')!;
  const code = unit.code.slice(body.start, body.end);
  const at = code.findIndex(i => i.op === op);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(code.slice(at + 1, at + 3).map(i => [i.op, ...i.operands])).toEqual([
    ['store', 0],
    ['move', 0, 2],
  ]);
});

test.each(['unknown into x', 'send m to me into x', 'send to me: m into x'])(
  '%s needs explicit waiting',
  line => {
    expect(
      checkSource(`on t\n ${line}\nend t`).diagnostics.map(d => d.code),
    ).toEqual(['missing and wait']);
  },
);

test('tell lines and Host Commands preserve the answer, and reject fire-and-forget targets', () => {
  const api = defineCapability('api', {
    price: {
      mode: 'immediate',
      command: true,
      cost: { fuel: 0 },
      do: () => num(7),
    },
    note: {
      mode: 'fire-and-forget',
      command: true,
      cost: { fuel: 0 },
      fire: () => {},
    },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    grants: { api },
    source:
      'script variable result\non go p\n tell api\n price into p\n price into fresh\n end tell\n price into result\n return [p, fresh, result, it]\nend go',
  }).deliver({ name: 'go', args: [num(0)] });
  const reports = g.pump(0n).reports;
  expect(reports.find(r => r.kind === 'run end')).toMatchObject({
    result: expect.anything(),
  });
  expect(g.inspect().scripts[0]!.vars[0]![1].toString()).toBe('7');
  for (const line of [
    'note into x',
    'tell api\n note into x\n end tell',
    'say 1 into x',
  ]) {
    expect(() =>
      g.load({
        name: 'bad',
        grants: { api },
        source: `on go\n ${line}\nend go`,
      }),
    ).toThrow();
  }
});

test('Join destinations are atomic, retained across save, and assigned in start order', () => {
  const calls: Call<unknown>[] = [];
  const api = defineCapability('api', {
    hold: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 0 },
      start: c => {
        calls.push(c);
      },
    },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    grants: { api },
    source: `script variable last = 0\nscript variable result\non go\n put 9 into x\n wait for all\n  repeat 2 times\n   ask api to hold into x and wait\n  end repeat\n  tell api\n   hold into last and wait\n  end tell\n end wait\n put [x, last, it] into result\nend go`,
  }).deliver({ name: 'go' });
  g.pump(0n);
  calls[0]!.answer(num(1));
  g.pump(1n);
  expect(g.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
  const { group: copy } = restore(g.save(), {
    name: 'copy',
    libraries: [],
    grants: () => api,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  copy.settle('s/r1.c3', { answer: num(3) });
  copy.settle('s/r1.c2', { answer: num(2) });
  copy.pump(2n);
  expect(copy.inspect().scripts[0]!.vars.map(v => v[1].toString())).toEqual([
    '3',
    '[2, 3, [1, 2, 3]]',
  ]);
});

const executeJoinTargetBudget = (budget?: number) => {
  const calls: Call<unknown>[] = [];
  const api = defineCapability('api', {
    hold: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 0 },
      start: c => {
        calls.push(c);
      },
    },
  }).grant('all', undefined);
  const trace: string[] = [];
  const g = newGroup({ name: 'g', trace: l => trace.push(l) });
  g.load({
    name: 's',
    grants: { api },
    limits: budget === undefined ? undefined : { fuelPerRun: budget },
    source:
      'script variable x = 0\non go\n wait for all\n  ask api to hold into x and wait\n  ask api to hold into x and wait\n end wait\nend go',
  }).deliver({ name: 'go' });
  g.pump(0n);
  calls[1]!.answer(num(2));
  calls[0]!.answer(num(1));
  const end = g.pump(1n).reports.find(r => r.kind === 'run end')!;
  return { end, trace, x: g.inspect().scripts[0]!.vars[0]![1].toString() };
};

test('Join completion reserves all target Fuel before writing any destination', () => {
  const complete = executeJoinTargetBudget();
  expect(complete.end).toMatchObject({ outcome: 'completed' });
  expect(complete.x).toBe('2');
  // Closing stores/return cost 4 after the completion reservation of 6.
  const fuel = complete.end.fuel;
  expect(executeJoinTargetBudget(fuel).x).toBe('2');
  const failed = executeJoinTargetBudget(fuel - 5);
  expect(failed.end).toMatchObject({ outcome: 'limit fault' });
  expect(failed.x).toBe('0');
  expect(failed.trace.find(l => l.startsWith('fault '))).toContain('pos=6:2');
});

test('restore rejects a Join destination associated with a missing frame or non-member instruction', async () => {
  const { editSave } = await import('./save-edit');
  const api = defineCapability('api', {
    hold: { mode: 'suspending', cost: { fuel: 0 }, start: () => {} },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    grants: { api },
    source:
      'on go\n wait for all\n  ask api to hold into x and wait\n end wait\nend go',
  }).deliver({ name: 'go' });
  g.pump(0n);
  const saved = g.save();
  for (const corruption of ['frame', 'pc'] as const) {
    const edited = editSave(saved, x => {
      const member = x.runs[0]!.join!.members[0]!;
      if (corruption === 'pc') {
        member.start = 0;
      } else {
        member.frame = 99;
      }
    });
    expect(() =>
      restore(edited, {
        name: 'bad',
        libraries: [],
        grants: () => api,
        resolve: () => undefined,
        onMismatch: 'reject',
      }),
    ).toThrow('invalid save');
  }
});
