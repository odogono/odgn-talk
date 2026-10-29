import { expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  newGroup,
  num,
  restore,
  shape,
  type Call,
  type RestoreOptions,
  type ScriptSources,
} from '../src';
import { operationalReports } from './operational-reports';
import { editSave, recordsOf } from './save-edit';

const options = (sources: Record<string, ScriptSources>): RestoreOptions => ({
  name: 'g',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject',
  scriptSources: ({ name }) => sources[name],
});
const external = { sources: 'external' } as const;

test('external sources restore Libraries, extensions, captures, waits and cross-Script replies exactly', () => {
  const library = compileLibrary({
    name: 'utility',
    version: '1',
    source: 'constant offset = 2',
  });
  const sources = {
    s: {
      source:
        'use offset from utility\nscript variable callback = nothing\nscript variable n = 0',
      extensions: [
        'on make x\n  put (given y: x + y) into callback\n  wait for answer value\n  put value into n\nend make',
        'on useit\n  return callback(n) + offset\nend useit\non invoke\n  send to t: go and wait\n  add it to n\nend invoke',
      ],
    },
    t: { source: 'on go\n  wait 2 s\n  return 8\nend go' },
  };
  const original = newGroup({ name: 'g' });
  original.addLibrary(library);
  for (const [name, bundle] of Object.entries(sources)) {
    original.load({ name, source: bundle.source });
    if ('extensions' in bundle) {
      for (const source of bundle.extensions) {
        original.script(name)!.extend(source);
      }
    }
  }
  original.script('s')!.deliver({ name: 'make', args: [num(4)] });
  original.script('s')!.deliver({ name: 'invoke' });
  original.pump(0n);
  const bytes = original.save(external);
  expect(recordsOf(bytes).records.sources).toBeUndefined();
  const requests: string[] = [];
  const opts = { ...options(sources), libraries: [library] };
  const { group: copy, result } = restore(bytes, {
    ...opts,
    scriptSources: request => {
      requests.push(request.name);
      expect(request.identities).toHaveLength(request.name === 's' ? 3 : 1);
      return opts.scriptSources!(request);
    },
  });
  expect(requests).toEqual(['s', 't']);
  expect(result.variablesOnly).toBe(false);
  expect(copy.fingerprint()).toEqual(original.fingerprint());
  const embedded = restore(original.save(), {
    ...opts,
    scriptSources: () => {
      throw new Error('Embedded saves do not resolve sources');
    },
  }).group;
  for (const g of [original, copy, embedded]) {
    g.script('s')!.deliver({ name: 'answer', args: [num(3)] });
    g.script('s')!.deliver({ name: 'useit' });
  }
  for (const clock of [1n, 3_000_000n]) {
    const expected = original.pump(clock);
    expect(copy.pump(clock)).toEqual(expected);
    expect(embedded.pump(clock)).toEqual(expected);
    expect(copy.inspect()).toEqual(original.inspect());
  }
});

test('missing bundles always fail; changed code requires explicit whole-Group variables-only recovery', () => {
  const sources = {
    a: {
      source: 'script variable n = 0\non go\n  add 1 to n\n  wait 10 s\nend go',
    },
    b: { source: 'on go\n  wait 10 s\nend go' },
  };
  const g = newGroup({ name: 'g' });
  for (const [name, bundle] of Object.entries(sources)) {
    g.load({ name, source: bundle.source });
    g.script(name)!.deliver({ name: 'go' });
  }
  g.pump(0n);
  g.script('b')!.deliver({ name: 'go' });
  const bytes = g.save(external);
  expect(() =>
    restore(bytes, { ...options({}), onMismatch: 'variables only' }),
  ).toThrow(expect.objectContaining({ code: 'save mismatch' }));
  const current = {
    ...sources,
    a: { source: sources.a.source + '\n-- updated code' },
  };
  expect(() => restore(bytes, options(current))).toThrow(
    expect.objectContaining({ code: 'save mismatch' }),
  );
  const { group: copy, result } = restore(bytes, {
    ...options(current),
    onMismatch: 'variables only',
  });
  expect(result).toMatchObject({
    variablesOnly: true,
    discardedRuns: ['a/r1', 'b/r1'],
    droppedMessages: ['d3'],
    pending: [],
  });
  expect(copy.inspect().scripts[0]!.vars).toEqual([['n', num(1)]]);
  expect(copy.script('a')!.counters().fuelTotal).toBe(
    g.script('a')!.counters().fuelTotal,
  );
  expect(copy.script('b')!.deliver({ name: 'go' })).toBe('d4');
});

