import { describe, expect, test } from 'bun:test';
import { autoDrive } from '../src/driver';
import {
  defineCapability,
  formatInstant,
  newGroup,
  num,
  shape,
  type Call,
  type PumpResult,
} from '../src/index';

const driven = (
  source: string,
  options: Parameters<typeof autoDrive>[1] = {},
  grants = {},
) => {
  const lines: string[] = [];
  const group = newGroup({
    name: 'g',
    onReady: () => drive.ready(),
    trace: line => lines.push(line),
  });
  const drive = autoDrive(group, options);
  const script = group.load({ name: 's', source, grants });
  return { drive, group, lines, script };
};

describe('autoDrive', () => {
  test('pumps once per readiness, on a later macrotask', async () => {
    const pumps: PumpResult[] = [];
    const { drive, script } = driven('on go\n  return 1\nend go', {
      onPump: r => pumps.push(r),
    });
    const a = script.request({ name: 'go', args: [] });
    const b = script.request({ name: 'go', args: [] });
    expect(pumps).toHaveLength(0);
    expect((await a.result).toString()).toBe('1');
    expect((await b.result).toString()).toBe('1');
    await drive.idle();
    expect(pumps).toHaveLength(1);
  });

  test('a sliced Pump is followed by another', async () => {
    const states: string[] = [];
    const { drive, script } = driven(
      'on go\n  put 0 into n\n  repeat 200 times\n    add 1 to n\n  end repeat\n  return n\nend go',
      { pump: { fuelSlice: 200 }, onPump: r => states.push(r.state) },
    );
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('200');
    await drive.idle();
    expect(states.length).toBeGreaterThan(2);
    expect(states.at(-1)).toBe('idle');
    expect(states.slice(0, -1).every(s => s === 'sliced')).toBe(true);
  });

  test('the default deadline timer pumps a wait on the wall clock', async () => {
    const { lines, script } = driven('on go\n  wait 30 ms\n  return 7\nend go');
    const start = Date.now();
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('7');
    expect(Date.now() - start).toBeGreaterThanOrEqual(29);
    expect(lines.filter(l => l.startsWith('> pump'))).toHaveLength(2);
  });

  test('a supplied clock and deadline scheduler replace the defaults', async () => {
    let now = 1_000_000_000_000n;
    let fire: (() => void) | undefined;
    let at: bigint | undefined;
    const { drive, lines, script } = driven(
      'on go\n  wait 1 s\n  return 7\nend go',
      {
        clock: () => now,
        setDeadline: (when, f) => {
          at = when;
          fire = f;
          return () => (fire = undefined);
        },
      },
    );
    const result = script.request({ name: 'go', args: [] }).result;
    await drive.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(at).toBe(now + 1_000_000_000n);
    now = at!;
    fire!();
    expect((await result).toString()).toBe('7');
    expect(lines).toContain(`> pump clock=${formatInstant(at!)}`);
  });

  test('readings never go backwards', async () => {
    let now = 2_000_000_000_000n;
    const errors: unknown[] = [];
    const { drive, lines, script } = driven('on go\nend go', {
      clock: () => now,
      onError: e => errors.push(e),
    });
    script.deliver({ name: 'go', args: [] });
    await drive.idle();
    now -= 1_000_000_000n;
    script.deliver({ name: 'go', args: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    await drive.idle();
    expect(errors).toEqual([]);
    const pumps = lines.filter(l => l.startsWith('> pump'));
    expect(pumps).toHaveLength(2);
    expect(pumps[0]).toBe(pumps[1]!);
  });

  test('an answer from a Promise resumes the Run', async () => {
    let started: Call<void> | undefined;
    const api = defineCapability('api', {
      fetch: {
        mode: 'suspending',
        result: shape.number,
        cost: { fuel: 0 },
        run: async call => {
          started = call;
          await new Promise(resolve => setTimeout(resolve, 5));
          return num(9);
        },
      },
    });
    const { script } = driven(
      'on go\n  ask api to fetch and wait\n  return it\nend go',
      {},
      { api: api.grant('all', undefined) },
    );
    expect(
      (await script.request({ name: 'go', args: [] }).result).toString(),
    ).toBe('9');
    expect(started?.signal.aborted).toBe(false);
  });

  test('stop cancels the scheduled Pump and later readiness', async () => {
    const pumps: PumpResult[] = [];
    const { drive, script } = driven('on go\nend go', {
      onPump: r => pumps.push(r),
    });
    script.deliver({ name: 'go', args: [] });
    drive.stop();
    await drive.idle();
    script.deliver({ name: 'go', args: [] });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(pumps).toHaveLength(0);
  });
});
