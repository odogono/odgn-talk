import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileSource } from '@odgn/northtalk';
import { debugParitySkips, replay } from '../../../impl/ts/tools/trace-case';
import { LiveDebugger } from '../src/debug';

const root = resolve(import.meta.dir, '../../../corpus');
const cases = [...new Bun.Glob('**/case.toml').scanSync({ cwd: root })]
  .sort()
  .flatMap(path => {
    const setup = Bun.TOML.parse(readFileSync(resolve(root, path), 'utf8')) as {
      kind: string;
      scripts?: { name: string; source: string }[];
    };
    return setup.kind === 'trace' && !debugParitySkips.has(path)
      ? [{ path, setup }]
      : [];
  });
test('live-debugger parity discovers all corpus Trace Cases', () => {
  expect(cases.length).toBeGreaterThan(100);
});
for (const { path, setup } of cases) {
  const dir = resolve(root, path, '..');
  const units = (setup.scripts ?? []).flatMap(s => {
    // Cases needing Host declarations are still checked with fault breaks;
    // the Core hook suite additionally pauses their every instruction.
    const unit = compileSource(readFileSync(resolve(dir, s.source), 'utf8'), {
      name: s.name,
    }).unit;
    return unit ? [{ unit, script: s.name }] : [];
  });
  for (const restoreBetweenPumps of [false, true]) {
    test(`live debugger preserves ${path} (${restoreBetweenPumps ? 'restore' : 'ordinary'})`, () => {
      const trace = readFileSync(resolve(dir, 'case.trace'), 'utf8').split(
        '\n',
      );
      const expected = replay(dir, setup as never, trace);
      const actual = replay(dir, setup as never, trace, {
        restoreBetweenPumps,
        configureDebug(group) {
          const debug = new LiveDebugger(group, { now: () => 0n });
          for (const { unit, script } of units) {
            debug.registerSource(unit, script);
          }
          debug.setBreakpoints(
            units.flatMap(({ unit, script }) =>
              [...new Set(unit.code.map(i => i.line))].map(line => ({
                unit: unit.name,
                script,
                line,
              })),
            ),
          );
          debug.pauseOn({ error: true, limitFault: true });
          group.debug().paused = () => {
            debug.snapshot();
          };
        },
      });
      expect(actual).toEqual(expected);
    }, 60_000);
  }
}
