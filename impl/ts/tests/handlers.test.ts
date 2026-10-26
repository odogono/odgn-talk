import { describe, expect, expectTypeOf, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  createCore,
  createGroup,
  Decimal,
  handlersOf,
  HostError,
  instant,
  num,
  ScriptError,
  talk,
  Value,
  type Core,
  type PlainValue,
} from '../src/index';
import {
  createCore as createWasmCore,
  createGroup as createWasmGroup,
} from '../src/wasm/index';
import { artifact } from './reactor-artifact';

const module = existsSync(artifact)
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

const source = talk`
  on total a, b
    return a + b
  end total
  on echo value
    return value
  end echo
  on fail
    return 1 / 0
  end fail
  on move x to y
    return [x, y]
  end move
`;

for (const backend of ['ts', 'wasm'] as const) {
  const makeCore = (): Core | Promise<Core> =>
    backend === 'ts' ? createCore() : createWasmCore({ wasm: module! });
  const open = async () =>
    backend === 'ts'
      ? createGroup({ name: 'g', core: await makeCore() })
      : createWasmGroup({ name: 'g', core: await makeCore() });

  describe.skipIf(backend === 'wasm' && !module)(`${backend} handlers`, () => {
    test('converts integer arguments and default Decimal, object and Value answers', async () => {
      await using group = await open();
      const script = group.load({ name: 's', source });
      const answer = await script.handlers.total!(2, 3n);
      expect(answer).toBeInstanceOf(Decimal);
      expect(String(answer)).toBe('5');
      const object = await script.handlers.echo!({ items: ['a', num(2)] });
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
      expect(object).toEqual({ items: ['a', num(2).asDecimal()!] });
      const at = instant(0n);
      const time = await script.handlers.echo!(at);
      expect(time).toBeInstanceOf(Value);
      expect(time).toEqual(at);
      expect(await script.handlers['move:to:']!(2, 3)).toEqual([
        num(2).asDecimal()!,
        num(3).asDecimal()!,
      ]);
      expect(group.script('s')).toBe(script);
      // The Helper leaves the Value-only entry point available.
      expect(await script.invoke('total', num(2), num(3))).toEqual(num(5));
    });

    test.each([0.5, 2 ** 53, Number.NaN, Infinity, { nested: [0.5] }])(
      'rejects invalid argument %s before invoking, with its one-based position',
      async bad => {
        await using group = await open();
        const script = group.load({ name: 's', source });
        const invoke = spyOn(script, 'invoke');
        const error = await Reflect.apply(script.handlers.total!, undefined, [
          1,
          bad,
        ]).catch((error: HostError) => error);
        expect(error).toBeInstanceOf(HostError);
        expect(error.code).toBe('invalid value');
        expect(error.message).toContain('Argument 2');
        expect(error.message).toContain('dec()');
        expect(error.message).toContain("{ numbers: 'decimal' }");
        expect(invoke).not.toHaveBeenCalled();
      },
    );

    test('missing Handlers and Script errors reject as invoke does', async () => {
      await using group = await open();
      const script = group.load({ name: 's', source });
      for (const name of ['missing', 'fail']) {
        const invoked = await script.invoke(name).catch(error => error);
        const called = await script.handlers[name]!().catch(error => error);
        expect(called).toBeInstanceOf(ScriptError);
        expect(called).toEqual(invoked);
        expect(called.code).toBe(invoked.code);
        expect(called.reason).toBe(invoked.reason);
        // A rejection passes through without replacing the original Error.
        const invoke = spyOn(script, 'invoke').mockRejectedValueOnce(invoked);
        await expect(script.handlers[name]!()).rejects.toBe(invoked);
        invoke.mockRestore();
      }
    });

    test('ignores Promise, symbol, inherited and invalid message properties', async () => {
      await using group = await open();
      const script = group.load({ name: 's', source });
      for (const key of [
        'then',
        'toString',
        'constructor',
        '__proto__',
        '',
        'not a name',
        'on',
        'bad:',
        Symbol.iterator,
        Symbol.toStringTag,
      ]) {
        expect(Reflect.get(script.handlers, key)).toBeUndefined();
      }
      expect(await Promise.resolve(script.handlers)).toBe(script.handlers);
      expect(typeof script.handlers.missing).toBe('function');
      const total = script.handlers.total!;
      expect(String(await total(2, 3))).toBe('5');
    });

    test('handlersOf works on a plain Script with a Host-owned Pump loop', async () => {
      const group = (await makeCore()).newGroup({ name: 'g' });
      const script = group.load({ name: 's', source });
      const calls = handlersOf(script);
      const answer = calls.total!(2, 3);
      group.pump(0n);
      expect(String(await answer)).toBe('5');
      script.extend('on extra\n return 7\nend extra');
      const extra = calls.extra!();
      group.pump(0n);
      expect(String(await extra)).toBe('7');
      script.reload(
        'on total a, b\n return a * b\nend total',
        'reset variables',
      );
      const reloaded = calls.total!(2, 3);
      group.pump(0n);
      expect(String(await reloaded)).toBe('6');
    });

    test('load<T> and handlersOf<T> narrow arguments and results without checking T', async () => {
      await using group = await open();
      type Calls = { total(a: number, b: number): Promise<Decimal> };
      const script = group.load<Calls>({ name: 's', source });
      const calls = handlersOf<Calls>(script);
      expectTypeOf(script.handlers).toEqualTypeOf<Calls>();
      expectTypeOf(calls.total).parameters.toEqualTypeOf<[number, number]>();
      expectTypeOf(calls.total).returns.toEqualTypeOf<Promise<Decimal>>();
      expectTypeOf(handlersOf(script).total!).returns.toEqualTypeOf<
        Promise<PlainValue>
      >();
      const invalidCalls = () => {
        // @ts-expect-error The Host's declared argument type is enforced.
        script.handlers.total('two', 3);
        // @ts-expect-error The Host's declared Handler names are enforced.
        calls.missing();
      };
      expectTypeOf(invalidCalls).returns.toEqualTypeOf<void>();
      expect(String(await script.handlers.total(2, 3))).toBe('5');
      const unchecked = group.load<{
        total(a: number, b: number): Promise<string>;
      }>({
        name: 'unchecked',
        source,
      });
      expect(await unchecked.handlers.total(2, 3)).toBeInstanceOf(Decimal);
    });
  });
}
