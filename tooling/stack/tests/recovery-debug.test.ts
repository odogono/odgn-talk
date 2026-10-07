import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { newGroup } from '@odgn/northtalk';
import { LiveDebugger, ReplayDebugger } from '../src/debug';

for (const name of [
  'helper',
  'isolated',
  'order',
  'aborted',
  'choice-cleanup',
]) {
  test(`live and reverse replay preserve nested recovery ${name}`, () => {
    const source = readFileSync(
      new URL(
        `../../../corpus/recovery-offers/nested/${name}.talk`,
        import.meta.url,
      ),
      'utf8',
    );
    const run = (paused: boolean) => {
      const trace: string[] = [];
      const group = newGroup({ name: 'case', trace: line => trace.push(line) });
      const script = group.load({ name: 's', source });
      const debug = new LiveDebugger(group, { now: () => 0n });
      const loaded = group.debug().sources()[0]!;
      debug.registerSource(loaded.unit, 's');
      if (paused) {
        group
          .debug()
          .breakAt(loaded.unit.code.map((_, pc) => ({ unit: 's', pc })));
      }
      script.deliver({ name: 'go' });
      let result = debug.pump();
      let dispatches = 0;
      while (result.state === 'paused') {
        const frames = debug.snapshot().scripts[0]!.runs[0]!.frames;
        expect(frames.at(-1)).toMatchObject({
          pc: debug.current!.pc,
          unit: debug.current!.unit,
        });
        for (const frame of frames) {
          if (frame.owner !== undefined) {
            dispatches++;
            expect(frame.locals).toEqual(frames[frame.owner]!.locals);
          }
        }
        result = debug.resume();
      }
      if (paused) {
        expect(dispatches).toBeGreaterThan(0);
      }
      return trace;
    };
    const trace = run(false);
    expect(run(true)).toEqual(trace);
    const replay = new ReplayDebugger(
      { scripts: [{ name: 's', source: '', text: source }] },
      trace,
    );
    replay.setBreakpoints(
      source.split('\n').map((_, i) => ({ unit: 's', line: i + 1 })),
    );
    let result = replay.resume();
    while (result.state === 'paused') {
      replay.snapshot();
      result = replay.resume();
    }
    expect(result.state).toBe('ended');
    expect(replay.trace).toEqual(trace);
    if (name === 'helper') {
      expect(
        trace
          .filter(line => line.startsWith('offer-'))
          .map(line => line.match(/^offer-(\S+) \S+ attempt=(\d+)/)!.slice(1)),
      ).toEqual([
        ['chosen', '1'],
        ['entered', '1'],
        ['chosen', '2'],
        ['entered', '2'],
      ]);
    }
    expect(replay.reverseStep().state).toBe('paused');
    replay.clearBreakpoints();
    expect(replay.resume().state).toBe('ended');
    expect(replay.trace).toEqual(trace);
    if (name === 'aborted' || name === 'choice-cleanup') {
      expect(
        trace.filter(line => line.startsWith('offer-chosen ')),
      ).toHaveLength(1);
      expect(
        trace.filter(line => line.startsWith('offer-entered ')),
      ).toHaveLength(0);
    }
  });
}
