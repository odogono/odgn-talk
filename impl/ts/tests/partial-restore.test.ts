// Partial Restore (spec chapter 10, ADR 0143): under 'reload changed', a
// mismatch only in Script code continues the matched Scripts and rebuilds the
// changed ones as a Reload with carried variables would leave them.
import { expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  newGroup,
  restore,
  shape,
  type Group,
  type RestoreOptions,
  type ScriptSources,
} from '../src';
import { operationalReports } from './operational-reports';

const later = 100_000_000_000n;
const fmt = (version: string) =>
  compileLibrary({
    name: 'fmt',
    version,
    source: `function label x\n  return "${version}" & x\nend label`,
  });
const options = (
  trace: string[] = [],
  libraries = [fmt('2')],
): RestoreOptions => ({
  name: 'g',
  trace: line => trace.push(line),
  libraries,
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reload changed',
});
// Scripts that import fmt change with it; the others match.
const group = (scripts: Record<string, string>) => {
  const g = newGroup({ name: 'g' });
  g.addLibrary(fmt('1'));
  for (const [name, source] of Object.entries(scripts)) {
    g.load({ name, source });
  }
  return g;
};
const vars = (g: Group) =>
  Object.fromEntries(
    g
      .inspect()
      .scripts.map(s => [
        s.name,
        Object.fromEntries(s.vars.map(([k, v]) => [k, v.toString()])),
      ]),
  );
const runEnds = (g: Group, now: bigint) =>
  operationalReports(g.pump(now).reports).filter(r => r.kind === 'run end');

test('the matched Script resumes and the changed Script carries its variables', () => {
  const g = group({
    a: 'use label from fmt\nscript variable n = 0\non go\n  add 1 to n\n  wait 10 s\n  add 1 to n\nend go\non show\n  return label(n)\nend show',
    b: 'script variable m = 0\non go\n  add 1 to m\n  wait 10 s\n  add 1 to m\nend go',
  });
  g.script('a')!.deliver({ name: 'go' });
  g.script('b')!.deliver({ name: 'go' });
  g.pump(0n);
  const trace: string[] = [];
  const { group: copy, result } = restore(g.save(), options(trace));
  expect(result).toMatchObject({
    variablesOnly: false,
    reloaded: ['a'],
    discardedRuns: ['a/r1'],
    droppedMessages: [],
    abandonedCalls: [],
    pending: [],
  });
  expect(result.reports).toContainEqual({
    kind: 'stop',
    script: 'a',
    reason: 'reload',
    discardedRuns: ['a/r1'],
    droppedMessages: [],
    pendingCalls: [],
  });
  expect(result.reports).toContainEqual(
    expect.objectContaining({
      kind: 'run accounting',
      run: 'a/r1',
      state: 'discarded',
    }),
  );
  expect(trace.at(-1)).toContain('mismatch=reload-changed fingerprint=');
  expect(trace.at(-1)).toContain('mode=partial reloaded=[a] discarded=[a/r1]');
  expect(runEnds(copy, later)).toMatchObject([
    { run: 'b/r1', outcome: 'completed' },
  ]);
  expect(vars(copy)).toEqual({ a: { n: '1' }, b: { m: '2' } });
  // The rebuilt Script runs its new code.
  copy.script('a')!.deliver({ name: 'show' });
  const [shown] = runEnds(copy, later);
  expect(shown?.kind === 'run end' && shown.result?.toString()).toBe('"21"');
  expect(vars(copy).a).toEqual({ n: '1' });
});

test('a matched Script waiting on a changed Script gets send failed', () => {
  const g = group({
    a: 'use label from fmt\non go\n  wait 10 s\n  return 1\nend go',
    b: 'on start\n  send to a: go and wait\nend start',
  });
  g.script('b')!.deliver({ name: 'start' });
  g.pump(0n);
  const { group: copy, result } = restore(g.save(), options());
  expect(result.reloaded).toEqual(['a']);
  expect(result.discardedRuns).toEqual(['a/r1']);
  expect(runEnds(copy, later)).toMatchObject([
    {
      run: 'b/r1',
      outcome: 'errored',
      error: expect.objectContaining({ code: 'send failed' }),
    },
  ]);
});

