import { expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  defineObjectKind,
  newGroup,
  nothing,
  parseInstant,
  restore,
  shape,
  ScriptError,
  type GrantContext,
  type Group,
  type HostObject,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
// Opens a scope and enlists a participant, then keeps the Run going.
const busy =
  'ask alpha to open\nask alpha to change\nrepeat forever\nend repeat';

const host = (
  o: {
    abandon?: () => void;
    release?: (context: GrantContext<string>) => void;
    rollback?: 'ok' | 'failed';
  } = {},
) => {
  const events: string[] = [];
  const lines: string[] = [];
  const contexts: GrantContext<string>[] = [];
  const cap = defineCapability<string>(
    'db',
    {
      change: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        segmentBound: true,
        do: () => nothing,
      },
      open: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        scope: { opens: 'tx', abandon: 'close' },
        do: () => nothing,
      },
      close: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        scope: { closes: 'tx' },
        do: call => {
          if (call.automatic) {
            events.push(`abandon:${call.grantName}`);
            o.abandon?.();
          }
          return nothing;
        },
      },
    },
    {
      begin: () => ({ status: 'ok' }),
      commit: () => ({ status: 'ok' }),
      rollback: context => {
        events.push(`rollback:${context.grantName}`);
        return { status: o.rollback ?? 'ok' };
      },
    },
    context => {
      contexts.push(context);
      const reported = lines.some(l =>
        l.startsWith(`stopped ${context.scriptName} `),
      );
      events.push(
        `release:${context.scriptName}:${context.grantName}:${context.reason}${reported ? ':after stop' : ''}`,
      );
      o.release?.(context);
    },
  );
  const plain = defineCapability('plain', {
    noop: {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 1 },
      do: () => nothing,
    },
  });
  return { cap, plain, events, lines, contexts };
};
type Host = ReturnType<typeof host>;

const load = (
  group: Group,
  h: Host,
  name: string,
  body: string,
  owner?: HostObject,
) =>
  group.load({
    name,
    source: `script variable count = 0\non go\n${body}\nend go`,
    // Inserted out of order: release follows code-point order of names.
    grants: {
      zeta: h.cap.grant('all', 'z'),
      other: h.plain.grant('all', undefined),
      alpha: h.cap.grant('all', 'a'),
    },
    ...(owner ? { owner } : {}),
  });

const start = (body = busy, h = host()) => {
  const group = newGroup({ name: 'g', trace: line => h.lines.push(line) });
  const script = load(group, h, 's', body);
  script.deliver({ name: 'go' });
  group.pump(now, { fuelSlice: 40 });
  return { group, script, h };
};

test('Stop releases every kept Grant with a hook, in name order, after rollback and before the report', () => {
  const { group, script, h } = start();
  script.stop('requested');
  group.pump(now + 1n);
  expect(h.events).toEqual([
    'abandon:alpha',
    'rollback:alpha',
    'release:s:alpha:stop',
    'release:s:zeta:stop',
  ]);
  expect(h.contexts[0]).toMatchObject({
    group,
    scriptName: 's',
    grantName: 'alpha',
    binding: 'a',
    now: now + 1n,
    reason: 'stop',
  });
  // Already stopped: no second release.
  script.stop('again');
  group.pump(now + 2n);
  expect(h.events).toHaveLength(4);
});

test('owner disposal releases with stop', () => {
  const h = host();
  const group = newGroup({ name: 'g', trace: line => h.lines.push(line) });
  const owner = group.object(
    defineObjectKind<null>({ name: 'widget', props: {} }),
    'w',
    null,
  );
  load(group, h, 's', busy, owner);
  group.pump(now);
  group.dispose(owner);
  group.pump(now);
  expect(h.events).toEqual(['release:s:alpha:stop', 'release:s:zeta:stop']);
});

test('fatal effect uncertainty releases every Script with stop', () => {
  const h = host({ rollback: 'failed' });
  const { group, script } = start(busy, h);
  load(group, h, 't', '');
  script.stop('requested');
  group.pump(now);
  expect(h.events).toEqual([
    'abandon:alpha',
    'rollback:alpha',
    'release:s:alpha:stop',
    'release:s:zeta:stop',
    'release:t:alpha:stop',
    'release:t:zeta:stop',
  ]);
});

