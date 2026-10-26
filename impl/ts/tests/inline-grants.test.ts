import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  createCore,
  Decimal,
  HostError,
  inlineGrants,
  LoadError,
  map,
  num,
  ScriptError,
  shape,
  talk,
  text,
  type Core,
  type InlineOperation,
} from '../src/index';
import {
  createCore as createWasmCore,
  inlineGrants as wasmInlineGrants,
} from '../src/wasm/index';
import { artifact } from './reactor-artifact';

const module = existsSync(artifact)
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

for (const backend of ['ts', 'wasm'] as const) {
  const makeCore = (): Core | Promise<Core> =>
    backend === 'ts' ? createCore() : createWasmCore({ wasm: module! });

  describe.skipIf(backend === 'wasm' && !module)(
    `${backend} inlineGrants`,
    () => {
      test('calls immediate Operations through ask and Host Commands, beside real Grants', async () => {
        const core = await makeCore();
        const group = core.newGroup({ name: 'g' });
        const grants = inlineGrants({
          math: { sum: (a: Decimal, b: Decimal) => Number(a) + Number(b) },
        });
        const op = grants.math!.capability.operations.get('sum')!;
        expect(op).toMatchObject({
          mode: 'immediate',
          args: [shape.value, shape.value],
          result: shape.value,
          command: true,
          cost: { fuel: 0 },
        });
        expect(op.labels).toBeUndefined();
        const script = group.load({
          name: 's',
          grants: {
            ...grants,
            real: core
              .defineCapability('real', {
                answer: {
                  mode: 'immediate',
                  cost: { fuel: 0 },
                  do: () => num(42),
                },
              })
              .grant('all', undefined),
          },
          source: talk`
          on go
            ask math to sum 10, 10
            put it into first
            sum 10, 10
            put it into second
            ask real to answer
            return [first, second, it]
          end go
        `,
        });
        const answer = script.invoke('go');
        group.pump(0n);
        expect((await answer).toString()).toBe('[20, 20, 42]');
        expect(wasmInlineGrants).toBe(inlineGrants);
      });

      test('converts nested arguments and integer, bigint, undefined and Value results', async () => {
        const group = (await makeCore()).newGroup({ name: 'g' });
        const seen: unknown[] = [];
        const script = group.load({
          name: 's',
          grants: inlineGrants({
            api: {
              echo: (value: unknown) => {
                seen.push(value);
                return value;
              },
              values: () => ({
                integer: 3,
                big: 4n,
                absent: undefined,
                value: text('ok'),
              }),
            },
          }),
          source: talk`
          on go
            echo {items: [1, "two", nothing]}
            put it into echoed
            values
            return [echoed, it]
          end go
        `,
        });
        const answer = script.invoke('go');
        group.pump(0n);
        expect(seen).toEqual([{ items: [num(1).asDecimal()!, 'two', null] }]);
        expect((await answer).toString()).toBe(
          '[{items: [1, "two", nothing]}, {integer: 3, big: 4, absent: nothing, value: "ok"}]',
        );
      });

      test('suspends, answers and aborts the final signal on cancellation', async () => {
        const group = (await makeCore()).newGroup({ name: 'g' });
        const calls: {
          id: string;
          resolve(value: unknown): void;
          signal: AbortSignal;
        }[] = [];
        const grants = inlineGrants({
          api: {
            fetch: {
              arity: 1,
              async: (id: string, signal: AbortSignal) =>
                new Promise(resolve => {
                  calls.push({ id, signal, resolve });
                }),
            },
          },
        });
        // The Group's maxWaitMs supplies the default pending limit.
        expect(grants.api!.capability.operations.get('fetch')).toMatchObject({
          mode: 'suspending',
          maxPendingMs: undefined,
        });
        const script = group.load({
          name: 's',
          grants,
          source: 'on go\n fetch "id" and wait\n return it\nend go',
        });
        const answer = script.invoke('go');
        group.pump(0n);
        expect(group.inspect().scripts[0]!.runs[0]!.status).toBe('suspended');
        expect(calls[0]!.id).toBe('id');
        expect(calls[0]!.signal.aborted).toBe(false);
        calls[0]!.resolve({ result: 7 });
        await new Promise(resolve => setTimeout(resolve, 0));
        group.pump(0n);
        expect((await answer).toString()).toBe('{result: 7}');
        const controller = new AbortController();
        const cancelled = script.request(
          { name: 'go' },
          { signal: controller.signal },
        );
        const failure = cancelled.result.catch(error => error);
        group.pump(0n);
        controller.abort();
        group.pump(0n);
        expect(calls[1]!.signal.aborted).toBe(true);
        expect(await failure).toMatchObject({
          code: 'send failed',
          reason: 'cancelled',
        });
        calls[1]!.resolve(null);
        await new Promise(resolve => setTimeout(resolve, 0));
        group.pump(0n);
      });

      test('async arity defaults to fn.length and a custom pending limit aborts the signal', async () => {
        const group = (await makeCore()).newGroup({ name: 'g' });
        let signal: AbortSignal | undefined;
        let finish: (() => void) | undefined;
        const script = group.load({
          name: 's',
          grants: inlineGrants({
            api: {
              // A default signal parameter keeps fn.length at one.
              fetch: {
                maxPendingMs: 5,
                async: (
                  _id: string,
                  callSignal = new AbortController().signal,
                ) => {
                  signal = callSignal;
                  return new Promise<void>(resolve => {
                    finish = resolve;
                  });
                },
              },
            },
          }),
          source:
            'on go\n try\n fetch "id" and wait\n catch err\n return the code of err\n end try\nend go',
        });
        const answer = script.invoke('go');
        group.pump(0n);
        expect(signal?.aborted).toBe(false);
        group.pump(5000n);
        expect(signal?.aborted).toBe(true);
        expect(await answer).toEqual(text('timeout'));
        finish!();
        await new Promise(resolve => setTimeout(resolve, 0));
        group.pump(5000n);
      });

      for (const async of [false, true]) {
        test(`${async ? 'async' : 'immediate'} errors retain ScriptError and Host failure behavior; fractional results fail as invalid value`, async () => {
          const group = (await makeCore()).newGroup({ name: 'g' });
          const callbacks = {
            fail: () => {
              throw new ScriptError(
                'sold out',
                'none left',
                map([['left', num(0)]]),
              );
            },
            crash: () => {
              throw new Error('broken callback');
            },
            fraction: () => 0.5,
          };
          const operations = Object.fromEntries(
            Object.entries(callbacks).map(
              ([name, fn]): [string, InlineOperation] => [
                name,
                async ? { async: fn } : fn,
              ],
            ),
          );
          const script = group.load({
            name: 's',
            grants: inlineGrants({ api: operations }),
            source: 'on go\nend go',
          });
          // Keep the caught error visible to the Script, including its fields.
          for (const [name, code] of [
            ['fail', 'sold out'],
            ['crash', 'host error'],
            ['fraction', 'invalid value'],
          ]) {
            script.reload(
              `on go\n try\n ${name}${async ? ' and wait' : ''}\n catch err\n return err\n end try\nend go`,
              'reset variables',
            );
            const answer = script.invoke('go');
            group.pump(0n);
            if (async) {
              await new Promise(resolve => setTimeout(resolve, 0));
              group.pump(0n);
            }
            const error = await answer;
            expect(error.get('code').asText()).toBe(code);
            if (name === 'fail') {
              expect(error.get('message').asText()).toBe('none left');
              expect(error.get('left')).toEqual(num(0));
            }
            if (name === 'fraction') {
              expect(error.get('message').asText()).toContain('dec()');
            }
          }
        });
      }

      test('checks argument counts at load and respects explicit arity', async () => {
        const group = (await makeCore()).newGroup({ name: 'g' });
        const grants = inlineGrants({
          math: {
            sum: (a: Decimal, b: Decimal) => Number(a) + Number(b),
            count: { fn: (...args: unknown[]) => args.length, arity: 2 },
            later: { async: (signal: AbortSignal) => signal.aborted, arity: 0 },
          },
        });
        for (const call of [
          'sum 1',
          'sum 1, 2, 3',
          'ask math to sum 1',
          'count 1',
          'later 1 and wait',
        ]) {
          try {
            group.load({
              name: 'bad',
              grants,
              source: `on go\n ${call}\nend go`,
            });
            throw new Error('Load should fail');
          } catch (error) {
            expect(error).toBeInstanceOf(LoadError);
            expect((error as LoadError).diagnostics[0]!.code).toBe(
              'wrong argument count',
            );
          }
        }
        const script = group.load({
          name: 's',
          grants,
          source: 'on go\n count 1, 2\n return it\nend go',
        });
        const answer = script.invoke('go');
        group.pump(0n);
        expect(await answer).toEqual(num(2));
      });

      test('uses existing Reserved Word and ambiguous Host Command errors', async () => {
        expect(() => inlineGrants({ api: { put: () => null } })).toThrow(
          HostError,
        );
        expect(() => inlineGrants({ api: { put: () => null } })).toThrow(
          'Reserved Word',
        );
        const group = (await makeCore()).newGroup({ name: 'g' });
        const grants = inlineGrants({
          one: { sum: () => 1 },
          two: { sum: () => 2 },
        });
        expect(() =>
          group.load({ name: 's', grants, source: 'on go\n sum\nend go' }),
        ).toThrow('name clash');
      });
    },
  );
}

test.each([-1, 0.5, Number.NaN, Infinity])(
  'rejects invalid arity %s',
  arity => {
    expect(() =>
      inlineGrants({ api: { run: { fn: () => null, arity } } }),
    ).toThrow(HostError);
  },
);
