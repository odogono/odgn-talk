import { expect, test } from 'bun:test';
import cases from '../../../tools/machine/recovery-cases.json';
import nested from '../../../tools/machine/recovery-nested-cases.json';
import { newGroup, restore, type Group, type PumpOptions } from '../src';
import { restoreGraph, type References } from '../src/snapshot';
import { Run } from '../src/machine';

const state = (bytes: Uint8Array, g: Group) => {
  const saved = JSON.parse(JSON.parse(new TextDecoder().decode(bytes)).payload);
  const refs = (
    g as unknown as { snapshotReferences(): References }
  ).snapshotReferences();
  const decoded = restoreGraph(saved.graph, refs);
  const seen = new Set<object>();
  const work = [decoded];
  while (work.length) {
    const value = work.pop();
    if (
      !value ||
      typeof value !== 'object' ||
      seen.has(value) ||
      refs.byObject.has(value)
    ) {
      continue;
    }
    seen.add(value);
    if (Object.getPrototypeOf(value) === Run.prototype) {
      Object.defineProperty(value, 'persistentState', { value: undefined });
    }
    work.push(
      ...(Object.getPrototypeOf(value) === Map.prototype
        ? [
            ...(value as Map<unknown, unknown>).keys(),
            ...(value as Map<unknown, unknown>).values(),
          ]
        : Object.getPrototypeOf(value) === Set.prototype
          ? [...(value as Set<unknown>)]
          : Object.values(value)),
    );
  }
  return decoded;
};

const output = (lines: string[]) =>
  lines.filter(l => !l.startsWith('> save') && !l.startsWith('> restore'));
const options = (lines: string[]) => ({
  name: 'snapshot',
  onMismatch: 'reject' as const,
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  trace: (l: string) => lines.push(l),
});

for (const fixture of [...cases, ...nested]) {
  for (const pumpOptions of [
    { fuelSlice: 1 },
    { fuelSlice: 7, fuelCap: 3 },
  ] satisfies PumpOptions[]) {
    test(`snapshot at every boundary: ${fixture.name} ${JSON.stringify(pumpOptions)}`, () => {
      const original: string[] = [],
        resumed: string[] = [];
      const g = newGroup({ name: 'snapshot', trace: l => original.push(l) });
      g.load({ name: 's', source: fixture.source });
      g.script('s')!.deliver({ name: 'go' });
      let copy = restore(g.save(), options(resumed)).group;
      for (let step = 0; step < 4000; step++) {
        original.length = 0;
        resumed.length = 0;
        const a = g.pump(BigInt(step), pumpOptions);
        const b = copy.pump(BigInt(step), pumpOptions);
        expect(b).toEqual(a);
        expect(output(resumed)).toEqual(output(original));
        expect(copy.inspect()).toEqual(g.inspect());
        // Includes every local, activation/retained PC and stack, attempt,
        // Segment base, counters and debt, not just the public inspection.
        const saved = g.save();
        expect(state(copy.save(), g)).toEqual(state(saved, g));
        copy = restore(saved, options(resumed)).group;
        if (a.state === 'idle') {
          return;
        }
      }
      throw new Error('Recovery did not finish');
    });
  }
}

import { sha256 } from '../src/sha256';
import { HostError } from '../src/errors';
import type { Graph } from '../src/snapshot';

type Atom = Graph['root'];
class SnapshotEditor {
  constructor(readonly graph: Graph) {}
  node(a: Atom) {
    return this.graph.nodes[Number((a as [string, number])[1])]!;
  }
  get(a: Atom, key: string): Atom {
    return (
      (this.node(a).data as [string, Atom][]).find(p => p[0] === key)?.[1] ?? [
        'undefined',
      ]
    );
  }
  set(a: Atom, key: string, value: Atom) {
    (this.node(a).data as [string, Atom][]).find(p => p[0] === key)![1] = value;
  }
  items(a: Atom) {
    return this.node(a).data as Atom[];
  }
  run() {
    return this.graph.nodes.find(n => n.kind === 'run')!.data as Atom;
  }
  context() {
    return this.items(this.get(this.run(), 'recoveries')).at(-1)!;
  }
  retained() {
    return this.items(this.get(this.context(), 'retained'))[0]!;
  }
  activation() {
    return this.get(this.context(), 'activation');
  }
  pending() {
    return this.get(this.context(), 'pending');
  }
}
const cleanupSource = `function fail
 try
  try
   throw "bad"
  finally
   put 1 into x
  end try
 finally
  put 2 into x
 end try
end fail
function work
 try
  return fail()
 offer recover value
  return value
 end try
end work
on go
 try
  return work()
 catch "bad" before unwind
  choose offer recover(7)
 end try
end go`;
const snapshotIn = (phase: 'selection' | 'offer' | 'catch' | 'nested') => {
  const g = newGroup({ name: 'snapshot' });
  g.load({
    name: 's',
    source:
      phase === 'nested'
        ? nested[0]!.source
        : phase === 'catch'
          ? cleanupSource.replace(
              'catch "bad" before unwind\n  choose offer recover(7)',
              'catch "bad"\n  return 7',
            )
          : cleanupSource,
  });
  g.script('s')!.deliver({ name: 'go' });
  for (let step = 0; step < 300; step++) {
    g.pump(BigInt(step), { fuelCap: 1 });
    const bytes = g.save();
    const saved = JSON.parse(
      JSON.parse(new TextDecoder().decode(bytes)).payload,
    ) as { graph: Graph };
    const e = new SnapshotEditor(saved.graph);
    const contexts = e.items(e.get(e.run(), 'recoveries'));
    if (!contexts.length) {
      continue;
    }
    const pending = e.pending();
    if (
      phase === 'nested'
        ? contexts.length === 2
        : phase === 'selection'
          ? (pending as [string])[0] === 'undefined'
          : Array.isArray(pending) &&
            pending[0] === 'ref' &&
            e.get(pending, 'kind') === phase
    ) {
      return bytes;
    }
  }
  throw new Error(`Missing snapshot phase ${phase}`);
};

