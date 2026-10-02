import { describe, expect, spyOn, test } from 'bun:test';
import {
  createCore,
  LoadError,
  newGroup,
  num,
  shape,
  type Core,
} from '../src/index';
// eslint-disable-next-line import-x/no-namespace -- Observe the compiler entry point to prove compilation happens once.
import * as lowering from '../src/lowering';
import { codeOf } from '../src/library';

describe('process-wide Core', () => {
  test('compiles a Script once across Groups, reloads and restores, keeping state separate', () => {
    const core: Core = createCore();
    const source = 'script variable n = 0\non bump\n  add 1 to n\nend bump';
    const lower = spyOn(lowering, 'lowerTree');
    try {
      const a = core.newGroup({ name: 'a' });
      const b = createCore().newGroup({ name: 'b' });
      a.load({ name: 'cached-script', source }).deliver({ name: 'bump' });
      a.pump(0n);
      b.load({ name: 'cached-script', source });
      expect(a.inspect().scripts[0]!.vars[0]![1].toString()).toBe('1');
      expect(b.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
      b.script('cached-script')!.reload(source, 'reset variables');
      const { group, result } = core.restore(a.save(), {
        name: 'restored',
        libraries: [],
        onMismatch: 'reject',
        grants: () => undefined,
        resolve: () => undefined,
      });
      expect(result.variablesOnly).toBe(false);
      expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('1');
      newGroup({ name: 'helper' }).load({ name: 'cached-script', source });
      expect(lower).toHaveBeenCalledTimes(1);
    } finally {
      lower.mockRestore();
    }
  });

  test('checks Grants again on a cache hit and binds each Group to its own Host', () => {
    const core = createCore();
    const capability = core.defineCapability<number>('cache-test', {
      read: {
        mode: 'immediate',
        args: [],
        result: shape.number,
        cost: { fuel: 1 },
        do: call => num(call.binding),
      },
    });
    const source =
      'script variable n\non go\n  ask service to read\n  put it into n\nend go';
    const a = core.newGroup({ name: 'a' });
    const b = core.newGroup({ name: 'b' });
    for (const [group, binding] of [
      [a, 3],
      [b, 7],
    ] as const) {
      group
        .load({
          name: 'cached-grants',
          source,
          grants: { service: capability.grant('all', binding) },
        })
        .deliver({ name: 'go' });
      group.pump(0n);
      expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe(
        String(binding),
      );
    }
    expect(() =>
      core
        .newGroup({ name: 'missing' })
        .load({ name: 'cached-grants', source }),
    ).toThrow(LoadError);
    const suspending = core.defineCapability('other-mode', {
      read: {
        mode: 'suspending',
        args: [],
        cost: { fuel: 1 },
        start: () => {},
      },
    });
    expect(() =>
      core.newGroup({ name: 'mode' }).load({
        name: 'cached-grants',
        source,
        grants: { service: suspending.grant('all', undefined) },
      }),
    ).toThrow(LoadError);
  });

  test('a cached Script still checks per-load limits', () => {
    const core = createCore();
    const source = 'constant p = <"abcdef">';
    core.newGroup({ name: 'wide' }).load({ name: 'cached-pattern', source });
    expect(() =>
      core
        .newGroup({ name: 'tight' })
        .load({ name: 'cached-pattern', source, limits: { patternSize: 1 } }),
    ).toThrow(LoadError);
  });

  test('Library metadata can change without compiling its identity again', () => {
    const core = createCore();
    const source = 'function one\n  return 1\nend one';
    const a = core.compileLibrary({
      name: 'cached-library',
      source,
      version: '1',
    });
    const b = createCore().compileLibrary({
      name: 'cached-library',
      source,
      version: '2',
    });
    expect(codeOf(a)).toBe(codeOf(b));
    expect(b.version).toBe('2');
    const changed = core.compileLibrary({
      name: 'cached-library',
      source: source.replace('return 1', 'return 2'),
      version: '3',
    });
    expect(codeOf(changed)).not.toBe(codeOf(a));
  });

  test('Script compilation distinguishes names, source and imported Library identities', () => {
    const core = createCore();
    const libraries = [1, 2].map(n =>
      core.compileLibrary({
        name: 'cacheImports',
        version: String(n),
        source: `function one\n  return ${n}\nend one`,
      }),
    );
    const source =
      'use one from cacheImports\nscript variable n\non go\n  put one() into n\nend go';
    const lower = spyOn(lowering, 'lowerTree');
    try {
      for (const [library, name, code, expected] of [
        [libraries[0]!, 'cache-importer', source, '1'],
        [libraries[1]!, 'cache-importer', source, '2'],
        [libraries[0]!, 'other-importer', source, '1'],
        [
          libraries[0]!,
          'cache-importer',
          source.replace('one()', 'one() + 1'),
          '2',
        ],
      ] as const) {
        const group = core.newGroup({ name: 'g' });
        group.addLibrary(library);
        group.load({ name, source: code }).deliver({ name: 'go' });
        group.pump(0n);
        expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe(
          expected,
        );
      }
      expect(lower).toHaveBeenCalledTimes(4);
    } finally {
      lower.mockRestore();
    }
  });

  test('cached extensions retain the variable slots and bindings of their complete Script history', async () => {
    const core = createCore();
    const extension = 'on go\n  return [base, n]\nend go';
    for (const [source, expected] of [
      ['constant base = 10\nscript variable n = 1', '[10, 1]'],
      [
        'constant base = 20\nscript variable padding = 0\nscript variable n = 2',
        '[20, 2]',
      ],
      ['constant base = 10\nscript variable n = 1', '[10, 1]'],
    ] as const) {
      const group = core.newGroup({ name: 'extensions' });
      const script = group.load({ name: 'cache-extensions', source });
      script.extend(extension);
      const requested = script.request({ name: 'go' });
      group.pump(0n);
      expect((await requested.result).toString()).toBe(expected);
    }
  });

  test('Object Kinds defined through Core restore their native state', () => {
    const core = createCore();
    const kind = core.defineObjectKind<{ value: number }>({
      name: 'core-object',
      props: { value: { get: o => num(o.native.value) } },
    });
    const group = core.newGroup({ name: 'objects' });
    const object = group.object(kind, 'one', { value: 4 });
    group.load({
      name: 'object-reader',
      source: 'on go\n  return the value of item\nend go',
      objects: { item: object },
    });
    const { group: copy } = createCore().restore(group.save(), {
      name: 'copy',
      libraries: [],
      onMismatch: 'reject',
      grants: () => undefined,
      resolve: () => ({ native: { value: 9 } }),
    });
    const requested = copy.script('object-reader')!.request({ name: 'go' });
    copy.pump(0n);
    return requested.result.then(value => expect(value.toString()).toBe('9'));
  });
});
