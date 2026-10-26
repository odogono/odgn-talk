import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import-x/no-namespace -- observe the default Core factory without replacing it.
import * as coreModule from '../src/core';
import {
  createCore,
  createGroup,
  num,
  type Core,
  type DrivenGroup,
  type Group,
  type PumpResult,
} from '../src/index';
import {
  createCore as createWasmCore,
  createGroup as createWasmGroup,
} from '../src/wasm/index';
import { artifact } from './reactor-artifact';

const module = existsSync(artifact)
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

test('default Groups use the same process-wide TS Core; an explicit Core skips the default', async () => {
  const core = createCore();
  const factory = spyOn(coreModule, 'createCore');
  try {
    await using explicit = createGroup({ name: 'explicit', core });
    expect(explicit.name).toBe('explicit');
    expect(factory).not.toHaveBeenCalled();
    await using a = createGroup({ name: 'a' });
    await using b = createGroup({ name: 'b' });
    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
    for (const result of factory.mock.results) {
      expect(result.value).toBe(core);
    }
    const script = a.load({ name: 's', source: 'on go\n return 7\nend go' });
    expect((await script.invoke('go')).toString()).toBe('7');
  } finally {
    factory.mockRestore();
  }
});

for (const backend of ['ts', 'wasm'] as const) {
  const makeCore = (): Core | Promise<Core> =>
    backend === 'ts' ? createCore() : createWasmCore({ wasm: module! });
  const makeGroup = backend === 'ts' ? createGroup : createWasmGroup;

  describe.skipIf(backend === 'wasm' && !module)(
    `${backend} createGroup`,
    () => {
      test.each([false, true])(
        'await using closes after invocation, scope throws: %s',
        async throws => {
          const core = await makeCore();
          let closed: DrivenGroup | undefined;
          const failure = new Error('scope failed');
          const scope = async () => {
            await using group = makeGroup({ name: 'g', core, clock: () => 0n });
            closed = group;
            const script = group.load({
              name: 's',
              source: 'on total a, b\n return a + b\nend total',
            });
            expect(
              (await script.invoke('total', num(2), num(3))).toString(),
            ).toBe('5');
            if (throws) {
              throw failure;
            }
          };
          await (throws ? expect(scope()).rejects.toBe(failure) : scope());
          expect(closed!.pump(0n).state).toBe('stopped');
          await closed!.close();
        },
      );

      test('uses the supplied Core and returns its Group with one idempotent close', async () => {
        const core = await makeCore();
        let underlying: Group | undefined;
        const supplied: Core = Object.create(core);
        Object.defineProperty(supplied, 'newGroup', {
          value: (options: Parameters<Core['newGroup']>[0]) =>
            (underlying = core.newGroup(options)),
        });
        const trace: string[] = [];
        await using group = makeGroup({
          name: 'g',
          core: supplied,
          clock: () => 0n,
          trace: line => trace.push(line),
        });
        expect(underlying).toBe(group);
        group.load({ name: 's', source: 'on go\nend go' });
        const closing = group.close('Application shutdown');
        expect(group.close('ignored')).toBe(closing);
        await closing;
        expect(group.pump(0n).state).toBe('stopped');
        expect(trace.some(line => line.includes('Application shutdown'))).toBe(
          true,
        );
        expect(trace.some(line => line.includes('ignored'))).toBe(false);
      });

      test('forwards seed, trace, clock, pump and onPump options', async () => {
        const trace: string[] = [];
        const pumps: PumpResult[] = [];
        await using group = makeGroup({
          name: 'seeded',
          core: await makeCore(),
          seed: 42n,
          clock: () => 0n,
          trace: line => trace.push(line),
          pump: { fuelSlice: 200 },
          onPump: result => pumps.push(result),
        });
        const script = group.load({
          name: 's',
          source:
            'on roll\n return random(6)\nend roll\non count\n put 0 into n\n repeat 200 times\n add 1 to n\n end repeat\n return n\nend count',
        });
        expect(group.name).toBe('seeded');
        expect((await script.invoke('roll')).toString()).toBe('3');
        expect((await script.invoke('count')).toString()).toBe('200');
        expect(pumps.some(result => result.state === 'sliced')).toBe(true);
        expect(trace).toContain(
          '> pump clock=1970-01-01T00:00:00Z fuel-slice=200',
        );
      });

      test('uses the custom deadline scheduler and cancels it on close', async () => {
        let now = 0n;
        let fire: (() => void) | undefined;
        let deadline: bigint | undefined;
        let armed!: () => void;
        let reached = new Promise<void>(resolve => {
          armed = resolve;
        });
        await using group = makeGroup({
          name: 'g',
          core: await makeCore(),
          clock: () => now,
          setDeadline: (at, callback) => {
            deadline = at;
            fire = callback;
            armed();
            return () => {
              fire = undefined;
            };
          },
        });
        const script = group.load({
          name: 's',
          source: 'on go\n wait 1 s\n return 7\nend go',
        });
        const reply = script.invoke('go');
        await reached;
        expect(deadline).toBe(1_000_000n);
        now = deadline!;
        fire!();
        expect((await reply).toString()).toBe('7');
        reached = new Promise<void>(resolve => {
          armed = resolve;
        });
        const pending = script.invoke('go').catch(error => error);
        await reached;
        await group.close();
        expect(fire).toBeUndefined();
        expect(await pending).toHaveProperty('code', 'send failed');
      });

      test('forwards driver errors to onError', async () => {
        const failure = new Error('onPump failed');
        let fail = true;
        let reported!: (error: unknown) => void;
        const error = new Promise<unknown>(resolve => {
          reported = resolve;
        });
        await using group = makeGroup({
          name: 'g',
          core: await makeCore(),
          onError: reported,
          onPump: () => {
            if (fail) {
              fail = false;
              throw failure;
            }
          },
        });
        const script = group.load({ name: 's', source: 'on go\nend go' });
        await script.invoke('go');
        expect(await error).toBe(failure);
      });
    },
  );
}
