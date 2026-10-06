import { expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';

const source = `script variable order = []
script variable mark = 0
function fail
 try
  throw "bad"
 finally
  put 1 after order
 end try
end fail
function work
 try
  try
   put fail() into ignored
  finally
   put 2 after order
  end try
 offer recover
  put 99 after order
 finally
  put 3 after order
 end try
end work
on go
 try
  put work() into ignored
 catch e before unwind
  try
   put 9 into mark
   choose offer recover
  finally
   put 5 after order
  end try
 finally
  put 4 after order
 end try
end go`;

for (const phase of ['tests', 'policy', 'nested', 'transfer'] as const) {
  test(`cancellation during recovery ${phase} runs retained and local scopes once`, () => {
    const activeSource =
      phase === 'nested'
        ? source.replace(
            'put 9 into mark',
            'try\n throw "policy"\ncatch e before unwind\n choose offer unavailable\nend try',
          )
        : source;
    const compiled = compileSource(activeSource, { name: 'test' });
    expect(compiled.diagnostics).toEqual([]);
    const script = loadScript(compiled.unit!);
    const run = deliver(script, 'go', []);
    let found = false;
    for (let n = 0; n < 1000 && !run.done; n++) {
      const f = run.frames.at(-1)!;
      const op = f.code.unit.code[f.pc]!.op;
      if (
        (phase === 'tests' && f.activation) ||
        (phase !== 'tests' && op === 'choose-offer')
      ) {
        found = true;
        break;
      }
      run.step();
    }
    expect(found).toBe(true);
    if (phase === 'transfer') {
      run.step();
    }
    const fuel = run.fuel;
    run.cancel();
    expect(run.finish().kind).toBe('cancelled');
    expect(script.variables.map(v => v.toString())).toEqual([
      phase === 'policy' || phase === 'nested'
        ? '[5, 1, 2, 3, 4]'
        : '[1, 2, 3, 4]',
      '0',
    ]);
    expect(run.fuel - fuel).toBe(
      phase === 'policy' || phase === 'nested' ? 55 : 44,
    );
    expect(run.records.filter(r => r.kind === 'offer-entered')).toEqual([]);
  });
}

for (const budget of [0, 10]) {
  test(`cancellation during policy uses Cleanup Budget ${budget}`, () => {
    const unit = compileSource(source, { name: 'test' }).unit!;
    const script = loadScript(unit);
    const run = deliver(script, 'go', [], { cleanupBudget: budget });
    while (
      run.frames.at(-1)!.code.unit.code[run.frames.at(-1)!.pc]!.op !==
      'choose-offer'
    ) {
      run.step();
    }
    run.cancel();
    expect(run.finish()).toMatchObject({
      kind: 'cancelled',
      cleanupFailed: { limit: 'cleanupBudget' },
    });
    expect(script.variables.map(v => v.toString())).toEqual(['[]', '0']);
    expect(run.records.filter(r => r.kind === 'offer-entered')).toEqual([]);
  });
}
