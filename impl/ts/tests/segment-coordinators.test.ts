// Segment Coordinators (ADR 0069): Grants mapped to one coordinator share a
// Segment's participant. The shared Trace Cases are `effect-coordinator-*`;
// these check what only a Host sees: hook contexts, when the mapping runs,
// and cancellation across enrolled Grants.
import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import {
  defineCapability,
  HostError,
  newGroup,
  nothing,
  parseInstant,
  restore,
  ScriptError,
  shape,
  type Call,
  type Group,
  type SegmentContext,
  type SegmentCoordinator,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');

type Seen = {
  binding: unknown;
  grantName: string;
  grants: [string, unknown][];
  phase: string;
};

// Maps each binding to a coordinator by `route`; a coordinator records the
// contexts its hooks see, and `close` fails for the Grants in `failClose`.
const coordinatedHost = (
  route: (binding: string) => string = () => 'one',
  failClose: string[] = [],
) => {
  const events: string[] = [];
  const seen: Seen[] = [];
  const coordinators = new Map<string, SegmentCoordinator>();
  let resolved = 0;
  const hook =
    (name: string, phase: string) => (context: SegmentContext<unknown>) => {
      events.push(`${name}.${phase}`);
      seen.push({
        phase,
        grantName: context.grantName,
        binding: context.binding,
        grants: context.grants.map(g => [g.grantName, g.binding]),
      });
      return { status: 'ok' as const };
    };
  const op = (name: string, extra = {}) => ({
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 1 },
    segmentBound: true,
    do: (call: Call<string>) => {
      events.push(`${call.grantName}.${call.automatic ? 'abandon' : name}`);
      if (call.automatic && failClose.includes(call.grantName)) {
        throw new ScriptError('broken', 'broken');
      }
      return nothing;
    },
    ...extra,
  });
  const cap = defineCapability<string>(
    'db',
    {
      change: op('change'),
      open: op('open', { scope: { opens: 'tx', abandon: 'close' } }),
      close: op('close', { scope: { closes: 'tx' } }),
    },
    {
      coordinator: binding => {
        resolved++;
        const name = route(binding);
        if (!coordinators.has(name)) {
          coordinators.set(name, {
            begin: hook(name, 'begin'),
            commit: hook(name, 'commit'),
            rollback: hook(name, 'rollback'),
          });
        }
        return coordinators.get(name)!;
      },
    },
  );
  return { cap, events, seen, resolved: () => resolved };
};

const start = (
  body: string,
  host = coordinatedHost(),
  bindings: Record<string, string> = { a: 'x', b: 'y' },
) => {
  const group = newGroup({ name: 'g' });
  const grants = Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [
      name,
      host.cap.grant('all', binding),
    ]),
  );
  // `alias` is the same Grant as `a`, under a second name.
  const script = group.load({
    name: 's',
    source: `script variable count = 0\non go\n${body}\nend go`,
    grants: { ...grants, alias: grants.a! },
  });
  script.deliver({ name: 'go' });
  return { group, script, host, grants };
};
const runEnd = (group: Group, fuelSlice?: number) =>
  operationalReports(
    group.pump(now, fuelSlice ? { fuelSlice } : {}).reports,
  ).find(r => r.kind === 'run end');

test('Grants sharing a coordinator, aliases included, run one begin and one commit over every enrolled Grant', () => {
  const { group, host } = start(
    'ask a to change\nask alias to change\nask b to change\nask a to change',
  );
  expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
  expect(host.events).toEqual([
    'one.begin',
    'a.change',
    'alias.change',
    'b.change',
    'a.change',
    'one.commit',
  ]);
  expect(host.seen).toEqual([
    { phase: 'begin', grantName: 'a', binding: 'x', grants: [['a', 'x']] },
    {
      phase: 'commit',
      grantName: 'a',
      binding: 'x',
      grants: [
        ['a', 'x'],
        ['alias', 'x'],
        ['b', 'y'],
      ],
    },
  ]);
});

test('a Grant on another coordinator conflicts before its Host work, naming the first enrolled Grant', () => {
  const { group, host } = start(
    'ask alias to change\nask a to change\nask b to change',
    coordinatedHost(binding => binding),
  );
  const end = runEnd(group);
  expect(end).toMatchObject({
    outcome: 'errored',
    error: { code: 'segment participant conflict' },
  });
  const error = end?.kind === 'run end' ? end.error : undefined;
  expect(error?.data.get('participant').asText()).toBe('alias');
  expect(host.events).toEqual([
    'x.begin',
    'alias.change',
    'a.change',
    'x.commit',
  ]);
});

test('failed abandonment on the first enrolled Grant prevents commit and disables only it', () => {
  const { group, host } = start(
    'ask a to open\nask b to change\nput 2 into count',
    coordinatedHost(undefined, ['a']),
    { a: 'x', b: 'x' },
  );
  expect(runEnd(group)).toMatchObject({
    outcome: 'effect failed',
    effect: { grant: 'a', phase: 'abandon', scope: 'tx' },
  });
  expect(host.events.slice(-2)).toEqual(['a.abandon', 'one.rollback']);
  expect(host.seen.at(-1)!.grants).toEqual([
    ['a', 'x'],
    ['b', 'x'],
  ]);
  expect(group.inspect().scripts[0]!.disabledGrants).toEqual(['a']);
});

test('cancellation abandons scopes on every enrolled Grant before one rollback', () => {
  const { group, script, host } = start(
    'try\nask a to open\nask b to open\nrepeat forever\nend repeat\nfinally\nput 2 into count\nend try',
  );
  group.pump(now, { fuelSlice: 50 });
  script.cancelRun('s/r1');
  expect(runEnd(group)).toMatchObject({ outcome: 'cancelled' });
  expect(host.events).toEqual([
    'one.begin',
    'a.open',
    'b.open',
    'b.abandon',
    'a.abandon',
    'one.rollback',
  ]);
  expect(host.seen.at(-1)!.grants).toEqual([
    ['a', 'x'],
    ['b', 'y'],
  ]);
});

test('the mapping runs once per Grant creation and holds across Reload and Restore', () => {
  const host = coordinatedHost();
  const { group, script, grants } = start('ask a to change', host);
  expect(host.resolved()).toBe(2);
  runEnd(group);
  script.reload(
    'on go\nask a to change\nask b to change\nend go',
    'carry variables',
  );
  const restored = restore(group.save(), {
    name: 'restored',
    onMismatch: 'reject',
    libraries: [],
    grants: (_script, name) => grants[name === 'alias' ? 'a' : name],
    resolve: () => {
      throw new Error('no objects');
    },
  }).group;
  restored.script('s')!.deliver({ name: 'go' });
  expect(runEnd(restored)).toMatchObject({ outcome: 'completed' });
  expect(host.resolved()).toBe(2);
  expect(host.seen.at(-1)!.grants).toEqual([
    ['a', 'x'],
    ['b', 'y'],
  ]);
});

test('definition and Grant creation require a coordinator with all three hooks', () => {
  const change = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    segmentBound: true,
    do: () => nothing,
  };
  expect(() =>
    defineCapability('bad', { change }, {
      coordinator: 'one',
    } as never),
  ).toThrow(HostError);
  const partial = defineCapability(
    'partial',
    { change },
    {
      coordinator: () =>
        ({ begin: () => ({ status: 'ok' }) }) as unknown as SegmentCoordinator,
    },
  );
  expect(() => partial.grant('all', undefined)).toThrow(
    'begin, commit and rollback',
  );
});
