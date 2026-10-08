import { expect, test } from 'bun:test';
import { compileLibrary, HostError, newGroup, restore } from '../src/index';
import { sha256 } from '../src/sha256';
import { operationalReports } from './operational-reports';

const original = 'function double n, m = 1\n  return n * 2\nend double';
const replacement = 'function double n\n  return n + n\nend double';
const library = (source: string) =>
  compileLibrary({ name: 'maths', version: '1', source });
const variables = `script variable f
script variable pair
script variable zero
on setup
  put double into f
  put given [x, y], z: x + y + z into pair
  put given: 1 into zero
end setup
on inspect
  return [functionName(f), functionArity(f), functionName(pair), functionArity(pair), functionName(zero), functionArity(zero)]
end inspect
on callOld
  try
    f(2)
  catch e
    return the code of e
  end try
end callOld`;

for (const mode of [
  'reload',
  'replace library',
  'variables only',
  'variables only changed library',
]) {
  test(`Function Value metadata survives ${mode} and repeated saves`, () => {
    const fromLibrary = mode.includes('library');
    let libraries = fromLibrary ? [library(original)] : [];
    let group = newGroup({ name: 'g' });
    for (const lib of libraries) {
      group.addLibrary(lib);
    }
    group.load({
      name: 's',
      source: `${fromLibrary ? 'use double from maths' : original}\n${variables}`,
    });
    group.script('s')!.deliver({ name: 'setup' });
    group.pump(0n);
    if (mode === 'reload') {
      group
        .script('s')!
        .reload(`${replacement}\n${variables}`, 'carry variables');
    } else if (mode === 'replace library') {
      libraries = [library(replacement)];
      group.replaceLibrary(libraries[0]!, 'carry variables');
    } else if (fromLibrary) {
      libraries = [library(replacement)];
    } else {
      libraries = [library(original)];
    }
    for (let round = 0; round < 2; round++) {
      const { group: copy, result } = restore(group.save(), {
        name: 'resumed',
        libraries,
        grants: () => undefined,
        resolve: () => undefined,
        onMismatch: mode.startsWith('variables only')
          ? 'variables only'
          : 'reject',
      });
      expect(result.variablesOnly).toBe(
        round === 0 && mode.startsWith('variables only'),
      );
      group = copy;
      group.script('s')!.deliver({ name: 'inspect' });
      const report = operationalReports(group.pump(0n).reports)[0]!;
      expect(report).toMatchObject({
        outcome: 'completed',
      });
      expect('result' in report && report.result!.toString()).toBe(
        '["double", 1..2, nothing, 2..2, nothing, 0..0]',
      );
      group.script('s')!.deliver({ name: 'callOld' });
      const call = operationalReports(group.pump(0n).reports)[0]!;
      expect(call).toMatchObject({ outcome: 'completed' });
      expect('result' in call && call.result!.toString()).toBe(
        '"function gone"',
      );
    }
  });
}

test('restore rejects malformed stale Function Value metadata', () => {
  const group = newGroup({ name: 'g' });
  group.load({ name: 's', source: `${original}\n${variables}` });
  group.script('s')!.deliver({ name: 'setup' });
  group.pump(0n);
  group.script('s')!.reload(`${replacement}\n${variables}`, 'carry variables');
  const bytes = group.save();
  for (const [field, value] of [
    ['min', -1],
    ['max', 0],
    ['name', 1],
  ]) {
    const outer = JSON.parse(new TextDecoder().decode(bytes));
    const saved = JSON.parse(outer.payload);
    const head = saved.graph.nodes.find(
      (node: { data: [string, unknown][]; kind: string }) =>
        node.kind === 'object' && node.data.some(([key]) => key === 'min'),
    );
    head.data.find(([key]: [string, unknown]) => key === field)[1] = value;
    outer.payload = JSON.stringify(saved);
    outer.hash = sha256(outer.payload);
    expect(() =>
      restore(new TextEncoder().encode(JSON.stringify(outer)), {
        name: 'resumed',
        libraries: [],
        grants: () => undefined,
        resolve: () => undefined,
        onMismatch: 'reject',
      }),
    ).toThrow(HostError);
  }
});
