// Synchronous `charge` on every call path follows one set of rules
// (spec/embedding/metered-operations.md).
import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  HostError,
  newGroup,
  restore,
  shape,
  text,
  type Call,
} from '../src/index';

const outcomeOf = (f: () => void) => {
  try {
    f();
    return 'ok';
  } catch (error) {
    return error instanceof HostError
      ? error.code
      : error instanceof Error && error.name === 'LimitReached'
        ? 'limit'
        : String(error);
  }
};

/** An immediate metered Operation that tries `charges` in order. */
const immediate = (charges: number[]) => {
  const lines: string[] = [];
  const outcomes: string[] = [];
  const api = defineCapability('api', {
    fetch: {
      mode: 'immediate',
      cost: { fuel: 0 },
      metering: 'read-only',
      do: call => {
        for (const fuel of charges) {
          outcomes.push(outcomeOf(() => call.charge(fuel)));
        }
        return text('done');
      },
    },
  });
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  g.load({
    name: 's',
    source: 'on go\n  ask api to fetch\n  return it\nend go',
    grants: { api: api.grant('all', undefined) },
  }).deliver({ name: 'go', limits: { fuelPerRun: 100 } });
  g.pump(0n);
  return { outcomes, call: lines.find(line => line.startsWith('call ')) };
};

/**
 * A suspending Operation reissued after restore, trying `charges`. It can't
 * be metered: a pending metered call blocks a save.
 */
const reissued = (charges: number[]) => {
  const outcomes: string[] = [];
  let reissuing = false;
  const remote = defineCapability('remote', {
    get: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 0 },
      start: (call: Call<void>) => {
        if (reissuing) {
          for (const fuel of charges) {
            outcomes.push(outcomeOf(() => call.charge(fuel)));
          }
        }
      },
    },
  });
  const grant = remote.grant('all', undefined);
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\n  ask remote to get and wait\nend go',
    grants: { remote: grant },
  }).deliver({ name: 'go', limits: { fuelPerRun: 100 } });
  g.pump(0n);
  const lines: string[] = [];
  const { group: copy } = restore(g.save(), {
    name: 'g',
    trace: line => lines.push(line),
    libraries: [],
    grants: () => grant,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  reissuing = true;
  copy.settle('s/r1.c1', { reissue: true });
  copy.pump(1n);
  return { outcomes, call: lines.find(line => line.startsWith('call ')) };
};

describe('a live call', () => {
  test('an amount that is not a whole Fuel amount is invalid value', () => {
    const { outcomes, call } = immediate([-5, 1.5, Number.NaN, 2]);
    expect(outcomes).toEqual([
      'invalid value',
      'invalid value',
      'invalid value',
      'ok',
    ]);
    expect(call).toBe(
      'call s/r1.c1 op=api.fetch args=[] result="done" charged=2',
    );
  });

  test('a refusal latches: a later charge that would fit is refused too', () => {
    const { outcomes, call } = immediate([10, 1_000_000, 1]);
    expect(outcomes).toEqual(['ok', 'limit', 'limit']);
    expect(call).toBe(
      'call s/r1.c1 op=api.fetch args=[] charged=10 charge-refused=yes',
    );
  });
});

describe('a reissued call', () => {
  test('an amount that is not a whole Fuel amount is invalid value', () => {
    expect(reissued([-5, 1.5]).outcomes).toEqual([
      'invalid value',
      'invalid value',
    ]);
  });

  test('a refusal latches: a later charge that would fit is refused too', () => {
    const { outcomes, call } = reissued([10, 1_000_000, 1]);
    expect(outcomes).toEqual(['ok', 'limit', 'limit']);
    expect(call).toMatch(/ charged=10$/);
  });
});