test('changed code carries rollback-base variables and preserves accounting for preempted Runs', () => {
  const source =
    'script variable n = 0\non go\n  add 1 to n\n  repeat forever\n  end repeat\nend go';
  const g = newGroup({ name: 'g' });
  g.load({ name: 's', source });
  g.script('s')!.deliver({ name: 'go' });
  g.pump(0n, { fuelSlice: 100 });
  expect(g.inspect().scripts[0]!.vars).toEqual([['n', num(1)]]);
  const exact = restore(g.save(external), options({ s: { source } })).group;
  expect(exact.pump(1n, { fuelSlice: 100 })).toEqual(
    g.pump(1n, { fuelSlice: 100 }),
  );
  const { group, result } = restore(g.save(external), {
    ...options({ s: { source: source + '\n-- changed' } }),
    onMismatch: 'variables only',
  });
  expect(group.inspect().scripts[0]!.vars).toEqual([['n', num(0)]]);
  expect(result.discardedRuns).toEqual(['s/r1']);
  expect(result.reports).toContainEqual(
    expect.objectContaining({
      kind: 'run accounting',
      fuel: 200,
      state: 'discarded',
    }),
  );
});

const grant = (fuel: number) =>
  defineCapability('host', {
    next: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel },
      start: () => {},
    },
  }).grant('all', undefined);

test('changed extensions stale carried Functions; changed Library and Grant declarations cannot resume saved Runs', () => {
  const source = 'use n from utility\nscript variable callback = nothing';
  const extension =
    'on make x\n  put (given y: x + y + n) into callback\n  wait 10 s\nend make\non useit\n  return callback(1)\nend useit';
  const library = compileLibrary({
    name: 'utility',
    version: '1',
    source: 'constant n = 1',
  });
  const original = newGroup({ name: 'g' });
  original.addLibrary(library);
  original.load({ name: 's', source, grants: { host: grant(1) } });
  original.script('s')!.extend(extension);
  original.script('s')!.deliver({ name: 'make', args: [num(4)] });
  original.pump(0n);
  const bytes = original.save(external);
  const opts = {
    ...options({ s: { source, extensions: [extension] } }),
    libraries: [library],
    grants: () => grant(1),
  };
  const changes = [
    {
      scriptSources: () => ({
        source,
        extensions: [extension + '\n-- edited'],
      }),
    },
    {
      libraries: [
        compileLibrary({
          name: 'utility',
          version: '2',
          source: 'constant n = 2',
        }),
      ],
    },
    { grants: () => grant(2) },
  ];
  for (const change of changes) {
    expect(() => restore(bytes, { ...opts, ...change })).toThrow(
      expect.objectContaining({ code: 'save mismatch' }),
    );
    const { group, result } = restore(bytes, {
      ...opts,
      ...change,
      onMismatch: 'variables only',
    });
    expect(result.discardedRuns).toEqual(['s/r1']);
    group.script('s')!.deliver({ name: 'useit' });
    expect(operationalReports(group.pump(1n).reports)[0]).toMatchObject({
      outcome: 'errored',
      error: expect.objectContaining({ code: 'function gone' }),
    });
  }
});

test('external pending calls keep IDs, declaration costs and settlement ordering', () => {
  const calls: Call<void>[] = [];
  const grant = defineCapability('host', {
    next: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 100 },
      start: call => {
        calls.push(call);
      },
    },
  }).grant('all', undefined);
  const source =
    'script variable seen = []\non go\n  ask host to next and wait\n  put it after seen\nend go';
  const g = newGroup({ name: 'g' });
  g.load({ name: 's', source, grants: { host: grant } });
  for (let i = 0; i < 3; i++) {
    g.script('s')!.deliver({ name: 'go' });
  }
  g.pump(0n);
  const opts = { ...options({ s: { source } }), grants: () => grant };
  const bytes = g.save(external);
  const { group, result } = restore(bytes, opts);
  expect(result.pending.map(p => p.id)).toEqual([
    's/r1.c1',
    's/r2.c1',
    's/r3.c1',
  ]);
  group.settle('s/r1.c1', { reissue: true });
  group.settle('s/r2.c1', { answer: num(2) });
  const adopted = group.settle('s/r3.c1', { adopt: true })!;
  expect(group.pump(1n).fuelUsed).toBeLessThan(100);
  expect(calls.at(-1)!.id).toBe('s/r1.c1');
  calls.at(-1)!.answer(num(1));
  adopted.answer(num(3));
  group.pump(2n);
  expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('[2, 1, 3]');
  const changed = restore(bytes, {
    ...opts,
    onMismatch: 'variables only',
    scriptSources: () => ({ source: source + '\n-- changed' }),
  });
  expect(changed.result.abandonedCalls).toEqual([
    's/r1.c1',
    's/r2.c1',
    's/r3.c1',
  ]);
});

