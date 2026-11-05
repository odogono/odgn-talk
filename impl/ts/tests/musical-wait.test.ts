// `wait` in Musical Units (chapter 5) and the musical clock (chapter 9,
// ADR 0166): the Core calls the Group's clock and the Host ends the wait.
import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  HostError,
  musicalClockCapability,
  newGroup,
  nothing,
  parseInstant,
  restore,
  type Call,
  type Value,
} from '../src/index';
import { exportManifest } from '../src/manifest';

const t0 = parseInstant('2026-09-30T09:00:00Z');
const at = (s: number) => t0 + BigInt(s) * 1_000_000n;

// A musical clock that keeps each call for the test to answer.
const clock = () => {
  const calls: { call: Call<unknown>; count: Value }[] = [];
  const released: string[] = [];
  const capability = musicalClockCapability(
    { wait: (call, count) => calls.push({ call, count }) },
    { wait: { fuel: 3 } },
    ({ scriptName, grantName, reason }) =>
      released.push(`${scriptName}.${grantName} ${reason}`),
  );
  return { calls, capability, released };
};

// A Group with one Script, its Trace and its run ends' results or errors.
const setup = (source: string, musical = true) => {
  const trace: string[] = [];
  const c = clock();
  const g = newGroup({
    name: 'g',
    trace: line => trace.push(line),
    ...(musical ? { musicalClock: c.capability } : {}),
  });
  const s = g.load({ name: 's', source });
  const ends: string[] = [];
  const pump = (now: bigint) => {
    for (const r of g.pump(now).reports) {
      if (r.kind === 'run end') {
        ends.push(
          r.outcome === 'errored'
            ? `error ${r.error?.code}`
            : `${r.outcome} ${r.result ?? ''}`.trim(),
        );
      }
    }
  };
  return { c, g, s, trace, ends, pump };
};

describe('wait in Musical Units', () => {
  test('calls the musical clock and resumes when the Host answers', () => {
    const { c, s, trace, ends, pump } = setup(
      'on go\n  put 1 into x\n  wait 8 bars\n  return x + 1\nend go\n',
    );
    s.deliver({ name: 'go' });
    pump(t0);
    expect(c.calls.map(x => x.count.toString())).toEqual(['8 bars']);
    expect(trace).toContain('call s/r1.c1 op=musical-clock.wait args=[8 bars]');
    expect(trace.find(l => l.startsWith('seg s/r1 start'))).toContain(
      'end=wait',
    );
    // No `maxPending` or `MaxWait`: the wait outlasts 30 s.
    pump(at(60));
    expect(ends).toEqual([]);
    c.calls[0]!.call.answer(nothing);
    pump(at(61));
    expect(ends).toEqual(['completed 2']);
  });

  test('`wait 0 bars` goes straight on and calls nothing', () => {
    const { c, s, ends, pump } = setup(
      'on go\n  wait 0 beats\n  return 1\nend go\n',
    );
    s.deliver({ name: 'go' });
    pump(t0);
    expect(c.calls).toEqual([]);
    expect(ends).toEqual(['completed 1']);
  });

  test.each([
    ['1.5 bars', 'out of domain'],
    ['-1 beat', 'out of domain'],
    ['1 bar + 1 beat', 'incompatible units'],
    ['1 bar / 1 min', 'incompatible units'],
  ])('`wait %s` raises %s', (q, code) => {
    const { c, s, ends, pump } = setup(`on go\n  wait ${q}\nend go\n`);
    s.deliver({ name: 'go' });
    pump(t0);
    expect(c.calls).toEqual([]);
    expect(ends).toEqual([`error ${code}`]);
  });

  test('without a musical clock raises `no musical time`', () => {
    const { s, ends, pump } = setup('on go\n  wait 2 bars\nend go\n', false);
    s.deliver({ name: 'go' });
    pump(t0);
    expect(ends).toEqual(['error no musical time']);
  });

  test('a Timeout Block ends it with `timeout`, abandoning the call', () => {
    const { c, s, ends, pump } = setup(
      'on go\n  with timeout of 2 s\n    wait 4 bars\n  end timeout\nend go\n',
    );
    s.deliver({ name: 'go' });
    pump(t0);
    pump(at(2));
    expect(ends).toEqual(['error timeout']);
    expect(c.calls[0]!.call.signal.aborted).toBe(true);
  });

  test('Stop abandons it and calls the release hook', () => {
    const { c, g, s, pump } = setup('on go\n  wait 1 bar\nend go\n');
    s.deliver({ name: 'go' });
    pump(t0);
    s.stop('done');
    pump(at(1));
    expect(c.calls[0]!.call.signal.aborted).toBe(true);
    expect(c.released).toEqual(['s.musical-clock stop']);
    void g;
  });

  test('a save keeps it pending, and a restore waits on the new clock', () => {
    const { g, s, pump } = setup(
      'on go\n  wait 2 beats\n  return "done"\nend go\n',
    );
    s.deliver({ name: 'go' });
    pump(t0);
    const again = clock();
    const { group, result } = restore(g.save(), {
      name: 'g',
      musicalClock: again.capability,
      libraries: [],
      onMismatch: 'reject',
      resolve: () => undefined,
      grants: () => undefined,
    });
    expect(result.pending.map(p => `${p.grant} ${p.args.join()}`)).toEqual([
      'musical-clock 2 beats',
    ]);
    // Reissued, the call starts again on the restored Group's clock.
    group.settle(result.pending[0]!.id, { reissue: true });
    group.pump(at(1));
    expect(again.calls.map(x => x.count.toString())).toEqual(['2 beats']);
    again.calls[0]!.call.answer(nothing);
    const ends = group
      .pump(at(2))
      .reports.flatMap(r => (r.kind === 'run end' ? [r.outcome] : []));
    expect(ends).toEqual(['completed']);
  });
});

// A Host Manifest with no declarations, as parsed JSON.
const manifest = (musicalTime?: boolean) =>
  JSON.parse(
    exportManifest({ kind: 'k', version: '1', grants: {}, musicalTime }),
  ) as Record<string, unknown>;

describe('the musical clock', () => {
  test('is hidden from grants() and refused as a Host Grant name', () => {
    const { capability } = clock();
    const g = newGroup({ name: 'g', musicalClock: capability });
    const s = g.load({ name: 's', source: 'on go\nend go\n' });
    expect(s.grants()).toEqual({});
    const other = defineCapability('other', {
      ping: { mode: 'immediate', cost: { fuel: 0 }, do: () => nothing },
    });
    expect(() =>
      g.load({
        name: 't',
        source: 'on go\nend go\n',
        grants: { 'musical-clock': other.grant('all', undefined) },
      }),
    ).toThrow(HostError);
  });

  test('only musicalClockCapability makes one', () => {
    const other = defineCapability('musical-clock', {
      tick: { mode: 'suspending', cost: { fuel: 0 }, start: () => {} },
    });
    expect(() => newGroup({ name: 'g', musicalClock: other })).toThrow(
      'musicalClockCapability',
    );
    expect(() =>
      defineCapability('x', {
        wait: { mode: 'suspending', cost: { fuel: 0 }, start: () => {} },
      }),
    ).toThrow("wait can't name an Operation");
  });

  test('the Host Manifest writes musicalTime after the arrays', () => {
    expect(Object.keys(manifest(true)).at(-1)).toBe('musicalTime');
    expect(manifest(true).musicalTime).toBe(true);
    expect('musicalTime' in manifest()).toBe(false);
  });
});
