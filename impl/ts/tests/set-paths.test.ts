import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import {
  bool,
  defineObjectKind,
  map,
  newGroup,
  type Value,
} from '../src/index';

// A Host Object whose `state` property holds a map (ADR 0135).
const setup = (initial: Value, onGet?: () => void) => {
  const trace: string[] = [];
  const g = newGroup({ name: 'g', trace: line => trace.push(line) });
  let state = initial;
  const sets: Value[] = [];
  const kind = defineObjectKind<null>({
    name: 'box',
    props: {
      state: {
        get: () => {
          onGet?.();
          return state;
        },
        set: (_o, value) => {
          state = value;
          sets.push(value);
        },
      },
    },
  });
  const box = g.object(kind, 'b', null);
  const run = (source: string) => {
    const s = g.load({ name: 's', objects: { box }, source });
    s.deliver({ name: 'go' });
    return operationalReports(g.pump(0n).reports);
  };
  return { g, trace, sets, run, box, state: () => state };
};

const runEnd = (reports: ReturnType<typeof operationalReports>) =>
  reports.find(r => r.kind === 'run end');

test('set writes one key of a map-valued property with one Get and one Set', () => {
  const t = setup(map([['isLocked', bool(false)]]));
  const reports = t.run(
    'on go\n  set the isLocked of the state of box to true\nend go',
  );
  expect(runEnd(reports)!.outcome).toBe('completed');
  expect(t.state().toString()).toBe('{isLocked: true}');
  const props = t.trace.filter(l => l.startsWith('prop '));
  expect(props.map(l => /op=(\w+)/.exec(l)![1])).toEqual(['get', 'set']);
});

test('set writes an item and a nested key below a property', () => {
  const t = setup(map([['tags', map([['a', map([])]])]]));
  t.run(
    'on go\n  set the b of the a of the tags of the state of box to 1\nend go',
  );
  expect(t.state().toString()).toBe('{tags: {a: {b: 1}}}');
});

test('a missing step raises wrong kind before any Set', () => {
  const t = setup(map([]));
  const reports = t.run(
    'on go\n  set the b of the a of the state of box to 1\nend go',
  );
  const end = runEnd(reports)!;
  expect(end.error?.code).toBe('wrong kind');
  expect(end.error?.data.get('expected').asText()).toBe('map');
  expect(t.sets).toHaveLength(0);
});

test('a Stop made at the Get lands after the Set', () => {
  let g: ReturnType<typeof newGroup> | null = null;
  const t = setup(map([['isLocked', bool(false)]]), () =>
    g!.script('s')!.stop('off'),
  );
  g = t.g;
  t.run('on go\n  set the isLocked of the state of box to true\nend go');
  expect(t.sets).toHaveLength(1);
  const set = t.trace.findIndex(
    l => l.startsWith('prop ') && l.includes('op=set'),
  );
  expect(t.trace[set + 1]).toBe('> stop s reason="off"');
});

test('a Stop made at the Get lands where the set raises', () => {
  let g: ReturnType<typeof newGroup> | null = null;
  const t = setup(map([]), () => g!.script('s')!.stop('off'));
  g = t.g;
  t.run('on go\n  set the b of the a of the state of box to 1\nend go');
  expect(t.sets).toHaveLength(0);
  const get = t.trace.findIndex(l => l.startsWith('prop '));
  expect(t.trace[get + 1]).toBe('> stop s reason="off"');
  expect(t.trace.some(l => l.startsWith('raise '))).toBe(false);
});

test('a property that holds a Host Object is written on that object', () => {
  const trace: string[] = [];
  const g = newGroup({ name: 'g', trace: line => trace.push(line) });
  let label: Value = bool(false);
  const inner = defineObjectKind<null>({
    name: 'inner',
    props: { label: { get: () => label, set: (_o, v) => void (label = v) } },
  });
  const i = g.object(inner, 'i', null);
  let sets = 0;
  const outer = defineObjectKind<null>({
    name: 'outer',
    props: { child: { get: () => i.value, set: () => void sets++ } },
  });
  const o = g.object(outer, 'o', null);
  const s = g.load({
    name: 's',
    objects: { o },
    source: 'on go\n  set the label of the child of o to true\nend go',
  });
  s.deliver({ name: 'go' });
  g.pump(0n);
  expect(label.toString()).toBe('true');
  expect(sets).toBe(0);
});

test('a Fuel Slice does not preempt a Run inside a hold', () => {
  const t = setup(map([['n', map([])]]));
  const s = t.g.load({
    name: 's',
    objects: { box: t.box },
    source: 'on go\n  set the a of the n of the state of box to 1\nend go',
  });
  s.deliver({ name: 'go' });
  for (let i = 0; i < 100 && !t.trace.some(l => l.startsWith('run ')); i++) {
    const from = t.trace.length;
    t.g.pump(0n, { fuelSlice: 1 });
    const props = t.trace.slice(from).filter(l => l.startsWith('prop '));
    // The Get and the Set always fall in one Pump.
    expect(props.length % 2).toBe(0);
  }
  expect(t.sets).toHaveLength(1);
});