test('a Join Member waiting on a changed Script fails its Join', () => {
  const g = group({
    a: 'use label from fmt\non go\n  wait 10 s\n  return 1\nend go',
    b: 'on start\n  wait for all\n    send go to a and wait\n    send go to c and wait\n  end wait\nend start',
    c: 'on go\n  wait 20 s\nend go',
  });
  g.script('b')!.deliver({ name: 'start' });
  g.pump(0n);
  const { group: copy, result } = restore(g.save(), options());
  expect(result.reloaded).toEqual(['a']);
  expect(runEnds(copy, later).find(r => r.run === 'b/r1')).toMatchObject({
    outcome: 'errored',
    error: expect.objectContaining({ code: 'send failed' }),
  });
});

test('a Function Value homed in a changed Script is stale', () => {
  const g = group({
    a: 'use label from fmt\non make\n  send to b: keep (given x: x + 1)\nend make',
    b: 'script variable f = nothing\non keep g\n  put g into f\nend keep\non useit\n  f(1) and wait\n  return it\nend useit',
  });
  g.script('a')!.deliver({ name: 'make' });
  g.pump(0n);
  const exact = restore(g.save(), { ...options(), libraries: [fmt('1')] });
  exact.group.script('b')!.deliver({ name: 'useit' });
  const kept = runEnds(exact.group, 1n).find(r => r.script === 'b');
  expect(kept).toMatchObject({ outcome: 'completed' });
  expect(kept?.kind === 'run end' && kept.result?.toString()).toBe('2');
  const { group: copy, result } = restore(g.save(), options());
  expect(result.reloaded).toEqual(['a']);
  copy.script('b')!.deliver({ name: 'useit' });
  expect(runEnds(copy, 1n).find(r => r.script === 'b')).toMatchObject({
    outcome: 'errored',
    error: expect.objectContaining({ code: 'function gone' }),
  });
});

test('a Library change reloads only the Scripts that import it, directly or not', () => {
  const v1 = fmt('1');
  const wrap = (f: ReturnType<typeof fmt>) =>
    compileLibrary(
      {
        name: 'wrap',
        version: '1',
        source:
          'use label from fmt\nfunction wrapped x\n  return label(x)\nend wrapped',
      },
      [f],
    );
  const g = newGroup({ name: 'g' });
  g.addLibrary(v1);
  g.addLibrary(wrap(v1));
  const waiting = 'on go\n  wait 10 s\nend go';
  g.load({ name: 'a', source: `use label from fmt\n${waiting}` });
  g.load({ name: 'b', source: waiting });
  g.load({ name: 'c', source: `use wrapped from wrap\n${waiting}` });
  for (const name of ['a', 'b', 'c']) {
    g.script(name)!.deliver({ name: 'go' });
  }
  g.pump(0n);
  const v2 = fmt('2');
  const { group: copy, result } = restore(
    g.save(),
    options([], [v2, wrap(v2)]),
  );
  expect(result.reloaded).toEqual(['a', 'c']);
  expect(result.discardedRuns).toEqual(['a/r1', 'c/r1']);
  expect(runEnds(copy, later)).toMatchObject([
    { run: 'b/r1', outcome: 'completed' },
  ]);
});

const sources = (a: ScriptSources): RestoreOptions => ({
  ...options(),
  libraries: [],
  scriptSources: () => a,
});

test('a changed Script over its Persistent State cap fails the whole restore', () => {
  const filled = 'x'.repeat(30);
  const source = `script variable s = ""\non fill\n  put "${filled}" into s\nend fill`;
  const g = newGroup({ name: 'g' });
  g.load({ name: 'a', source, limits: { persistentState: 100 } });
  g.script('a')!.deliver({ name: 'fill' });
  g.pump(0n);
  const bytes = g.save({ sources: 'external' });
  const fits = restore(bytes, sources({ source: `${source}\n-- edited` }));
  expect(fits.result.reloaded).toEqual(['a']);
  expect(vars(fits.group).a).toEqual({ s: `"${filled}"` });
  // It loads within the cap, but not with the carried `s`.
  const grown = `${source}\nscript variable t = "${'z'.repeat(50)}"`;
  expect(() => restore(bytes, sources({ source: grown }))).toThrow(
    expect.objectContaining({ code: 'state too large' }),
  );
});

const host = (fuel: number) =>
  defineCapability('host', {
    next: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel },
      start: () => {},
    },
  }).grant('all', undefined);