test('a successful Reload releases before the replacement runs; a rejected one does not', () => {
  const h = host({
    release: context => {
      expect(() => context.group.save()).toThrow('reentrant call');
    },
  });
  const { group, script } = start(busy, h);
  expect(() => script.reload('on', 'carry variables')).toThrow();
  expect(h.events).toEqual([]);
  script.reload(
    'script variable count = 0\non go\nask alpha to change\nend go',
    'carry variables',
  );
  expect(h.events).toEqual([
    'abandon:alpha',
    'rollback:alpha',
    'release:s:alpha:reload',
    'release:s:zeta:reload',
  ]);
  // Extend, Save and Restore never release.
  script.extend('on more\nend more');
  const saved = group.save();
  const grants = {
    zeta: h.cap.grant('all', 'z'),
    other: h.plain.grant('all', undefined),
    alpha: h.cap.grant('all', 'a'),
  };
  restore(saved, {
    name: 'restored',
    onMismatch: 'reject',
    libraries: [],
    grants: (_script, name) => grants[name as keyof typeof grants],
    resolve: () => {
      throw new Error('no objects');
    },
  });
  expect(h.events).toHaveLength(4);
});

test('a fatal rollback during Reload releases with stop, not reload', () => {
  const { script, h } = start(busy, host({ rollback: 'failed' }));
  script.reload('script variable count = 9', 'carry variables');
  expect(h.events.filter(e => e.startsWith('release:'))).toEqual([
    'release:s:alpha:stop',
    'release:s:zeta:stop',
  ]);
});

const user = (version: string) =>
  compileLibrary({
    name: 'user',
    version,
    source: `function answer\nreturn ${version}\nend answer`,
  });
test('Library replacement that reloads a Script releases with reload', () => {
  const h = host();
  const group = newGroup({ name: 'g' });
  group.addLibrary(user('1'));
  group.load({
    name: 's',
    source: 'use answer from user\non go\nreturn answer()\nend go',
    grants: { alpha: h.cap.grant('all', 'a') },
  });
  expect(() =>
    group.replaceLibrary(
      compileLibrary({
        name: 'user',
        version: '2',
        source: 'function other\nend other',
      }),
      'carry variables',
    ),
  ).toThrow();
  expect(h.events).toEqual([]);
  group.replaceLibrary(user('2'), 'carry variables');
  expect(h.events).toEqual(['release:s:alpha:reload']);
});

test('revocation releases once, when drained', () => {
  const { group, script, h } = start('');
  script.revoke('alpha');
  expect(h.events).toEqual([]);
  group.pump(now);
  expect(h.events).toEqual(['release:s:alpha:revoke']);
  script.revoke('alpha');
  script.revoke('missing');
  script.revoke('other');
  group.pump(now);
  expect(h.events).toEqual(['release:s:alpha:revoke']);
  // A later Stop includes the revoked Grant.
  script.stop('requested');
  group.pump(now);
  expect(h.events.slice(1)).toEqual([
    'release:s:alpha:stop',
    'release:s:zeta:stop',
  ]);
});

test('failed automatic abandonment releases with disable before rollback', () => {
  const h = host({
    abandon: () => {
      throw new ScriptError('broken', 'broken');
    },
  });
  const { group, script } = start(busy, h);
  script.stop('requested');
  group.pump(now);
  expect(h.events).toEqual([
    'abandon:alpha',
    'release:s:alpha:disable',
    'rollback:alpha',
    'release:s:alpha:stop',
    'release:s:zeta:stop',
  ]);
});

test('the Core ignores what a release hook throws, and inputs it queues land later', () => {
  const h = host({
    release: context => {
      context.group.script('t')!.deliver({ name: 'go' });
      throw new Error('ignored');
    },
  });
  const { group, script } = start(busy, h);
  load(group, h, 't', 'put 1 into count');
  script.stop('requested');
  expect(() => group.pump(now)).not.toThrow();
  expect(h.events.filter(e => e.startsWith('release:'))).toEqual([
    'release:s:alpha:stop',
    'release:s:zeta:stop',
  ]);
  group.pump(now);
  expect(group.inspect().scripts.find(s => s.name === 't')).toBeDefined();
});

test('a release hook is not a Segment lifecycle and does not change identity', () => {
  expect(() => defineCapability('bad', {}, undefined, 'no' as never)).toThrow(
    'A release hook must be a function',
  );
  const h = host();
  const without = defineCapability<string>(
    'db',
    Object.fromEntries(h.cap.operations),
    {
      begin: () => ({ status: 'ok' }),
      commit: () => ({ status: 'ok' }),
      rollback: () => ({ status: 'ok' }),
    },
  );
  const fingerprint = (cap: typeof without) => {
    const group = newGroup({ name: 'g' });
    group.load({
      name: 's',
      source: '',
      grants: { alpha: cap.grant('all', 'a') },
    });
    return group.fingerprint();
  };
  expect(fingerprint(h.cap)).toEqual(fingerprint(without));
});