test('unbound external Grants still compile revoked', () => {
  const source = 'on go\n  ask host to next and wait\nend go';
  const grant = defineCapability('host', {
    next: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 1 },
      start: () => {},
    },
  }).grant('all', undefined);
  const g = newGroup({ name: 'g' });
  const sources: Record<string, ScriptSources> = {};
  for (let i = 0; i < 6; i++) {
    const name = `s${i}`;
    sources[name] = { source };
    g.load({ name, source, grants: { host: grant } });
  }
  const bytes = g.save(external);
  const { group, result } = restore(bytes, options(sources));
  expect(result.variablesOnly).toBe(false);
  group.script('s0')!.deliver({ name: 'go' });
  expect(operationalReports(group.pump(0n).reports)[0]).toMatchObject({
    outcome: 'errored',
    error: expect.objectContaining({ code: 'capability revoked' }),
  });
});

const sizes = (count: number, padding: number) => {
  const g = newGroup({ name: 'g' });
  for (let i = 0; i < count; i++) {
    g.load({
      name: `s${i}`,
      source: 'script variable n = 0\n-- ' + 'x'.repeat(padding),
    });
  }
  return { external: g.save(external).length, embedded: g.save().length };
};

test('external snapshot size is independent of source length and scales with Script metadata', () => {
  for (const count of [1, 6, 12]) {
    const small = sizes(count, 100),
      large = sizes(count, 10_000);
    expect(large.external).toBe(small.external);
    // Each source's length prefix grows by a byte, and the sources
    // section's own length by at most two more.
    const grown = large.embedded - small.embedded - count * 9901;
    expect(grown).toBeGreaterThanOrEqual(0);
    expect(grown).toBeLessThanOrEqual(2);
  }
  expect(sizes(12, 100).external).toBeLessThan(sizes(6, 100).external * 2);
});

test('invalid objects, references, declarations and old formats fail before Host resolution', () => {
  const g = newGroup({ name: 'g' });
  g.load({ name: 's', source: 'on go\n  wait 1 s\nend go' });
  g.script('s')!.deliver({ name: 'go' });
  g.pump(0n);
  const bytes = g.save(external);
  // eslint-disable-next-line unicorn/consistent-function-scoping -- It closes over the test's options.
  const restoring = (b: Uint8Array) => () =>
    restore(b, {
      ...options({}),
      scriptSources: () => {
        throw new Error('Source callback ran');
      },
      resolve: () => {
        throw new Error('Object callback ran');
      },
    });
  const grant = {
    name: 'ui',
    declarations: '{"capability":"host","operations":[]}',
    capability: 'host',
    operations: [
      {
        name: 'next',
        mode: 'suspending',
        required: 0,
        args: 0,
        command: false,
        labels: [],
      },
    ],
    revoked: false,
    disabled: false,
  };
  for (const edited of [
    // An old JSON save.
    new TextEncoder().encode('{"hash":"","payload":{}}'),
    // A Script named twice.
    editSave(bytes, x => {
      x.scripts.push({ ...x.scripts[0]! });
      x.perScript.push(0);
      x.work.push([]);
    }),
    // A Grant whose kept Operation its declarations don't have.
    editSave(bytes, x => {
      x.scripts[0]!.grants.push(grant);
    }),
    // Declarations that aren't Host Manifest JSON.
    editSave(bytes, x => {
      x.scripts[0]!.grants.push({
        ...grant,
        declarations: 'invalid',
        operations: [],
      });
    }),
    // A Run counted for a Script the save doesn't hold.
    editSave(bytes, x => {
      x.perScript.push(1);
    }),
  ]) {
    expect(restoring(edited)).toThrow(
      expect.objectContaining({ code: 'invalid save' }),
    );
  }
});
