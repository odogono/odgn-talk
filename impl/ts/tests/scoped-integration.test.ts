import { expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  exportManifest,
  newGroup,
  nothing,
  parseInstant,
  shape,
  text,
  type Call,
} from '../src/index';

const library = (value: number) =>
  compileLibrary({
    name: 'user',
    version: String(value),
    source: `function one\nreturn ${value}\nend one`,
  });

const now = parseInstant('2026-10-02T00:00:00Z');
const source = 'on go\nask r to open\nend go';

const capability = (
  scope = 'file',
  abandon = 'close',
  segmentBound = false,
  fail = false,
) => {
  const op = {
    mode: 'immediate' as const,
    args: [],
    cost: { fuel: 0 },
    result: shape.nothing,
    segmentBound,
    do: () => nothing,
  };
  return defineCapability<unknown>(
    'resource',
    {
      open: { ...op, scope: { opens: scope, abandon } },
      [abandon]: {
        ...op,
        scope: { closes: scope },
        do: () => {
          if (fail) {
            throw new Error('release failed');
          }
          return nothing;
        },
      },
      unused: op,
    },
    {
      begin: () => ({ status: 'ok' }),
      commit: () => ({ status: 'ok' }),
      rollback: () => ({ status: 'ok' }),
    },
  );
};
const groupOf = (cap = capability(), binding: unknown = 'shared') => {
  const group = newGroup({ name: 'same' });
  group.load({ name: 's', source, grants: { r: cap.grant('all', binding) } });
  return group;
};

test('canonical metadata changes identity, while bindings, hooks and disabled state are excluded', () => {
  const ordinary = groupOf();
  expect(groupOf(capability(), { native: 1 }).fingerprint()).toEqual(
    ordinary.fingerprint(),
  );
  expect(groupOf(capability('lock')).fingerprint()).not.toEqual(
    ordinary.fingerprint(),
  );
  expect(groupOf(capability('file', 'release')).fingerprint()).not.toEqual(
    ordinary.fingerprint(),
  );
  expect(groupOf(capability('file', 'close', true)).fingerprint()).not.toEqual(
    ordinary.fingerprint(),
  );
  const damaged = groupOf(capability('file', 'close', false, true));
  const before = damaged.fingerprint();
  damaged.script('s')!.deliver({ name: 'go' });
  damaged.pump(now);
  expect(damaged.inspect().scripts[0]!.disabledGrants).toEqual(['r']);
  expect(damaged.fingerprint()).toEqual(before);
  expect(before).toEqual(ordinary.fingerprint());
  const manifest = exportManifest({
    kind: 'test',
    version: '1',
    grants: {
      r: capability('file', 'close', true).grant('all', { secret: 'excluded' }),
    },
  });
  expect(manifest).toContain(
    '"scope":{"opens":"file","abandon":"close"},"segmentBound":true',
  );
  expect(manifest).not.toContain('secret');
  expect(manifest).not.toContain('begin');
  expect(manifest.indexOf('"name":"close"')).toBeLessThan(
    manifest.indexOf('"name":"open"'),
  );
});

test('the public API keeps shared Grant templates distinct across Scripts and same-named Groups', () => {
  const calls: Call<string>[] = [];
  const cap = defineCapability<string>('resource', {
    open: {
      mode: 'immediate',
      result: shape.nothing,
      cost: { fuel: 0 },
      scope: { opens: 'file', abandon: 'close' },
      do: call => {
        calls.push(call);
        return nothing;
      },
    },
    close: {
      mode: 'immediate',
      result: shape.nothing,
      cost: { fuel: 0 },
      scope: { closes: 'file' },
      do: call => {
        calls.push(call);
        return nothing;
      },
    },
  });
  const grant = cap.grant('all', 'shared');
  const groups = [newGroup({ name: 'same' }), newGroup({ name: 'same' })];
  for (const group of groups) {
    for (const name of ['a', 'b']) {
      group
        .load({
          name,
          source: 'on go\nask r to open\nask alias to open\nend go',
          grants: { r: grant, alias: grant },
        })
        .deliver({ name: 'go' });
    }
    group.pump(now);
  }
  expect(calls).toHaveLength(16);
  expect(
    new Set(
      calls
        .filter(c => !c.automatic)
        .map(
          c =>
            `${groups.indexOf(c.group)}:${c.scriptName}:${c.runId}:${c.grantName}:${c.scopeName}`,
        ),
    ).size,
  ).toBe(8);
  for (const call of calls.filter(c => c.automatic)) {
    expect(call.signal.aborted).toBe(false);
    expect(call.binding).toBe('shared');
    expect(call.now).toBe(now);
    expect(call.segmentId).toBe(`${call.runId}.s1`);
  }
  expect(() => cap.grant(['open'], 'shared')).toThrow(
    'An opener requires its abandonment Operation',
  );
});

