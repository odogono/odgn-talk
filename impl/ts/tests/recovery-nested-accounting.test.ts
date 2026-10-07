import { expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';

const source = `on go
 try
  try
   throw "original"
  offer recover
  catch "original" before unwind
   throw "policy"
  end try
 catch "policy" before unwind
  put offerAvailable("recover") into visible
 catch "policy"
  return visible
 end try
end go`;

test('lookup after policy escape examines a shared real owner once', () => {
  const unit = compileSource(source, { name: 'test' }).unit!;
  const run = deliver(loadScript(unit), 'go', []);
  while (
    run.frames.at(-1)!.code.unit.code[run.frames.at(-1)!.pc]!.op !==
    'call-builtin'
  ) {
    run.step();
  }
  const fuel = run.fuel;
  run.step();
  expect(run.fuel - fuel).toBe(8); // base/text 4 + one real owner 4.
  const result = run.finish();
  expect(result.kind).toBe('completed');
  if (result.kind === 'completed') {
    expect(result.result.toString()).toBe('false');
  }
});

test('nested activations do not consume helper call depth', () => {
  const unit = compileSource(
    `function helper
 return 7
end helper
on go
 try
  throw "original"
 offer recover value
  return value
 catch "original" before unwind
  try
   throw "inner"
  catch "inner" before unwind
   put helper() into replacement
  catch "inner"
  end try
  choose offer recover(replacement)
 end try
end go`,
    { name: 'test' },
  ).unit!;
  const run = deliver(loadScript(unit), 'go', [], { callDepth: 2 });
  const result = run.finish();
  expect(result.kind).toBe('completed');
  if (result.kind === 'completed') {
    expect(result.result.toString()).toBe('7');
  }
});