test('a mixed mismatch falls back to a whole-Group variables-only restore', () => {
  const g = newGroup({ name: 'g' });
  g.addLibrary(fmt('1'));
  const waiting = 'on go\n  wait 10 s\nend go';
  g.load({ name: 'a', source: `use label from fmt\n${waiting}` });
  g.load({ name: 'b', source: waiting, grants: { host: host(1) } });
  g.script('a')!.deliver({ name: 'go' });
  g.script('b')!.deliver({ name: 'go' });
  g.pump(0n);
  const trace: string[] = [];
  const { result } = restore(g.save(), {
    ...options(trace),
    grants: (script, name) =>
      script === 'b' && name === 'host' ? host(2) : undefined,
  });
  expect(result).toMatchObject({
    variablesOnly: true,
    reloaded: [],
    discardedRuns: ['a/r1', 'b/r1'],
  });
  expect(trace.at(-1)).toContain('mismatch=reload-changed');
  expect(trace.at(-1)).toContain('mode=variables-only');
});

test('a changed Script with an open Decision is undecided at the first Pump', () => {
  const g = group({
    a: 'use label from fmt\non go, deciding\n  repeat forever\n  end repeat\nend go',
  });
  g.script('a')!.decide({ name: 'go' });
  g.pump(0n, { fuelSlice: 5 });
  const { group: copy, result } = restore(g.save(), options());
  expect(result.reports.some(r => r.kind === 'decided')).toBe(false);
  expect(
    operationalReports(copy.pump(1n).reports).filter(r => r.kind === 'decided'),
  ).toMatchObject([
    {
      delivery: 'd1',
      verdict: 'undecided',
      undecided: [{ script: 'a', run: 'a/r1', outcome: 'cancelled' }],
    },
  ]);
});

test('a changed Script abandons its pending calls, and a matched one keeps them', () => {
  const hold = defineCapability('api', {
    hold: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 1 },
      start: () => {},
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(fmt('1'));
  const asking = 'on go\n  ask api to hold and wait\nend go';
  g.load({
    name: 'a',
    source: `use label from fmt\n${asking}`,
    grants: { api: hold.grant('all', undefined) },
  });
  g.load({
    name: 'b',
    source: asking,
    grants: { api: hold.grant('all', undefined) },
  });
  g.script('a')!.deliver({ name: 'go' });
  g.script('b')!.deliver({ name: 'go' });
  g.pump(0n);
  const { result } = restore(g.save(), {
    ...options(),
    grants: () => hold.grant('all', undefined),
  });
  expect(result.reloaded).toEqual(['a']);
  expect(result.abandonedCalls).toEqual(['a/r1.c1']);
  expect(result.pending.map(p => p.id)).toEqual(['b/r1.c1']);
});

test('external sources: a changed bundle, including one with fewer extensions, reloads only that Script', () => {
  const sources = {
    s: {
      source: 'script variable n = 0',
      extensions: [
        'on go\n  add 1 to n\n  wait 10 s\nend go',
        'on more\n  return n\nend more',
      ],
    },
    t: {
      source: 'script variable m = 0\non go\n  wait 10 s\n  add 1 to m\nend go',
    },
  };
  const g = newGroup({ name: 'g' });
  for (const [name, bundle] of Object.entries(sources)) {
    g.load({ name, source: bundle.source });
    for (const source of 'extensions' in bundle ? bundle.extensions : []) {
      g.script(name)!.extend(source);
    }
    g.script(name)!.deliver({ name: 'go' });
  }
  g.pump(0n);
  const bytes = g.save({ sources: 'external' });
  for (const s of [
    { ...sources.s, extensions: [sources.s.extensions[0]!] },
    { ...sources.s, extensions: [sources.s.extensions[0] + '\n-- edited'] },
  ]) {
    const { group: copy, result } = restore(bytes, {
      ...options(),
      libraries: [],
      scriptSources: ({ name }) => (name === 's' ? s : sources.t),
    });
    expect(result).toMatchObject({
      variablesOnly: false,
      reloaded: ['s'],
      discardedRuns: ['s/r1'],
    });
    expect(runEnds(copy, later)).toMatchObject([
      { run: 't/r1', outcome: 'completed' },
    ]);
    expect(vars(copy)).toEqual({ s: { n: '1' }, t: { m: '1' } });
  }
  const exact = restore(bytes, {
    ...options(),
    libraries: [],
    scriptSources: ({ name }) => sources[name as 's' | 't'],
  });
  expect(exact.result).toMatchObject({ variablesOnly: false, reloaded: [] });
});
