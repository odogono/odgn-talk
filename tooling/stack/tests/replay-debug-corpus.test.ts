import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTranscript, replayTranscript } from '@odgn/northtalk/session';
import type { Setup } from '@odgn/northtalk/setup';
import {
  debugParitySkips,
  replay,
  same,
} from '../../../impl/ts/tools/trace-case';
import { ReplayDebugger } from '../src/debug';

const root = resolve(import.meta.dir, '../../../corpus');
let count = 0;
for (const path of [
  ...new Bun.Glob('**/case.toml').scanSync({ cwd: root }),
].sort()) {
  const dir = resolve(root, path, '..');
  const setup = Bun.TOML.parse(
    readFileSync(resolve(root, path), 'utf8'),
  ) as Setup & { kind: string };
  if (
    !['trace', 'transcript'].includes(setup.kind) ||
    debugParitySkips.has(path)
  ) {
    continue;
  }
  count++;
  test(`replay debugger reproduces ${path} with fault breaks and source breakpoints`, () => {
    const actualSetup =
      setup.kind === 'transcript'
        ? replayTranscript(
            parseTranscript(
              readFileSync(resolve(dir, 'session.transcript'), 'utf8'),
            ),
          ).host.setup
        : setup;
    const lines = readFileSync(resolve(dir, 'case.trace'), 'utf8').split('\n');
    const debug = new ReplayDebugger(actualSetup, lines, file =>
      readFileSync(resolve(dir, file), 'utf8'),
    );
    debug.pauseOn({ error: true, limitFault: true });
    debug.setBreakpoints(
      (actualSetup.scripts ?? []).flatMap(s =>
        (s.text ?? readFileSync(resolve(dir, s.source), 'utf8'))
          .split('\n')
          .map((_, i) => ({ unit: s.name, line: i + 1 })),
      ),
    );
    let result = debug.resume();
    while (result.state === 'paused') {
      debug.snapshot();
      debug.clearBreakpoints();
      result = debug.resume();
    }
    expect(result.state).toBe('ended');
    const expected = lines.filter(l => l && !l.startsWith('#'));
    expect(debug.trace.length).toBe(expected.length);
    debug.trace.forEach((line, i) =>
      expect(same(expected[i]!, line)).toBe(true),
    );
    expect(debug.trace).toEqual(
      replay(dir, actualSetup, lines, { restoreBetweenPumps: true }),
    );
  }, 60_000);
}
test('replay coverage includes Trace Cases and Session Transcripts', () =>
  expect(count).toBeGreaterThan(150));

test('seeking callback Stop and CancelRun inputs exposes their completed Pump boundary', () => {
  const dir = resolve(root, 'cancellation/host-crossings');
  const setup = Bun.TOML.parse(
    readFileSync(resolve(dir, 'case.toml'), 'utf8'),
  ) as Setup;
  const lines = readFileSync(resolve(dir, 'case.trace'), 'utf8').split('\n');
  const debug = new ReplayDebugger(setup, lines, file =>
    readFileSync(resolve(dir, file), 'utf8'),
  );
  for (const n of [6, 7]) {
    expect(debug.runToHostInput(n)).toEqual({
      state: 'input',
      hostInputIndex: n,
      applied: true,
    });
    expect(debug.trace.at(-1)).toBe('pumped state=idle fuel=40');
    expect(debug.resume().state).toBe('ended');
  }
});
