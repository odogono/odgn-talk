import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  createCore,
  createGroup,
  fromValue,
  HostError,
  text,
  type Core,
  type Value,
} from '../src/index';
import {
  createCore as createWasmCore,
  createGroup as createWasmGroup,
} from '../src/wasm/index';
import { artifact } from './reactor-artifact';

const module = existsSync(artifact)
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

const refused = (f: () => unknown, message: RegExp) => {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('invalid value');
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected refusal');
};

// A Host passing plain JS where the API's types ask for a Value.
const plain = 'bob' as unknown as Value;
const fix = String.raw`wrap it with text\(\), num\(\) or toValue\(\)`;

test('a JS value given as a Value names its JS kind and toValue', () => {
  refused(() => fromValue(plain), /got a JS string; .*toValue\(\)/);
  refused(() => fromValue(new Date() as never), /got a JS Date object/);
});

for (const backend of ['ts', 'wasm'] as const) {
  const makeCore = (): Core | Promise<Core> =>
    backend === 'ts' ? createCore() : createWasmCore({ wasm: module! });
  const makeGroup = backend === 'ts' ? createGroup : createWasmGroup;

  describe.skipIf(backend === 'wasm' && !module)(`${backend} Core`, () => {
    test('a plain JS argument names the call, its position and the fix', async () => {
      const core = await makeCore();
      await using group = makeGroup({ name: 'g', core, clock: () => 0n });
      const script = group.load({
        name: 's',
        source:
          'on hit a, b\n return b\nend hit\non fn\n return given x: x\nend fn',
      });
      const handlers = String.raw`, or call script\.handlers\.hit\(\.\.\.\), which converts plain JS$`;
      refused(
        () => script.invoke('hit', text('a'), plain),
        new RegExp(
          String.raw`^Argument 2 of invoke\('hit'\) is a JS string, not a Value; ${fix}${handlers}`,
        ),
      );
      refused(
        () => script.invoke('hit', [] as never, plain),
        /^Argument 1 of invoke\('hit'\) is a JS array/,
      );
      for (const [call, send] of [
        [
          'request',
          () => script.request({ name: 'hit', args: [text('a'), plain] }),
        ],
        [
          'deliver',
          () => script.deliver({ name: 'hit', args: [text('a'), plain] }),
        ],
        [
          'decide',
          () => script.decide({ name: 'hit', args: [text('a'), plain] }),
        ],
      ] as const) {
        refused(
          send,
          new RegExp(String.raw`^Argument 2 of ${call}\('hit'\) .*${handlers}`),
        );
      }
      expect(await script.handlers.hit!('a', 'b')).toBe('b');
      const fn = await script.invoke('fn');
      refused(
        () => group.call(fn, [plain]),
        new RegExp(
          String.raw`^Argument 1 of call is a JS string, not a Value; ${fix}$`,
        ),
      );
    });
  });
}
