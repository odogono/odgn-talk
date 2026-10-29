import { operationalResult } from './operational-reports';
import { expect, test } from 'bun:test';
import cases from '../../../tools/machine/recovery-cases.json';
import nested from '../../../tools/machine/recovery-nested-cases.json';
import { newGroup, restore, type PumpOptions } from '../src';
import { stateFingerprint } from '../src/save-format';

// Every required section of a save: its whole state, Run by Run.
const state = (bytes: Uint8Array) =>
  Buffer.from(stateFingerprint(bytes)).toString('hex');

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
        expect(state(copy.save())).toEqual(state(saved));
        copy = restore(saved, options(resumed)).group;
        if (a.state === 'idle') {
          return;
        }
      }
      throw new Error('Recovery did not finish');
    });
  }
}

import { HostError } from '../src/errors';
import type {
  ControlRecord,
  RunRecord,
  SaveRecords,
} from '../src/save-records';
import { editSave, recordsOf, rawValue, type RawValue } from './save-edit';

// A decoded save's Run and its error control records.
class SnapshotEditor {
  constructor(readonly records: SaveRecords<RawValue>) {}
  run(): RunRecord<RawValue> {
    return this.records.runs[0]!;
  }
  controls(): ControlRecord<RawValue>[] {
    return this.run()?.controls ?? [];
  }
  control() {
    return this.controls().at(-1)!;
  }
  dispatch() {
    return [...this.controls()]
      .reverse()
      .find(c => c.k === 'dispatch') as Extract<
      ControlRecord<RawValue>,
      { k: 'dispatch' }
    >;
  }
  cleanup() {
    return this.control() as Extract<ControlRecord<RawValue>, { k: 'cleanup' }>;
  }
  search() {
    return this.dispatch().search;
  }
  held() {
    return this.dispatch().held[0]!;
  }
  then() {
    return this.cleanup().then as Record<string, unknown> & { k: string };
  }
  steps() {
    return this.cleanup().cleanups;
  }
  step() {
    return this.steps().find(s => !s.leave)!;
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
// A `try` inside a `finally` block a transfer runs: its catch dispatch sits
// above the transfer's cleanup, under the dispatch the transfer leaves or
// after it has left.
const transferSources = {
  'policy finally': cleanupSource.replace(
    '  choose offer recover(7)',
    `  try
   choose offer recover(7)
  finally
   try
    throw "inner"
   catch e where e is not nothing
    put 1 into y
   end try
  end try`,
  ),
  'failure finally': cleanupSource.replace(
    '  put 2 into x',
    `  try
   throw "inner"
  catch e where e is not nothing
   put 2 into x
  end try`,
  ),
};
// An error escaping a Recovery policy whose own `finally` block runs before
// the outward search (chapter 6, Catching).
const escapeSource = `on go
 try
  try
   throw "a"
  catch "a" before unwind
   try
    throw "b"
   finally
    put 1 into x
   end try
  end try
 catch e
  return the code of e
 end try
end go`;
for (const [name, source] of Object.entries(transferSources)) {
  test(`snapshot at every boundary: dispatch in a transfer's ${name}`, () => {
    const original: string[] = [],
      resumed: string[] = [];
    const g = newGroup({ name: 'snapshot', trace: l => original.push(l) });
    g.load({ name: 's', source });
    g.script('s')!.deliver({ name: 'go' });
    let copy = restore(g.save(), options(resumed)).group;
    let nested = false;
    for (let step = 0; step < 4000; step++) {
      original.length = 0;
      resumed.length = 0;
      const a = g.pump(BigInt(step), { fuelCap: 1 });
      const b = copy.pump(BigInt(step), { fuelCap: 1 });
      expect(b).toEqual(a);
      expect(output(resumed)).toEqual(output(original));
      const saved = g.save();
      const e = new SnapshotEditor(recordsOf(saved).records);
      // A dispatch above a transfer's cleanup.
      const [below, top] = e.controls().slice(-2);
      nested ||=
        !!top &&
        !!below &&
        top.k === 'dispatch' &&
        below.k === 'cleanup' &&
        below.then.k === 'transfer';
      expect(state(copy.save())).toEqual(state(saved));
      copy = restore(saved, options(resumed)).group;
      if (a.state === 'idle') {
        expect(nested).toBe(true);
        return;
      }
    }
    throw new Error('Recovery did not finish');
  });
}

// A save taken in each phase of a recovery: a catch dispatch holding the
// failed frames, a transfer's cleanup, an acceptance's cleanup, and a
// dispatch nested in another's policy.
const snapshotIn = (
  phase: 'selection' | 'offer' | 'catch' | 'nested' | 'escape',
) => {
  const g = newGroup({ name: 'snapshot' });
  g.load({
    name: 's',
    source:
      phase === 'nested'
        ? nested[0]!.source
        : phase === 'escape'
          ? escapeSource
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
    const e = new SnapshotEditor(recordsOf(bytes).records);
    const controls = e.controls();
    if (!controls.length) {
      continue;
    }
    const dispatches = controls.filter(c => c.k === 'dispatch');
    const top = e.control();
    const then = top.k === 'cleanup' ? top.then.k : null;
    if (
      phase === 'nested'
        ? dispatches.length === 2
        : phase === 'selection'
          ? top.k === 'dispatch' && top.held.length > 0
          : phase === 'offer'
            ? then === 'transfer' && e.step()
            : phase === 'escape'
              ? then === 'search' && e.step()
              : then === 'accept' && e.step()
    ) {
      return bytes;
    }
  }
  throw new Error(`Missing snapshot phase ${phase}`);
};

const notMap = rawValue([2, 0, 7, 0]);
const limit = { frame: 999, entry: 999 };
const malformed: {
  mutate: (e: SnapshotEditor) => void;
  name: string;
  phase: 'selection' | 'offer' | 'catch' | 'nested' | 'escape';
}[] = [
  // The Run's own fields.
  {
    name: 'attempt counter rewind',
    phase: 'offer',
    mutate: e => {
      e.run().attempts = 0;
    },
  },
  {
    name: 'cleanup start past the Fuel used',
    phase: 'selection',
    mutate: e => {
      e.run().cleanupFrom = 1_000_000_000;
    },
  },
  {
    name: 'cancellation without its cleanup',
    phase: 'selection',
    mutate: e => {
      e.run().cleanupFrom = 0;
    },
  },
  // A dispatch.
  {
    name: 'dispatch error',
    phase: 'selection',
    mutate: e => {
      e.dispatch().error = notMap;
    },
  },
  {
    name: 'dispatch owner',
    phase: 'selection',
    mutate: e => {
      e.dispatch().owner = 999;
    },
  },
  {
    name: 'dispatch place',
    phase: 'selection',
    mutate: e => {
      e.dispatch().place = 100_000;
    },
  },
  {
    name: 'owner PC',
    phase: 'selection',
    mutate: e => {
      e.dispatch().ownerPc = 100_000;
    },
  },
  {
    name: 'held unit',
    phase: 'selection',
    mutate: e => {
      e.held().unit = { k: 'extension', extension: 9 };
    },
  },
  {
    name: 'held body',
    phase: 'selection',
    mutate: e => {
      e.held().body = 999;
    },
  },
  {
    name: 'held PC',
    phase: 'selection',
    mutate: e => {
      e.held().pc = 100_000;
    },
  },
  {
    name: 'held local layout',
    phase: 'selection',
    mutate: e => {
      e.held().locals.pop();
    },
  },
  // A search.
  {
    name: 'search frame',
    phase: 'selection',
    mutate: e => {
      e.search().frame = 999;
    },
  },
  {
    name: 'search entry',
    phase: 'selection',
    mutate: e => {
      e.search().entry = 0;
    },
  },
  {
    name: 'search limit',
    phase: 'selection',
    mutate: e => {
      e.search().limit = limit;
    },
  },
  {
    name: 'search skip',
    phase: 'selection',
    mutate: e => {
      e.search().skip = limit;
    },
  },
  {
    name: 'nested dispatch owner',
    phase: 'nested',
    mutate: e => {
      e.dispatch().owner = 999;
    },
  },
  // A cleanup and its steps.
  {
    name: 'cleanup next',
    phase: 'offer',
    mutate: e => {
      e.cleanup().next = 999;
    },
  },
  {
    name: 'step frame',
    phase: 'offer',
    mutate: e => {
      e.step().frame = 999;
    },
  },
  {
    name: 'step entry',
    phase: 'offer',
    mutate: e => {
      e.step().entry = 999;
    },
  },
  {
    name: 'step target',
    phase: 'offer',
    mutate: e => {
      e.step().target = 0;
    },
  },
  {
    name: 'step depth',
    phase: 'offer',
    mutate: e => {
      e.step().depth = 99;
    },
  },
  {
    name: 'duplicate step',
    phase: 'offer',
    mutate: e => {
      e.steps().push({ ...e.step() });
    },
  },
  // A transfer.
  {
    name: 'transfer frame',
    phase: 'offer',
    mutate: e => {
      e.then().frame = 999;
    },
  },
  {
    name: 'transfer offer entry',
    phase: 'offer',
    mutate: e => {
      e.then().offerEntry = 999;
    },
  },
  {
    name: 'transfer record',
    phase: 'offer',
    mutate: e => {
      e.then().record = 999;
    },
  },
  {
    name: 'transfer offer',
    phase: 'offer',
    mutate: e => {
      e.then().offer = 999;
    },
  },
  {
    name: 'transfer argument count',
    phase: 'offer',
    mutate: e => {
      (e.then().args as unknown[]).pop();
    },
  },
  {
    name: 'transfer attempt',
    phase: 'offer',
    mutate: e => {
      e.then().attempt = 99;
    },
  },
  {
    name: 'transfer limit',
    phase: 'offer',
    mutate: e => {
      e.then().limit = limit;
    },
  },
  // A search after an escaped policy's cleanup.
  {
    name: 'then search frame',
    phase: 'escape',
    mutate: e => {
      (e.then().search as { frame: number }).frame = 999;
    },
  },
  {
    name: 'then search skip',
    phase: 'escape',
    mutate: e => {
      (e.then().search as { skip: unknown }).skip = limit;
    },
  },
  // An acceptance.
  {
    name: 'accept frame',
    phase: 'catch',
    mutate: e => {
      e.then().frame = 999;
    },
  },
  {
    name: 'accept PC',
    phase: 'catch',
    mutate: e => {
      e.then().pc = 0;
    },
  },
];
for (const { name, phase, mutate } of malformed) {
  test(`refuse malformed control: ${name}`, () => {
    const bytes = editSave(snapshotIn(phase), records =>
      mutate(new SnapshotEditor(records)),
    );
    try {
      restore(bytes, options([]));
      throw new Error('Accepted malformed control');
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
      expect(state(copy.save())).toEqual(state(bytes));
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

// Repeated whole-Group restores exceed Bun's default 5-second budget on CI.
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
    expect(
      operationalResult(copy.pump(BigInt(step), { fuelSlice: 1 })),
    ).toEqual(operationalResult(a));
    expect(output(resumed)).toEqual(output(original));
    expect(copy.inspect()).toEqual(g.inspect());
    choices.push(
      ...original
        .filter(l => l.startsWith('offer-chosen'))
        .map(l => l.split(' ').slice(1, 3).join(' ')),
    );
    const bytes = g.save();
    expect(state(copy.save())).toEqual(state(bytes));
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
}, 30_000);
