// The State Fingerprint (chapter 10, ADR 0142): equal exactly when the state a
// save holds is equal, apart from the Trace save id counter.
import { describe, expect, test } from 'bun:test';
import {
  createCore,
  defineCapability,
  defineObjectKind,
  HostError,
  newGroup,
  nothing,
  num,
  restore,
  shape,
  type RestoreOptions,
} from '../src/index';
import { sha256 } from '../src/sha256';

const source =
  'script variable n = 0\non go x\n  add x to n\n  wait 2 s\n  add 1 to n\nend go';
const options = (o: Partial<RestoreOptions> = {}): RestoreOptions => ({
  name: 'g',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject',
  ...o,
});
const started = (x = 1) => {
  const trace: string[] = [];
  const g = newGroup({ name: 'g', trace: line => trace.push(line) });
  const s = g.load({ name: 's', source });
  s.deliver({ name: 'go', args: [num(x)] });
  g.pump(0n);
  return { g, s, trace };
};
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    return (error as HostError).code;
  }
  throw new Error('Did not throw');
};
const core = createCore();

describe('the State Fingerprint', () => {
  test('two saves with nothing run between them match, though their bytes differ', () => {
    const { g } = started();
    const a = g.save();
    const b = g.save();
    expect(a).not.toEqual(b);
    expect(core.stateFingerprint(a)).toEqual(core.stateFingerprint(b));
    expect(core.stateFingerprint(a)).toHaveLength(32);
  });

  test('save, restore and save match, and restored Host Objects keep it', () => {
    const kind = defineObjectKind<{ n: number }>({ name: 'marker', props: {} });
    const { g } = started();
    const parent = g.object(kind, 'p', { n: 1 });
    g.setParent(g.object(kind, 'c', { n: 2 }), parent);
    g.dispose(g.object(kind, 'd', { n: 3 }));
    const live = g.stateFingerprint();
    const bytes = g.save();
    expect(core.stateFingerprint(bytes)).toEqual(live);
    const { group: copy } = restore(
      bytes,
      options({ resolve: (_kind, id) => ({ native: { n: id.length + 10 } }) }),
    );
    expect(copy.stateFingerprint()).toEqual(live);
    expect(core.stateFingerprint(copy.save())).toEqual(live);
  });

  test('Embedded and External-source saves of one state match', () => {
    const { g } = started();
    const embedded = g.save();
    const external = g.save({ sources: 'external' });
    expect(core.stateFingerprint(external)).toEqual(
      core.stateFingerprint(embedded),
    );
    const { group: copy } = restore(
      external,
      options({ scriptSources: () => ({ source }) }),
    );
    expect(copy.stateFingerprint()).toEqual(core.stateFingerprint(embedded));
  });

  test('one differing Script Variable changes both forms', () => {
    const a = started(1).g;
    const b = started(2).g;
    expect(a.stateFingerprint()).not.toEqual(b.stateFingerprint());
    expect(core.stateFingerprint(a.save())).toEqual(a.stateFingerprint());
    expect(core.stateFingerprint(b.save())).toEqual(b.stateFingerprint());
    expect(started(1).g.stateFingerprint()).toEqual(a.stateFingerprint());
  });

  test('taking it writes no Trace record and changes no Fuel or counter', () => {
    const { g, s, trace } = started();
    const counters = s.counters();
    const lines = trace.length;
    const before = g.save();
    g.stateFingerprint();
    core.stateFingerprint(before);
    expect(trace.slice(lines)).toEqual(['> save s1']);
    expect(s.counters()).toEqual(counters);
    // The save id counter did not move: the next save is s2.
    g.save();
    expect(trace.at(-1)).toBe('> save s2');
  });

  test('the live form is a worker call', () => {
    const g = newGroup({ name: 'g' });
    let code: string | undefined;
    const cap = defineCapability('api', {
      ping: {
        mode: 'immediate',
        cost: { fuel: 1 },
        result: shape.nothing,
        do: () => {
          code = codeOf(() => g.stateFingerprint());
          return nothing;
        },
      },
    });
    g.load({
      name: 's',
      source: 'on go\n  ask api to ping\nend go',
      grants: { api: cap.grant('all', undefined) },
    }).deliver({ name: 'go' });
    g.pump(0n);
    expect(code).toBe('reentrant call');
  });

  test('the save form rejects unreadable bytes and other formats', () => {
    const bytes = newGroup({ name: 'g' }).save();
    expect(codeOf(() => core.stateFingerprint(new Uint8Array([1, 2])))).toBe(
      'invalid save',
    );
    const resealed = (mutate: (payload: Record<string, unknown>) => void) => {
      const outer = JSON.parse(new TextDecoder().decode(bytes));
      mutate(outer.payload);
      outer.hash = sha256(JSON.stringify(outer.payload));
      return new TextEncoder().encode(JSON.stringify(outer));
    };
    expect(
      codeOf(() => core.stateFingerprint(resealed(p => (p.format = 1)))),
    ).toBe('save mismatch');
    expect(
      codeOf(() => core.stateFingerprint(resealed(p => (p.family = 'other')))),
    ).toBe('save mismatch');
    expect(
      codeOf(() => core.stateFingerprint(resealed(p => (p.scripts = 1)))),
    ).toBe('invalid save');
  });
});