test.each([false, true])(
  'file publication with segmentBound=%s follows the participant, not explicit close',
  segmentBound => {
    const run = (ending: 'complete' | 'fault' | 'fault-open' | 'abandon') => {
      let written = '';
      let provisional = '';
      let closed = false;
      let open = false;
      let publications = 0;
      const op = {
        mode: 'immediate' as const,
        args: [],
        result: shape.nothing,
        cost: { fuel: 0 },
        segmentBound,
      };
      const cap = defineCapability(
        'file',
        {
          open: {
            ...op,
            scope: { opens: 'file', abandon: 'discard' },
            do: () => {
              open = true;
              return nothing;
            },
          },
          write: {
            ...op,
            do: () => {
              if (segmentBound) {
                provisional = 'bytes';
              } else {
                written = 'bytes';
              }
              return nothing;
            },
          },
          close: {
            ...op,
            scope: { closes: 'file' },
            do: () => {
              closed = true;
              open = false;
              return nothing;
            },
          },
          discard: {
            ...op,
            scope: { closes: 'file' },
            do: () => {
              provisional = '';
              open = false;
              return nothing;
            },
          },
        },
        {
          begin: () => ({ status: 'ok' }),
          commit: () => {
            expect(written).toBe(segmentBound ? '' : 'bytes');
            if (closed && provisional) {
              written = provisional;
              publications++;
            }
            return { status: 'ok' };
          },
          rollback: () => {
            provisional = '';
            return { status: 'ok' };
          },
        },
      );
      const group = newGroup({ name: 'file-host' });
      group
        .load({
          name: 's',
          grants: { r: cap.grant('all', undefined) },
          limits: { fuelPerRun: 80 },
          source: `on go\nask r to open\nask r to write\n${ending === 'abandon' || ending === 'fault-open' ? '' : 'ask r to close\n'}${ending.startsWith('fault') ? 'repeat forever\nend repeat' : ''}\nend go`,
        })
        .deliver({ name: 'go' });
      const result = group.pump(now);
      expect(result.reports.find(r => r.kind === 'run end')).toMatchObject({
        outcome: ending.startsWith('fault') ? 'limit fault' : 'completed',
      });
      expect(open).toBe(false);
      return { written, publications };
    };
    expect(run('complete')).toEqual({
      written: 'bytes',
      publications: segmentBound ? 1 : 0,
    });
    expect(run('fault')).toEqual({
      written: segmentBound ? '' : 'bytes',
      publications: 0,
    });
    expect(run('fault-open')).toEqual({
      written: segmentBound ? '' : 'bytes',
      publications: 0,
    });
    expect(run('abandon')).toEqual({
      written: segmentBound ? '' : 'bytes',
      publications: 0,
    });
  },
);

test('Library replacement validates all prospective carry state before cleanup and uses the last Clock', () => {
  const events: string[] = [];
  const op = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    segmentBound: true,
  };
  const cap = defineCapability(
    'resource',
    {
      open: {
        ...op,
        scope: { opens: 'file', abandon: 'close' },
        do: () => nothing,
      },
      close: {
        ...op,
        scope: { closes: 'file' },
        do: call => {
          events.push('abandon');
          expect(call.now).toBe(now);
          expect(() => call.group.save()).toThrow('reentrant call');
          return nothing;
        },
      },
    },
    {
      begin: () => ({ status: 'ok' }),
      commit: () => ({ status: 'ok' }),
      rollback: context => {
        events.push('rollback');
        expect(context.now).toBe(now);
        expect(() => context.group.pump(now)).toThrow('reentrant call');
        return { status: 'ok' };
      },
    },
  );
  const group = newGroup({ name: 'g' });
  group.addLibrary(library(1));
  const grant = cap.grant('all', undefined);
  for (const name of ['a', 'b']) {
    group
      .load({
        name,
        grants: { r: grant },
        limits: { persistentState: 500 },
        source: `use one from user\nscript variable count = "base"\non go\nask r to open\nput "${'x'.repeat(1000)}" into count\nrepeat forever\nend repeat\nend go`,
      })
      .deliver({ name: 'go' });
  }
  const fingerprint = group.fingerprint();
  group.pump(now, { fuelSlice: 2000 });
  expect(group.fingerprint()).toEqual(fingerprint);
  expect(
    group.inspect().scripts.every(s => s.vars[0]![1].asText()!.length === 1000),
  ).toBe(true);
  expect(() =>
    group.replaceLibrary(
      compileLibrary({
        name: 'user',
        version: '2',
        source: 'function other\nreturn 2\nend other',
      }),
      'carry variables',
    ),
  ).toThrow();
  expect(events).toEqual([]);
  const reports = group.replaceLibrary(library(2), 'carry variables');
  expect(events).toEqual(['abandon', 'rollback', 'abandon', 'rollback']);
  expect(reports.filter(r => r.kind === 'stop')).toHaveLength(2);
  expect(
    group.inspect().scripts.every(s => s.vars[0]![1].equals(text('base'))),
  ).toBe(true);
});

test('repair followed by a fresh Script load recovers the Grant without resetting old disablement', () => {
  let damaged = true;
  let acquired = 0;
  const op = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
  };
  const cap = defineCapability('resource', {
    open: {
      ...op,
      scope: { opens: 'file', abandon: 'close' },
      do: () => {
        acquired++;
        return nothing;
      },
    },
    close: {
      ...op,
      scope: { closes: 'file' },
      do: () => {
        if (damaged) {
          throw new Error('damaged');
        }
        return nothing;
      },
    },
  });
  const grant = cap.grant('all', undefined);
  const group = newGroup({ name: 'g' });
  const script = group.load({ name: 's', source, grants: { r: grant } });
  script.deliver({ name: 'go' });
  group.pump(now);
  damaged = false;
  script.deliver({ name: 'go' });
  const refused = group.pump(now).reports.find(r => r.kind === 'run end');
  expect(refused).toMatchObject({
    outcome: 'errored',
    error: { code: 'capability disabled' },
  });
  group
    .load({ name: 'fresh', source, grants: { r: grant } })
    .deliver({ name: 'go' });
  expect(group.pump(now).reports.find(r => r.kind === 'run end')).toMatchObject(
    { outcome: 'completed' },
  );
  expect(acquired).toBe(2);
  expect(group.inspect().scripts.map(s => s.disabledGrants ?? [])).toEqual([
    ['r'],
    [],
  ]);
});
