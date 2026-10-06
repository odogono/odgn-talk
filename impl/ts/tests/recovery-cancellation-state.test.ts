import { expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';

const source = `script variable result
on go
 put [1, 2, 3] into kept
 try
  throw "bad"
 offer recover
 catch e before unwind
  try
   choose offer recover
  finally
   put kept into result
  end try
 end try
end go`;

test('cancelled policy cleanup retains real owner locals without an owner finally', () => {
  const compiled = compileSource(source, { name: 'test' });
  expect(compiled.diagnostics).toEqual([]);
  const script = loadScript(compiled.unit!);
  const run = deliver(script, 'go', []);
  while (
    run.frames.at(-1)!.code.unit.code[run.frames.at(-1)!.pc]!.op !==
    'choose-offer'
  ) {
    run.step();
  }
  run.cancel();
  // Run 96 + activation 48 + owner 64 + five slots 40 + local Values 972.
  // The real owner has no queued finally, but its locals still protect kept.
  expect(run.size()).toBe(1220);
  expect(run.finish().kind).toBe('cancelled');
  expect(script.variables[0]!.toString()).toBe('[1, 2, 3]');
});
