import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cases from '../../../corpus/restricted-kit/cases.json';
import { newGroup, restore, type TsGroup } from '../src/group';
import { codeOf, compileLibrary, stdlibLibrary } from '../src/library';
import { type Script } from '../src/machine';
import { functionValue } from '../src/values';
import { disassemble } from '../src/code-unit';
import { allStdlib, stdlibSources } from '../src/generated/stdlib';
import { registerStdlib } from '../src/stdlib-registry';
import { defineObjectKind } from '../src/objects';
import { defineCapability, shape } from '../src/capabilities';
import { LoadError } from '../src/errors';

registerStdlib(...allStdlib);

const forbiddenHost = (): never => {
  throw new Error('restricted callback reached the Host');
};
const objectKind = defineObjectKind({
  name: 'item',
  props: {
    label: { shape: shape.text, get: forbiddenHost, set: forbiddenHost },
  },
});
const api = defineCapability('restrictedApi', {
  read: {
    mode: 'immediate',
    args: [shape.number],
    result: shape.number,
    cost: { fuel: 11 },
    do: forbiddenHost,
  },
  write: {
    mode: 'fire-and-forget',
    args: [shape.number],
    cost: { fuel: 11 },
    fire: forbiddenHost,
  },
}).grant('all', undefined);

const root = resolve(import.meta.dir, '../../../corpus/restricted-kit');
const intrinsic = (group: TsGroup) => {
  // This test-only Host constructs a private Function Value. No Script import
  // or production embedding API exposes the intrinsic.
  const home = (group as unknown as { scripts: { loaded: Script }[] })
    .scripts[0]!.loaded;
  const code = codeOf(stdlibLibrary('map'));
  const body = code.function('restrictedCall');
  return functionValue({
    home: 's',
    place: 'map:restrictedCall',
    identity: `s#${code.identity}#${body.index}`,
    group: home.functionGroup,
    maySuspend: false,
    captures: [],
    code: { home, code, body },
  });
};
const setup = (fixture: (typeof cases)[number], lines: string[]) => {
  const group = newGroup({
    name: 'restricted',
    trace: line => lines.push(line),
  });
  group.load({
    name: 's',
    source: fixture.source,
    ...(fixture.host ? { grants: { api } } : {}),
    limits: {
      ...(fixture.fuelLimit ? { fuelPerRun: fixture.fuelLimit } : {}),
      ...(fixture.allocLimit ? { allocPerRun: fixture.allocLimit } : {}),
      ...(fixture.depthLimit ? { callDepth: fixture.depthLimit } : {}),
    },
  });
  const args = [intrinsic(group)];
  if (fixture.object) {
    const o = group.object(objectKind, 'o1', null);
    if (fixture.disposed) {
      group.dispose(o);
      group.pump(0n);
    }
    args.push(o.value);
  }
  if (fixture.foreign) {
    group.load({
      name: 'other',
      source: 'function callback n\n return n\nend callback\n',
    });
    const home = (group as unknown as { scripts: { loaded: Script }[] })
      .scripts[1]!.loaded;
    const body = home.function('callback');
    args.push(
      functionValue({
        home: 'other',
        place: 'callback',
        identity: `other#${home.identity}#${body.index}`,
        group: home.functionGroup,
        maySuspend: false,
        captures: [],
        code: { home, code: home, body },
      }),
    );
  }
  lines.length = 0;
  group.script('s')!.deliver({ name: 'go', args });
  return group;
};

test('trusted stdlib lowering is separate from identical Host compilation', () => {
  const first = compileLibrary({
    name: 'map',
    source: stdlibSources.map!,
    version: 'test',
  });
  const trusted = stdlibLibrary('map');
  expect(() =>
    newGroup({ name: 'access-test' }).load({
      name: 'private',
      source: 'use restrictedCall from map\n',
    }),
  ).toThrow(LoadError);
  expect(codeOf(first).unit.code.some(i => i.op === 'call-restricted')).toBe(
    false,
  );
  for (const options of [{}, { atCaller: true }]) {
    const host = compileLibrary(
      { name: 'map', source: trusted.source, version: trusted.version },
      [],
      {},
      options,
    );
    expect(codeOf(host).unit.code.some(i => i.op === 'call-restricted')).toBe(
      false,
    );
    expect(
      codeOf(trusted).unit.code.filter(i => i.op === 'call-restricted'),
    ).toHaveLength(1);
  }
  const dis = disassemble(codeOf(trusted).unit);
  if (process.env.UPDATE_RESTRICTED_KIT === '1') {
    writeFileSync(resolve(root, 'map.dis'), dis);
  }
  expect(dis).toBe(readFileSync(resolve(root, 'map.dis'), 'utf8'));
});

for (const fixture of cases) {
  test(`restricted callback: ${fixture.name}`, () => {
    const lines: string[] = [];
    const group = setup(fixture, lines);
    group.pump(0n);
    group.inspect();
    const run = lines.find(
      l => l.startsWith('run ') && l.includes('handler=go'),
    )!;
    expect(run).toBeDefined();
    expect(run).toContain(
      fixture.result === 'fault'
        ? 'outcome=limit-fault'
        : `value=${fixture.result}`,
    );
    const file = resolve(root, `${fixture.name}.trace`);
    const header = existsSync(file)
      ? (readFileSync(file, 'utf8').match(/^#.*\n/)?.[0] ?? '')
      : `# Unblessed: restricted callback ${fixture.name} (#696); first blessing awaits human review.\n`;
    const text = `${header}${lines.join('\n')}\n`;
    if (process.env.UPDATE_RESTRICTED_KIT === '1') {
      writeFileSync(file, text);
    }
    expect(text).toBe(readFileSync(file, 'utf8'));
  });

  test(`restricted callback restored after each instruction: ${fixture.name}`, () => {
    const lines: string[] = [],
      copied: string[] = [];
    const original = setup(fixture, lines);
    original.pump(0n, { fuelSlice: 1 });
    for (let step = 0; step < 1000; step++) {
      const bytes = original.save();
      const copy = restore(bytes, {
        name: 'restricted',
        onMismatch: 'reject',
        libraries: [],
        grants: () => api,
        resolve: () => ({ native: null }),
        trace: l => copied.push(l),
      }).group;
      lines.length = copied.length = 0;
      const a = original.pump(0n, { fuelSlice: 1 });
      const b = copy.pump(0n, { fuelSlice: 1 });
      expect(b).toEqual(a);
      expect(copied).toEqual(lines);
      expect(copy.inspect()).toEqual(original.inspect());
      if (a.state === 'idle') {
        return;
      }
    }
    throw new Error('restricted callback did not finish');
  });
}
