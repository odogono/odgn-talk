import { expect, test } from 'bun:test';
import { createReplayHost } from '../src/replay';
import {
  compileLibrary,
  defineCapability,
  defineObjectKind,
  exportManifest,
  HostError,
  newGroup,
  nothing,
  parseInstant,
  restore,
  shape,
  type GrantContext,
  type ReleaseHook,
  type SegmentLifecycle,
} from '../src/index';

const now = parseInstant('2026-10-11T12:00:00Z');
const source = 'on go\n  ask api to touch\nend go';
const capability = (release?: ReleaseHook<string>) =>
  defineCapability<string>()(
    'resource',
    {
      touch: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 0 },
        do: () => nothing,
      },
    },
    undefined,
    release,
  );

const releaseLibrary = (value: number) =>
  compileLibrary({
    name: 'helper',
    version: String(value),
    source: `function f\nreturn ${value}\nend f`,
  });

test('Stop releases kept Grants in code-point order before its report, including revoked Grants', () => {
  const events: string[] = [];
  const contexts: GrantContext<string>[] = [];
  const def = capability(c => {
    contexts.push(c);
    events.push(`${c.reason}:${c.grantName}`);
  });
  const group = newGroup({
    name: 'g',
    trace: line => {
      if (line.startsWith('stopped ')) {
        events.push('stopped');
      }
    },
  });
  const script = group.load({
    name: 's',
    source,
    grants: {
      '𐀀': def.grant('all', 'supplementary'),
      '\uE000': def.grant('all', 'bmp'),
      api: def.grant('all', 'binding'),
    },
  });
  script.revoke('api');
  expect(events).toEqual([]);
  group.pump(now);
  script.revoke('api');
  script.revoke('missing');
  group.pump(now);
  expect(events).toEqual(['revoke:api']);
  script.stop('done');
  group.pump(now);
  expect(events).toEqual([
    'revoke:api',
    'stop:api',
    'stop:\uE000',
    'stop:𐀀',
    'stopped',
  ]);
  expect(contexts[1]).toEqual({
    group,
    scriptName: 's',
    grantName: 'api',
    binding: 'binding',
    reason: 'stop',
    now,
  });
  script.stop('again');
  group.pump(now);
  expect(contexts).toHaveLength(4);
});

test('owner disposal releases its Script', () => {
  const contexts: GrantContext<string>[] = [];
  const group = newGroup({ name: 'g' });
  const owner = group.object(
    defineObjectKind({ name: 'release-owner', props: {} }),
    'owner',
    {},
  );
  group.load({
    name: 's',
    source,
    owner,
    grants: { api: capability(c => contexts.push(c)).grant('all', 'binding') },
  });
  group.dispose(owner);
  group.pump(now);
  expect(contexts.map(c => [c.scriptName, c.reason])).toEqual([['s', 'stop']]);
});

test('Stop abandons scopes and rolls back before release, then publishes stopped', () => {
  const events: string[] = [];
  const lifecycle: SegmentLifecycle<string> = {
    begin: () => ({ status: 'ok' }),
    commit: () => ({ status: 'ok' }),
    rollback: () => {
      events.push('rollback');
      return { status: 'ok' };
    },
  };
  const def = defineCapability<string>()(
    'resource',
    {
      open: {
        mode: 'immediate',
        result: shape.nothing,
        cost: { fuel: 0 },
        segmentBound: true,
        scope: { opens: 'file', abandon: 'close' },
        do: c => {
          c.group.script(c.scriptName)!.stop('done');
          return nothing;
        },
      },
      close: {
        mode: 'immediate',
        result: shape.nothing,
        cost: { fuel: 0 },
        segmentBound: true,
        scope: { closes: 'file' },
        do: () => {
          events.push('abandon');
          return nothing;
        },
      },
    },
    lifecycle,
    () => {
      events.push('release');
    },
  );
  const group = newGroup({
    name: 'g',
    trace: line => {
      if (line.startsWith('stopped ')) {
        events.push('stopped');
      }
    },
  });
  const script = group.load({
    name: 's',
    source: 'on go\nask api to open\nend go',
    grants: { api: def.grant('all', 'binding') },
  });
  script.deliver({ name: 'go' });
  group.pump(now);
  expect(events).toEqual(['abandon', 'rollback', 'release', 'stopped']);
});

