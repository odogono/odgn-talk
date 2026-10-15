// Compare complete Traces, accounting, faults and canonical saved bytes across
// baseline and optimized checkouts by running this unchanged in each.
import { encodeValue, newGroup, restore, Value } from '@odgn/northtalk';
const source = `script variable q = 1500 mm
on run
  repeat 8 times
    put q as m into q
    put q as mm into q
  end repeat
  return [q, (9 degF as degC) as degF, 24 m^3 as L, q can be s, 4 yd / 2 ft]
end run`;
const result = [];
for (const [name, limits, slice] of [
  ['ordinary', {}, undefined],
  ['sliced', {}, 1],
  ['fuel-fault', { fuelPerRun: 40 }, 1],
  ['alloc-fault', { allocPerRun: 100 }, 1],
] as const) {
  const trace: string[] = [];
  const g = newGroup({
    name: 'units',
    trace: (line: string) => trace.push(line),
  });
  const s = g.load({ name: 's', source, limits });
  s.deliver({ name: 'run' });
  const pumps = [];
  for (let i = 0; i < 10_000; i++) {
    const pump = g.pump(0n, slice ? { fuelSlice: slice } : {});
    pumps.push(pump);
    if (pump.state === 'idle') {
      break;
    }
    if (i === 9999) {
      throw new Error('did not finish');
    }
  }
  const saved = g.save();
  const { group: copy } = restore(saved, {
    name: 'units',
    libraries: [],
    grants: () => undefined,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  copy
    .script('s')!
    .reload(source.replace('as m into', 'as cm into'), 'carry variables');
  copy.script('s')!.deliver({ name: 'run' });
  const reloaded = copy.pump(0n);
  result.push({
    name,
    pumps,
    trace,
    saved: Buffer.from(saved).toString('base64'),
    reloaded,
  });
}
process.stdout.write(
  JSON.stringify(result, (_key, value) =>
    Value.isValue(value) ? { valueEncoding: encodeValue(value) } : value,
  ),
);
