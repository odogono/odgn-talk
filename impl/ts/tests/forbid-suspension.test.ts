// `forbidSuspension` (ADR 0178): the Group Fingerprint and the Inspection
// name it only when set, and a save keeps it in the optional `suspension`
// section. The Corpus cases `load-diagnostics/forbid-suspension` and
// `reload/forbid-suspension` cover the load errors.
import { describe, expect, test } from 'bun:test';
import { HostError, LoadError, newGroup, restore } from '../src/index';
import { readSave, saveSections } from '../src/save-format';
import { editSave } from './save-edit';

const source = 'script variable n = 0\non go\n  put n + 1 into n\nend go';
const restoreOptions = {
  name: 'resumed',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
};
const group = (forbid: Record<string, boolean | undefined>) => {
  const g = newGroup({ name: 'g' });
  for (const [name, forbidSuspension] of Object.entries(forbid)) {
    g.load({
      name,
      source,
      ...(forbidSuspension === undefined ? {} : { forbidSuspension }),
    });
  }
  return g;
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('forbidSuspension', () => {
  test('refuses a wait, and the same source loads with the option off', () => {
    const g = newGroup({ name: 'g' });
    const waits = 'on go\n  wait 1 s\nend go';
    expect(() =>
      g.load({ name: 'a', source: waits, forbidSuspension: true }),
    ).toThrow(LoadError);
    expect(() =>
      g.load({ name: 'b', source: waits, forbidSuspension: false }),
    ).not.toThrow();
  });

  test('the Fingerprint names the option only when it is set', () => {
    const plain = hex(group({ a: undefined, b: undefined }).fingerprint());
    expect(hex(group({ a: false, b: false }).fingerprint())).toBe(plain);
    expect(hex(group({ a: true, b: undefined }).fingerprint())).not.toBe(plain);
  });

  test('the Inspection shows it only for a Script loaded with it', () => {
    const views = group({ a: true, b: false }).inspect().scripts;
    expect(views.map(s => s.forbidSuspension)).toEqual([true, undefined]);
    expect('forbidSuspension' in views[1]!).toBe(false);
  });

  test('a save lists the Scripts that have it, and a restore keeps it', () => {
    const g = group({ a: false, b: true, c: true });
    const saved = g.save();
    const body = readSave(saved).body(saveSections.suspension);
    // The list's count, then positions 1 and 2.
    expect([...body!]).toEqual([2, 1, 2]);
    const { group: copy, result } = restore(saved, restoreOptions);
    expect(result.variablesOnly).toBe(false);
    expect(hex(copy.fingerprint())).toBe(hex(g.fingerprint()));
    expect(copy.inspect().scripts.map(s => s.forbidSuspension)).toEqual([
      undefined,
      true,
      true,
    ]);
    expect(() =>
      copy.script('b')!.reload('on go\n  wait 1 s\nend go', 'carry variables'),
    ).toThrow(LoadError);
  });

  test('a save without such a Script leaves the section out', () => {
    const saved = group({ a: false }).save();
    expect(readSave(saved).body(saveSections.suspension)).toBeUndefined();
  });

  test('a save that lost the section is a mismatch, not a full restore', () => {
    const saved = editSave(group({ a: true }).save(), records => {
      records.suspension = undefined;
    });
    expect(() => restore(saved, restoreOptions)).toThrow(
      new HostError('save mismatch'),
    );
    const { group: copy, result } = restore(saved, {
      ...restoreOptions,
      onMismatch: 'variables only',
    });
    expect(result.variablesOnly).toBe(true);
    expect(copy.inspect().scripts[0]!.forbidSuspension).toBeUndefined();
  });

  test.each([
    ['empty', []],
    ['out of range', [2]],
    ['not ascending', [1, 0]],
    ['repeated', [0, 0]],
  ])('a section that is %s is invalid save', (_, forbidden) => {
    const saved = editSave(group({ a: true, b: true }).save(), records => {
      records.suspension = forbidden;
    });
    expect(() => restore(saved, restoreOptions)).toThrow(
      new HostError('invalid save'),
    );
  });
});