test('disable release follows each abandonment failure before the next cleanup', () => {
  const events: string[] = [];
  const def = defineCapability<string>()(
    'resource',
    {
      open: {
        mode: 'immediate',
        result: shape.nothing,
        cost: { fuel: 0 },
        scope: { opens: 'file', abandon: 'close' },
        do: () => nothing,
      },
      close: {
        mode: 'immediate',
        result: shape.nothing,
        cost: { fuel: 0 },
        scope: { closes: 'file' },
        do: c => {
          events.push(`abandon:${c.grantName}`);
          throw new Error('failure');
        },
      },
    },
    undefined,
    c => {
      events.push(`${c.reason}:${c.grantName}`);
    },
  );
  const group = newGroup({
    name: 'g',
    trace: line => {
      if (line.startsWith('effect-failure ')) {
        events.push('effect failure');
      }
    },
  });
  const script = group.load({
    name: 's',
    source: 'on go\nask a to open\nask z to open\nend go',
    grants: { a: def.grant('all', 'a'), z: def.grant('all', 'z') },
  });
  script.deliver({ name: 'go' });
  const result = group.pump(now);
  expect(events).toEqual([
    'abandon:z',
    'effect failure',
    'disable:z',
    'abandon:a',
    'effect failure',
    'disable:a',
  ]);
  expect(result.reports.filter(r => r.kind === 'effect failure')).toHaveLength(
    2,
  );
  script.stop('done');
  group.pump(now);
  expect(events.slice(-2)).toEqual(['stop:a', 'stop:z']);
});

test('fatal effect uncertainty releases every Script in load order after rollback', () => {
  const events: string[] = [];
  const def = defineCapability<string>()(
    'resource',
    {
      touch: {
        mode: 'immediate',
        result: shape.nothing,
        cost: { fuel: 0 },
        segmentBound: true,
        do: () => nothing,
      },
    },
    {
      begin: () => ({ status: 'ok' }),
      commit: () => ({ status: 'unknown' }),
      rollback: () => {
        events.push('rollback');
        return { status: 'ok' };
      },
    },
    c => {
      events.push(`${c.reason}:${c.scriptName}`);
    },
  );
  const group = newGroup({
    name: 'g',
    trace: line => {
      if (line.startsWith('stopped ')) {
        events.push(line.split(' ')[1]!);
      }
    },
  });
  group.load({
    name: 'first',
    source,
    grants: { api: def.grant('all', 'first') },
  });
  const second = group.load({
    name: 'second',
    source,
    grants: { api: def.grant('all', 'second') },
  });
  second.deliver({ name: 'go' });
  group.pump(now);
  expect(events).toEqual([
    'rollback',
    'stop:first',
    'first',
    'stop:second',
    'second',
  ]);
});

test('successful Reload releases before new code; rejection, Extend, Save and Restore do not', () => {
  const contexts: GrantContext<string>[] = [];
  const reentries: unknown[] = [];
  const def = capability(c => {
    contexts.push(c);
    try {
      c.group.inspect();
    } catch (error) {
      reentries.push(error);
    }
  });
  const grant = def.grant('all', 'binding');
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source,
    grants: { api: grant },
  });
  group.pump(now);
  expect(() => script.reload('on', 'reset variables')).toThrow();
  script.extend('script variable extra = 1');
  const { group: copy } = restore(group.save(), {
    name: 'restored',
    onMismatch: 'reject',
    grants: () => grant,
    libraries: [],
    resolve: () => undefined,
  });
  expect(contexts).toEqual([]);
  script.reload(source, 'reset variables');
  expect(contexts.map(c => [c.reason, c.now])).toEqual([['reload', now]]);
  expect(reentries[0]).toBeInstanceOf(HostError);
  expect((reentries[0] as HostError).code).toBe('reentrant call');
  copy.queueStop('s', 'copy');
  copy.pump(now);
  expect(contexts[1]!.group).toBe(copy);
  script.stop('stop');
  group.pump(now);
  script.reload(source, 'reset variables');
  expect(contexts.map(c => c.reason)).toEqual([
    'reload',
    'stop',
    'stop',
    'reload',
  ]);
});

