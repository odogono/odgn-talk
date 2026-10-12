import { expect, test } from 'bun:test';
import {
  createCore,
  defineCapability,
  HostError,
  newGroup,
  nothing,
  parseInstant,
  shape,
  type Group,
} from '../src/index';
import { createRouter, type WatchLimits } from '../src/notify/index';

// The router on real Groups. `store` here offers only `watch`, as #620's
// factory will, so a watch is registered through a real Call and released
// by the real release hook.
const now = parseInstant('2026-10-11T12:00:00Z');
const roomy: WatchLimits = {
  watches: 100,
  watchSize: 65_536,
  pending: 1000,
  pendingSize: 1_048_576,
};
const setup = (revision = () => 'r0', admitted?: (group: Group) => void) => {
  const router = createRouter({ admitted, limits: () => roomy, revision });
  const def = defineCapability<string>(
    'store',
    {
      watch: {
        mode: 'immediate',
        args: [shape.text, shape.text, shape.text],
        result: shape.nothing,
        cost: { fuel: 0 },
        do: (call, name, prefix, message) => {
          router.watch(
            call,
            name!.asText()!,
            prefix!.asText()!,
            message!.asText()!,
          );
          return nothing;
        },
      },
    },
    undefined,
    context => router.release(context),
  );
  return { router, def };
};
const watcher = (watch: string) =>
  `script variable seen = []
on start
  ask scores to watch ${watch}
end start
on changed change
  put the "keys" of change after seen
end changed
on storeChanged change
  put the resync of change after seen
end storeChanged`;
const seen = (group: Group, script: string) =>
  group
    .inspect()
    .scripts.find(s => s.name === script)!
    .vars.find(([name]) => name === 'seen')![1]
    .toString();

test('scriptNames gives load order, inside a Pump too, without a Trace record', () => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  let during: string[] = [];
  const def = defineCapability('probe', {
    look: {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 0 },
      do: call => {
        during = call.group.scriptNames();
        return nothing;
      },
    },
  });
  group.load({
    name: 'z',
    source: 'on go\n  ask probe to look\nend go',
    grants: { probe: def.grant('all', undefined) },
  });
  group.load({ name: 'a', source: 'on go\nend go', grants: {} });
  const before = lines.length;
  expect(group.scriptNames()).toEqual(['z', 'a']);
  expect(lines.length).toBe(before);
  group.script('z')!.deliver({ name: 'go' });
  group.pump(now);
  expect(during).toEqual(['z', 'a']);
});

test('a commit delivers to real Scripts in load order, and a full mailbox is retried after the Pump', () => {
  const { router, def } = setup();
  const group = newGroup({ name: 'g' });
  for (const name of ['b', 'a']) {
    group.load({
      name,
      source: watcher('"w", "", "changed"'),
      grants: { scores: def.grant('all', 'default') },
      limits: { mailboxDepth: 1 },
    });
    group.script(name)!.deliver({ name: 'start' });
  }
  group.pump(now);
  router.commit('default', () => ['k']);
  // Each mailbox holds one Delivery, so the next commit is held.
  router.commit('default', () => ['j']);
  expect(router.pumped(group)).toBe(true);
  group.pump(now);
  expect(seen(group, 'b')).toBe('[["k"]]');
  expect(router.pumped(group)).toBe(false);
  group.pump(now);
  expect(seen(group, 'b')).toBe('[["k"], ["j"]]');
  expect(seen(group, 'a')).toBe('[["k"], ["j"]]');
});

test('admitted is told of each Notification a Group admits, and not of one a full mailbox refuses', () => {
  const told: Group[] = [];
  const { router, def } = setup(undefined, group => told.push(group));
  const group = newGroup({ name: 'g' });
  group.load({
    name: 'a',
    source: watcher('"w", "", "changed"'),
    grants: { scores: def.grant('all', 'default') },
    limits: { mailboxDepth: 1 },
  });
  group.script('a')!.deliver({ name: 'start' });
  group.pump(now);
  router.commit('default', () => ['k']);
  expect(told).toEqual([group]);
  router.commit('default', () => ['j']);
  expect(told).toEqual([group]);
  group.pump(now);
  router.pumped(group);
  expect(told).toEqual([group, group]);
});

test("Stop releases a Script's watches through the release hook", () => {
  const { router, def } = setup();
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 'a',
    source: watcher('"w", "", "changed"'),
    grants: { scores: def.grant('all', 'default') },
  });
  script.deliver({ name: 'start' });
  group.pump(now);
  script.stop('done');
  group.pump(now);
  router.commit('default', () => ['k']);
  expect(group.inspect().scripts[0]!.mailbox).toEqual([]);
});

test('a checkpoint restores through Core.restore with its watches, and a changed Store sends a marker', () => {
  let revision = 'r0';
  const { router, def } = setup(() => revision);
  const core = createCore();
  const group = core.newGroup({ name: 'g' });
  const script = group.load({
    name: 'a',
    source: watcher('"w", "", "storeChanged"'),
    grants: { scores: def.grant('all', 'default') },
  });
  script.deliver({ name: 'start' });
  group.pump(now);
  const checkpoint = router.save(group);
  router.detach(group);
  const options = {
    name: 'g',
    grants: () => def.grant('all', 'default'),
    libraries: [],
    onMismatch: 'reject' as const,
    resolve: () => undefined,
  };
  let refused: unknown;
  try {
    router.restore(core, group.save(), options);
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(HostError);
  expect((refused as HostError).code).toBe('invalid checkpoint');
  revision = 'r1';
  const restored = router.restore(core, checkpoint, options);
  expect(restored.routing).toEqual({
    restored: ['a.scores.w'],
    dropped: [],
    resynced: ['a.scores.w'],
  });
  restored.group.pump(now);
  expect(seen(restored.group, 'a')).toBe('[true]');
  router.commit('default', () => ['k']);
  restored.group.pump(now);
  expect(seen(restored.group, 'a')).toBe('[true, false]');
});

test('a Grant re-bound to another Store is dropped', () => {
  const { router, def } = setup();
  const core = createCore();
  const group = core.newGroup({ name: 'g' });
  group.load({
    name: 'a',
    source: watcher('"w", "", "changed"'),
    grants: { scores: def.grant('all', 'default') },
  });
  group.script('a')!.deliver({ name: 'start' });
  group.pump(now);
  const checkpoint = router.save(group);
  const { routing } = router.restore(core, checkpoint, {
    name: 'g',
    grants: () => def.grant('all', 'elsewhere'),
    libraries: [],
    onMismatch: 'reject',
    resolve: () => undefined,
  });
  expect(routing).toEqual({
    restored: [],
    dropped: ['a.scores.w'],
    resynced: [],
  });
});
