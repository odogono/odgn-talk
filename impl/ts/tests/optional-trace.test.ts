import { expect, test } from 'bun:test';
import { newGroup, num, restore, type Group } from '../src/index';

test('Trace presence preserves Broadcasts, suspended Joins, rollback and save bytes', () => {
  const lines: string[] = [];
  const traced = newGroup({ name: 'g', trace: line => lines.push(line) });
  const silent = newGroup({ name: 'g' });
  const source = `script variable total = 0
on echo n
  return n
end echo
on run
  wait 0 s
  wait for all
    send echo with 2 to me and wait
    send echo with 3 to me and wait
  end wait
  repeat for each answer in it
    add answer to total
  end repeat
  return total
end run
on fail
  add 100 to total
  repeat forever
  end repeat
end fail`;
  for (const group of [traced, silent]) {
    group.load({ name: 's', source });
    group.broadcast({ name: 'echo', args: [num(7)] });
    group.script('s')!.deliver({ name: 'run' });
  }
  const pump = (a: Group, b: Group, sliced = false) => {
    const result = a.pump(0n, sliced ? { fuelSlice: 10 } : {});
    expect(b.pump(0n, sliced ? { fuelSlice: 10 } : {})).toEqual(result);
    expect(b.inspect()).toEqual(a.inspect());
    return result;
  };
  // Save both a queued Broadcast and, later, an active Run.
  expect(silent.save()).toEqual(traced.save());
  pump(traced, silent, true);
  const saved = traced.save();
  expect(silent.save()).toEqual(saved);
  const copy = (withTrace: boolean) =>
    restore(saved, {
      name: 'g',
      trace: withTrace ? line => lines.push(line) : undefined,
      grants: () => undefined,
      libraries: [],
      onMismatch: 'reject',
      resolve: () => undefined,
    }).group;
  const a = copy(true);
  const b = copy(false);
  const copies = [a, b];
  let completed = false;
  for (let i = 0; i < 100; i++) {
    const result = pump(a, b);
    if (
      result.reports.some(r => r.kind === 'run end' && r.result?.equals(num(5)))
    ) {
      completed = true;
      break;
    }
  }
  expect(completed).toBe(true);
  for (const group of copies) {
    group.script('s')!.deliver({ name: 'fail', limits: { fuelPerRun: 30 } });
  }
  expect(pump(a, b).reports).toContainEqual(
    expect.objectContaining({ kind: 'run end', outcome: 'limit fault' }),
  );
  expect(a.inspect().scripts[0]!.vars[0]![1].equals(num(5))).toBe(true);
  expect(b.save()).toEqual(a.save());
  expect(lines.some(line => line.startsWith('> broadcast '))).toBe(true);
  expect(lines.some(line => line.startsWith('fault '))).toBe(true);
});