test('Library replacement releases only its dependents, only after successful validation', () => {
  const events: string[] = [];
  const def = capability(c => {
    events.push(`${c.scriptName}:${c.reason}`);
  });
  const group = newGroup({ name: 'g' });
  const lib = compileLibrary({
    name: 'helper',
    version: '1',
    source: 'function f\nreturn 1\nend f',
  });
  group.addLibrary(lib);
  group.load({
    name: 's',
    source: 'use f from helper\non go\nreturn f()\nend go',
    grants: { api: def.grant('all', 's') },
  });
  group.load({
    name: 'other',
    source,
    grants: { api: def.grant('all', 'other') },
  });
  expect(() =>
    group.replaceLibrary(
      compileLibrary({
        name: 'helper',
        version: '1',
        source: 'function g\nreturn 2\nend g',
      }),
      'reset variables',
    ),
  ).toThrow();
  expect(events).toEqual([]);
  group.replaceLibrary(
    compileLibrary({
      name: 'helper',
      version: '1',
      source: 'function f\nreturn 2\nend f',
    }),
    'reset variables',
  );
  expect(events).toEqual(['s:reload']);
});

test.each(['ok', 'failed', 'unknown'] as const)(
  'Library replacement completes rollback before release (%s)',
  status => {
    const events: string[] = [];
    const trace: string[] = [];
    const def = defineCapability<string>()(
      'resource',
      {
        touch: {
          mode: 'immediate',
          result: shape.nothing,
          cost: { fuel: 0 },
          segmentBound: true,
          do: () => nothing,
        },
      },
      {
        begin: c => {
          events.push(`begin:${c.scriptName}`);
          return { status: 'ok' };
        },
        commit: () => ({ status: 'ok' }),
        rollback: c => {
          events.push(`rollback:${c.scriptName}`);
          return { status: c.scriptName === 'second' ? status : 'ok' };
        },
      },
      c => {
        events.push(`${c.reason}:${c.scriptName}`);
      },
    );
    const group = newGroup({
      name: 'g',
      trace: line => {
        trace.push(line);
        if (line.startsWith('stopped ')) {
          events.push(`stopped:${line.split(' ')[1]}`);
        } else if (line.startsWith('effect-failure ')) {
          events.push('effect failure');
        }
      },
    });
    group.addLibrary(releaseLibrary(1));
    for (const name of ['first', 'second']) {
      group
        .load({
          name,
          source:
            'use f from helper\non go\nask api to touch\nrepeat forever\nend repeat\nend go',
          grants: { api: def.grant('all', name) },
        })
        .deliver({ name: 'go' });
    }
    group.pump(now, { fuelSlice: 40 });
    expect(events).toEqual(['begin:first', 'begin:second']);
    events.length = 0;
    trace.length = 0;
    const before = group.fingerprint();
    group.replaceLibrary(releaseLibrary(2), 'reset variables');
    const fatal = status !== 'ok';
    const reason = fatal ? 'stop' : 'reload';
    expect(events).toEqual([
      'rollback:first',
      'rollback:second',
      ...(fatal ? ['effect failure'] : []),
      `${reason}:first`,
      'stopped:first',
      `${reason}:second`,
      'stopped:second',
    ]);
    const stopReason = fatal ? 'effect state unknown' : 'reload';
    expect(trace.filter(line => !line.startsWith('> '))).toEqual([
      'effect first/r1.s1 grant=api phase=rollback status=ok',
      `effect second/r1.s1 grant=api phase=rollback status=${status}`,
      ...(fatal
        ? [
            `effect-failure second/r1 grant=api segment=second/r1.s1 phase=rollback status=${status}`,
          ]
        : []),
      `stopped first reason="${stopReason}" discarded=[first/r1]`,
      `stopped second reason="${stopReason}" discarded=[second/r1]`,
    ]);
    if (fatal) {
      expect(group.fingerprint()).toEqual(before);
      expect(() =>
        group.replaceLibrary(releaseLibrary(2), 'reset variables'),
      ).toThrow('effect state unknown');
    } else {
      expect(group.fingerprint()).not.toEqual(before);
    }
  },
);