const malformed: {
  mutate: (e: SnapshotEditor) => void;
  name: string;
  phase: 'selection' | 'offer' | 'catch' | 'nested';
}[] = [
  {
    name: 'retained code identity',
    phase: 'selection',
    mutate: e => e.set(e.retained(), 'code', ['external', 'unknown']),
  },
  {
    name: 'retained body identity',
    phase: 'selection',
    mutate: e => e.set(e.retained(), 'body', ['external', 'code/s/0/unwind/0']),
  },
  {
    name: 'retained PC',
    phase: 'selection',
    mutate: e => e.set(e.retained(), 'pc', 100_000),
  },
  {
    name: 'retained local layout',
    phase: 'selection',
    mutate: e => {
      e.items(e.get(e.retained(), 'locals')).pop();
    },
  },
  {
    name: 'activation PC',
    phase: 'selection',
    mutate: e => e.set(e.activation(), 'pc', -1),
  },
  {
    name: 'owner cycle',
    phase: 'selection',
    mutate: e => e.set(e.activation(), 'owner', e.activation()),
  },
  {
    name: 'missing owner',
    phase: 'selection',
    mutate: e => e.set(e.activation(), 'owner', ['undefined']),
  },
  {
    name: 'split owner locals',
    phase: 'selection',
    mutate: e => {
      const locals = e.get(e.activation(), 'locals');
      const index = e.graph.nodes.length;
      e.graph.nodes.push(structuredClone(e.node(locals)));
      e.set(e.activation(), 'locals', ['ref', index]);
    },
  },
  {
    name: 'seen catch',
    phase: 'selection',
    mutate: e => {
      const pairs = e.node(e.get(e.context(), 'seen')).data as [Atom, Atom][];
      e.items(pairs[0]![1]).push(999);
    },
  },
  {
    name: 'cancellation phase',
    phase: 'selection',
    mutate: e => e.set(e.run(), 'cancellation', e.get(e.run(), 'frames')),
  },
  {
    name: 'cursor',
    phase: 'selection',
    mutate: e => e.set(e.context(), 'cursor', 999),
  },
  {
    name: 'try table',
    phase: 'selection',
    mutate: e => e.set(e.context(), 'entry', ['external', 'code/s/0/body/0']),
  },
  {
    name: 'phase',
    phase: 'offer',
    mutate: e => e.set(e.pending(), 'kind', 'search'),
  },
  {
    name: 'target PC',
    phase: 'offer',
    mutate: e => e.set(e.pending(), 'pc', 0),
  },
  {
    name: 'target argument count',
    phase: 'offer',
    mutate: e => {
      e.items(e.get(e.pending(), 'args')).pop();
    },
  },
  {
    name: 'target slot',
    phase: 'offer',
    mutate: e => {
      e.items(e.get(e.pending(), 'binds'))[0] = 999;
    },
  },
  {
    name: 'attempt counter rewind',
    phase: 'offer',
    mutate: e => e.set(e.run(), 'offerAttempt', 0),
  },
  {
    name: 'pending attempt',
    phase: 'offer',
    mutate: e => e.set(e.pending(), 'attempt', 99),
  },
  {
    name: 'cleanup reference',
    phase: 'offer',
    mutate: e =>
      e.set(e.context(), 'cleanupEntry', ['external', 'code/s/0/body/0']),
  },
  {
    name: 'cleanup phase',
    phase: 'offer',
    mutate: e => e.set(e.context(), 'cleanup', ['undefined']),
  },
  {
    name: 'cleanup index',
    phase: 'offer',
    mutate: e => e.set(e.items(e.get(e.context(), 'queue'))[0]!, 'index', 999),
  },
  {
    name: 'duplicate cleanup',
    phase: 'offer',
    mutate: e => {
      const queue = e.items(e.get(e.context(), 'queue'));
      queue.push(queue[0]!);
    },
  },
  {
    name: 'catch target',
    phase: 'catch',
    mutate: e => e.set(e.pending(), 'pc', 0),
  },
  {
    name: 'nested boundary cycle',
    phase: 'nested',
    mutate: e => e.set(e.get(e.context(), 'boundary'), 'outer', e.context()),
  },
];
for (const { name, phase, mutate } of malformed) {
  test(`refuse checksummed malformed dispatch: ${name}`, () => {
    const envelope = JSON.parse(
      new TextDecoder().decode(snapshotIn(phase)),
    ) as { hash: string; payload: string };
    const saved = JSON.parse(envelope.payload) as { graph: Graph };
    mutate(new SnapshotEditor(saved.graph));
    envelope.payload = JSON.stringify(saved);
    envelope.hash = sha256(envelope.payload);
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    try {
      restore(bytes, options([]));
      throw new Error('Accepted malformed dispatch');
    } catch (error) {
      expect(error).toBeInstanceOf(HostError);
      expect((error as HostError).code).toBe('invalid save');
    }
  });
}

