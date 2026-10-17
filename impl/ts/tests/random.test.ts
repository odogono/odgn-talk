import { expect, test } from 'bun:test';
import { newGroup, restore } from '../src/index';
import { nextRandom, seedState } from '../src/random';
import { num } from '../src/values';

const dice = `on roll n, k
  put [] into rolls
  repeat k times
    put random(n) after rolls
  end repeat
  return rolls
end roll`;

const roll = (seed: bigint | undefined, n: number, k: number) => {
  const group = newGroup({
    name: 'g',
    ...(seed === undefined ? {} : { seed }),
  });
  group.load({ name: 's', source: dice });
  const reply = group
    .script('s')!
    .request({ name: 'roll', args: [num(n), num(k)] });
  group.pump(0n);
  return { group, reply };
};

const draws = (seed: bigint, ns: bigint[]) => {
  let state = seedState(seed);
  return ns.map(n => {
    const next = nextRandom(state, n);
    state = next.state;
    return next.value;
  });
};

test('the generator gives the Spec’s sequences', () => {
  expect(draws(0n, Array(10).fill(6n))).toEqual([
    1n,
    6n,
    1n,
    3n,
    2n,
    6n,
    6n,
    6n,
    3n,
    5n,
  ]);
  expect(draws(42n, Array(10).fill(6n))).toEqual([
    3n,
    6n,
    4n,
    4n,
    4n,
    5n,
    1n,
    6n,
    3n,
    4n,
  ]);
  expect(draws(0n, [1n, 2n, 7n, 100n, 1n << 32n])).toEqual([
    1n,
    2n,
    4n,
    89n,
    3_443_325_254n,
  ]);
});

test('random(n) draws from the Group’s seeded generator', async () => {
  const { reply } = roll(42n, 6, 10);
  expect(String(await reply.result)).toBe('[3, 6, 4, 4, 4, 5, 1, 6, 3, 4]');
  const { reply: unseeded } = roll(undefined, 6, 10);
  expect(String(await unseeded.result)).toBe('[1, 6, 1, 3, 2, 6, 6, 6, 3, 5]');
});

test('the generator state is carried in a save', async () => {
  const group = newGroup({ name: 'g', seed: 42n });
  group.load({ name: 's', source: dice });
  group.script('s')!.request({ name: 'roll', args: [num(6), num(4)] });
  group.pump(0n);
  const { group: copy } = restore(group.save(), {
    name: 'copy',
    libraries: [],
    grants: () => undefined,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  const next = copy
    .script('s')!
    .request({ name: 'roll', args: [num(6), num(6)] });
  copy.pump(0n);
  expect(String(await next.result)).toBe('[4, 5, 1, 6, 3, 4]');
});

test('random rejects a bound outside 1 to 2^32', () => {
  const group = newGroup({ name: 'g' });
  group.load({
    name: 's',
    source: `on go
  put [] into codes
  repeat for each n in [0, 1.5, -1, 4294967297, "6"]
    try
      put random(n) into ignored
    catch e
      put the code of e after codes
    end try
  end repeat
  return codes
end go`,
  });
  const reply = group.script('s')!.request({ name: 'go' });
  group.pump(0n);
  return expect(reply.result.then(String)).resolves.toBe(
    '["out of domain", "out of domain", "out of domain", "out of domain", "wrong kind"]',
  );
});

test('random is not constant', () => {
  const group = newGroup({ name: 'g' });
  expect(() =>
    group.load({ name: 's', source: 'constant c = random(6)' }),
  ).toThrow(/not constant/);
});
