import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compileSource } from '../src/lowering';
import { compileSource as referenceCompile } from '../../../tools/machine/compile';
import { resolve } from 'node:path';
import { runTraceCase } from '../tools/trace-case';
import { deliver, loadScript } from '../src/machine';

const cases = JSON.parse(
  readFileSync(
    new URL('../../../tools/machine/recovery-cases.json', import.meta.url),
    'utf8',
  ),
) as {
  alloc?: number;
  fuel?: number;
  name: string;
  result: string;
  source: string;
}[];
for (const c of cases) {
  test(c.name, () => {
    const compiled = compileSource(c.source, { name: 'test' });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.error).toBeNull();
    expect(compiled.unit).not.toBeNull();
    const reference = referenceCompile('test', 'script', c.source);
    expect(reference.offers).toEqual(compiled.unit!.offers);
    expect(reference.code.map(i => i.op)).toEqual(
      compiled.unit!.code.map(i => i.op),
    );
    const run = deliver(loadScript(compiled.unit!), 'go', []);
    const outcome = run.finish();
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.result.toString()).toBe(c.result);
    }
    if (c.fuel !== undefined) {
      expect(run.fuel).toBe(c.fuel);
    }
    if (c.alloc !== undefined) {
      expect(run.alloc).toBe(c.alloc);
    }
  });
}

test('dispatch state counts owner locals once and lookup is atomic at Fuel boundaries', () => {
  const source = cases.at(-1)!.source;
  const unit = compileSource(source, { name: 'test' }).unit!;
  const run = deliver(loadScript(unit), 'go', []);
  while (unit.code[run.frames.at(-1)!.pc]!.op !== 'choose-offer') {
    run.step();
  }
  // Error: top map 32 + code key/text 39 + at key/map 221 = 292 bytes.
  // Run 96 + owner (104 + 2*8 + 3*292) + context (96+292)
  // + activation (48+16) = 1544. Its locals share the owner's storage.
  expect(run.size()).toBe(1544);
  expect(run.fuel).toBe(20);
  run.step();
  expect(run.fuel).toBe(33); // choose 8+1, complete one-frame lookup 4.
  expect(
    run.records.filter(r => r.kind.startsWith('offer-')).map(r => r.kind),
  ).toEqual(['offer-chosen', 'offer-entered']);
  expect(run.finish().kind).toBe('completed');

  const failed = deliver(loadScript(unit), 'go', [], { fuelPerRun: 32 });
  expect(failed.finish().kind).toBe('limit fault');
  expect(failed.fuel).toBe(29);
  expect(failed.records.filter(r => r.kind.startsWith('offer-'))).toEqual([]);

  const atEntry = deliver(loadScript(unit), 'go', [], { fuelPerRun: 33 });
  expect(atEntry.finish().kind).toBe('limit fault');
  expect(
    atEntry.records.filter(r => r.kind.startsWith('offer-')).map(r => r.kind),
  ).toEqual(['offer-chosen', 'offer-entered']);
});

test('cleanup helpers count retained real frames for call depth', () => {
  const source = cases.find(
    c => c.name === 'cleanup helper counts retained depth',
  )!.source;
  const unit = compileSource(source, { name: 'test' }).unit!;
  const run = deliver(loadScript(unit), 'go', [], { callDepth: 3 });
  expect(run.finish()).toMatchObject({
    kind: 'limit fault',
    limit: 'callDepth',
  });
});

test('ordinary acceptance retains its dispatch activation through cleanup', () => {
  const source =
    'function fail\n try\n  throw "bad"\n finally\n  put 1 into x\n end try\nend fail\non go\n try\n  put fail() into y\n catch e\n  return 1\n end try\nend go';
  const unit = compileSource(source, { name: 'test' }).unit!;
  const run = deliver(loadScript(unit), 'go', []);
  while (
    run.frames.at(-1)!.code.unit.code[run.frames.at(-1)!.pc]!.op !==
    'catch-accept'
  ) {
    run.step();
  }
  const before = run.size();
  run.step();
  expect(run.size()).toBe(before);
  expect(run.finish().kind).toBe('completed');
});

for (const name of ['basic', 'boundaries', 'costs', 'cleanup-restore']) {
  test(`unblessed Recovery Offers Trace: ${name}`, () => {
    const dir = resolve(
      import.meta.dir,
      '../../../corpus/recovery-offers',
      name,
    );
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    );
    expect(runTraceCase(dir, setup as never).divergence).toBeUndefined();
  });
}

const boundaries = JSON.parse(
  readFileSync(
    new URL('../../../tools/machine/recovery-boundaries.json', import.meta.url),
    'utf8',
  ),
) as {
  fuel: number;
  limit: number;
  line: number;
  name: string;
  source: string;
}[];
for (const c of boundaries) {
  test(c.name, () => {
    const unit = compileSource(c.source, { name: 'test' }).unit!;
    const run = deliver(loadScript(unit), 'go', [], { fuelPerRun: c.limit });
    expect(run.finish()).toMatchObject({
      kind: 'limit fault',
      limit: 'fuelPerRun',
      line: c.line,
    });
    expect(run.fuel).toBe(c.fuel);
    expect(run.records.filter(r => r.kind === 'raise')).toHaveLength(1);
    expect(run.records.filter(r => r.kind.startsWith('offer-'))).toEqual([]);
  });
}

test('pending cleanup retains original operands separately from cleanup operands', () => {
  const source =
    'function fail\n throw "bad"\nend fail\nfunction work\n try\n  return "ABC" & fail()\n finally\n  put 1 into x\n end try\nend work\non go\n try\n  return work()\n catch e\n  return 1\n end try\nend go';
  const unit = compileSource(source, { name: 'test' }).unit!;
  const run = deliver(loadScript(unit), 'go', []);
  while (unit.code[run.frames.at(-1)!.pc]!.op !== 'catch-accept') {
    run.step();
  }
  expect(run.size()).toBe(1445);
  run.step();
  expect(run.size()).toBe(1445);
  run.step();
  expect(run.size()).toBe(1461);
  expect(run.finish().kind).toBe('completed');
});