for (const phase of ['selection', 'offer', 'catch', 'nested'] as const) {
  test(`cancelled dispatch saves every cleanup boundary: ${phase}`, () => {
    const original: string[] = [],
      resumed: string[] = [];
    const saved = snapshotIn(phase);
    const g = restore(saved, options(original)).group;
    let copy = restore(saved, options(resumed)).group;
    g.script('s')!.cancelRun('s/r1');
    copy.script('s')!.cancelRun('s/r1');
    for (let step = 0; step < 300; step++) {
      original.length = 0;
      resumed.length = 0;
      const a = g.pump(10_000n + BigInt(step), { fuelSlice: 1 });
      const b = copy.pump(10_000n + BigInt(step), { fuelSlice: 1 });
      expect(b).toEqual(a);
      expect(output(resumed)).toEqual(output(original));
      expect(copy.inspect()).toEqual(g.inspect());
      const bytes = g.save();
      expect(state(copy.save(), g)).toEqual(state(bytes, g));
      copy = restore(bytes, options(resumed)).group;
      if (a.state === 'idle') {
        return;
      }
    }
    throw new Error('Cancellation did not finish');
  });
}

import { readFileSync } from 'node:fs';
import { compileLibrary, type Library } from '../src';

const readLibraryCase = (file: string) =>
  readFileSync(
    new URL(`../../../corpus/recovery-offers/basic/${file}`, import.meta.url),
    'utf8',
  );

test('Library offers and same-Run callbacks save every boundary and keep attempts increasing', () => {
  const libraries: Library[] = [];
  for (const name of ['rows', 'wrapper']) {
    libraries.push(
      compileLibrary(
        { name, version: '1', source: readLibraryCase(`${name}.talk`) },
        libraries,
      ),
    );
  }
  const original: string[] = [],
    resumed: string[] = [],
    choices: string[] = [];
  const g = newGroup({ name: 'snapshot', trace: l => original.push(l) });
  libraries.forEach(l => g.addLibrary(l));
  g.load({ name: 'reader', source: readLibraryCase('reader.talk') });
  for (const name of ['skipRows', 'replaceRows', 'checkChoices']) {
    g.script('reader')!.deliver({ name });
  }
  const settings = { ...options(resumed), libraries };
  let copy = restore(g.save(), settings).group;
  for (let step = 0; step < 2000; step++) {
    original.length = 0;
    resumed.length = 0;
    const a = g.pump(BigInt(step), { fuelSlice: 1 });
    expect(copy.pump(BigInt(step), { fuelSlice: 1 })).toEqual(a);
    expect(output(resumed)).toEqual(output(original));
    expect(copy.inspect()).toEqual(g.inspect());
    choices.push(
      ...original
        .filter(l => l.startsWith('offer-chosen'))
        .map(l => l.split(' ').slice(1, 3).join(' ')),
    );
    const bytes = g.save();
    expect(state(copy.save(), g)).toEqual(state(bytes, g));
    copy = restore(bytes, settings).group;
    if (a.state === 'idle') {
      expect(choices).toEqual([
        'reader/r1 attempt=1',
        'reader/r2 attempt=1',
        'reader/r3 attempt=1',
        'reader/r3 attempt=2',
      ]);
      expect(g.inspect().scripts[0]!.vars.map(([, v]) => v.toString())).toEqual(
        ['[5, 7]', '[5, 0, 7]', '[0, 0]', '"ccccccuacuac"'],
      );
      return;
    }
  }
  throw new Error('Library recovery did not finish');
});
