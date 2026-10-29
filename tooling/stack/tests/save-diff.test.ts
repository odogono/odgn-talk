import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createGroup, type Group } from '@northtalk/ts';
import {
  createCore as createWasmCore,
  createGroup as createWasmGroup,
} from '@northtalk/ts/wasm';
import { artifact } from '../../../impl/ts/tests/reactor-artifact';
import { decodeSave, diffSaves, dumpSave } from '../src/save-diff';

const source = `script variable count = 0
script variable label = "x"
on bump
  add 1 to count
end bump
`;

const module = existsSync(artifact)
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

const cores = {
  ts: async () => createGroup({ name: 'g', seed: 1n }),
  zig: async () =>
    createWasmGroup({
      name: 'g',
      seed: 1n,
      core: await createWasmCore({ wasm: module! }),
    }),
};

for (const [core, open] of Object.entries(cores)) {
  describe.skipIf(core === 'zig' && !module)(`${core} saves`, () => {
    test('name the Script and variable that differ', async () => {
      await using group = await open();
      const script = group.load({ name: 'a', source });
      const before = group.save();
      await script.invoke('bump');
      const diff = diffSaves(before, group.save());
      expect(diff.sameState).toBe(false);
      expect(diff.differences).toContainEqual({
        path: 'script "a" / variable count (#0)',
        a: 'number 0',
        b: 'number 1',
      });
    });

    test('report no difference between equal saves', async () => {
      await using group = await open();
      group.load({ name: 'a', source });
      const save = group.save();
      expect(diffSaves(save, save)).toEqual({
        sameState: true,
        differences: [],
        notes: [],
      });
    });

    test('note a changed save id counter outside the state', async () => {
      await using group = await open();
      group.load({ name: 'a', source });
      const diff = diffSaves(group.save(), group.save());
      expect(diff.sameState).toBe(true);
      expect(diff.differences).toEqual([]);
      expect(diff.notes.map(n => n.path)).toEqual(['save id counter']);
    });

    test('dump a save as a tree', async () => {
      await using group = await open();
      group.load({ name: 'a', source });
      const dump = dumpSave(decodeSave(group.save()));
      expect(dump).toContain('magic: NTSV');
      expect(dump).toContain('variable label (#1): text');
    });
  });
}

describe.skipIf(!module)('across Cores', () => {
  test('a TS and a Zig save of the same state do not differ', async () => {
    const saves: Uint8Array[] = [];
    for (const open of Object.values(cores)) {
      await using group: Group & AsyncDisposable = await open();
      group.load({ name: 'a', source });
      saves.push(group.save());
    }
    expect(diffSaves(saves[0]!, saves[1]!)).toEqual({
      sameState: true,
      differences: [],
      notes: [],
    });
  });
});

test('a save that is not a save is rejected', () => {
  expect(() => decodeSave(new TextEncoder().encode('{"group":1}'))).toThrow(
    'invalid save',
  );
});