test('hook exceptions are ignored, worker calls refused, and inputs may be queued', () => {
  const events: string[] = [];
  const reentries: unknown[] = [];
  const def = capability(c => {
    for (const worker of [() => c.group.pump(now), () => c.group.save()]) {
      try {
        worker();
      } catch (error) {
        reentries.push(error);
      }
    }
    c.group.script('s')!.revoke('z');
    events.push(c.grantName);
    throw new Error('cleanup cannot refuse');
  });
  const group = newGroup({ name: 'g' });
  group
    .load({
      name: 's',
      source,
      grants: { api: def.grant('all', 'a'), z: def.grant('all', 'z') },
    })
    .stop('done');
  group.pump(now);
  group.pump(now);
  expect(events.slice(0, 2)).toEqual(['api', 'z']);
  expect(reentries.length).toBe(events.length * 2);
  for (const error of reentries) {
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('reentrant call');
  }
});

test('release hooks are excluded from the Manifest, Fingerprint and save identity', () => {
  const plain = capability().grant('all', 'binding');
  const hooked = capability(() => {
    throw new Error('not executed');
  }).grant('all', 'binding');
  const fingerprint = (grant: typeof plain) => {
    const g = newGroup({ name: 'g' });
    g.load({ name: 's', source, grants: { api: grant } });
    return g.fingerprint();
  };
  expect(fingerprint(hooked)).toEqual(fingerprint(plain));
  expect(
    exportManifest({ kind: 'test', version: '1', grants: { api: hooked } }),
  ).toBe(
    exportManifest({ kind: 'test', version: '1', grants: { api: plain } }),
  );
  const group = newGroup({ name: 'g' });
  group.load({ name: 's', source, grants: { api: plain } });
  expect(() =>
    restore(group.save(), {
      name: 'restored',
      onMismatch: 'reject',
      grants: () => hooked,
      libraries: [],
      resolve: () => undefined,
    }),
  ).not.toThrow();
  expect(() =>
    defineCapability('bad', {}, undefined, 1 as unknown as ReleaseHook<void>),
  ).toThrow(HostError);
});

test('release uses the kept Grants after grantsAsUsed trimming', () => {
  const events: string[] = [];
  const def = capability(c => {
    events.push(c.grantName);
  });
  const group = newGroup({ name: 'g' });
  group
    .load({
      name: 's',
      source,
      grantsAsUsed: true,
      grants: {
        api: def.grant('all', 'used'),
        unused: def.grant('all', 'unused'),
      },
    })
    .stop('done');
  group.pump(now);
  expect(events).toEqual(['api']);
});

// Replay drivers need no new Trace record: the hook follows existing inputs.
test('Trace replay calls the hook at the same revocation, Reload and Stop boundaries', () => {
  const host = createReplayHost(() => '', { scripts: [] });
  const events: string[] = [];
  const def = capability(c => {
    events.push(`${c.reason}:${c.grantName}`);
  });
  host.group.load({
    name: 's',
    source,
    grants: { api: def.grant('all', 'api'), z: def.grant('all', 'z') },
  });
  for (const input of [
    '> revoke s grant=api',
    '> pump clock=2026-10-11T12:00:00Z',
    '> reload s carry=no source="on go" & newline & "end go"',
    '> stop s reason="done"',
    '> pump clock=2026-10-11T12:00:00Z',
  ]) {
    host.apply(input);
  }
  expect(events).toEqual(['revoke:api', 'reload:api', 'reload:z', 'stop:z']);
});

test('a Host Stop reason called reload still releases with stop', () => {
  const reasons: string[] = [];
  const group = newGroup({ name: 'g' });
  const def = capability(c => {
    reasons.push(c.reason);
  });
  group
    .load({ name: 's', source, grants: { api: def.grant('all', 'binding') } })
    .stop('reload');
  group.pump(now);
  expect(reasons).toEqual(['stop']);
});
