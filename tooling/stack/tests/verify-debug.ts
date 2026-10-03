import { compileSource, newGroup, num } from '@odgn/northtalk';
import { LiveDebugger, ReplayDebugger, renderDebugView } from '../src/debug';

/** The same live-debugging checks run in Bun, Node and browser environments. */
export const verifyDebugFeatures = (): number => {
  const source = 'script variable n = 0\non go\n put 1 into n\n return n\nend';
  const run = (debugging: boolean) => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const script = group.load({ name: 's', source });
    const debug = new LiveDebugger(group, { now: () => 0n });
    debug.registerSource(compileSource(source, { name: 's' }).unit!, 's');
    if (debugging) {
      debug.setBreakpoints([{ unit: 's', line: 3 }]);
    }
    script.deliver({ name: 'go' });
    let result = debug.pump(0n, { fuelSlice: 10 });
    if (debugging) {
      if (result.state !== 'paused' || debug.current?.line !== 3) {
        throw new Error('Source breakpoint failed');
      }
      const view = debug.snapshot();
      if (
        !view.scripts[0]!.vars[0]![1].equals(num(0)) ||
        !renderDebugView(view, 'runs')[0]?.includes('segment 1 fuel')
      ) {
        throw new Error('Paused inspection failed');
      }
      result = debug.stepOver();
      if (result.state !== 'paused' || result.pause.line !== 4) {
        throw new Error('Statement step failed');
      }
      result = debug.resume();
    }
    while (result.state === 'sliced') {
      result = debug.pump(0n, { fuelSlice: 10 });
    }
    return trace;
  };
  if (JSON.stringify(run(false)) !== JSON.stringify(run(true))) {
    throw new Error('Live debugging changed the Trace');
  }
  const recorded = run(false);
  const replay = new ReplayDebugger(
    { scripts: [{ name: 's', source: '', text: source }] },
    recorded,
  );
  replay.setBreakpoints([{ unit: 's', line: 3 }]);
  if (
    replay.resume().state !== 'paused' ||
    Number(replay.current?.line) !== 3
  ) {
    throw new Error('Replay breakpoint failed');
  }
  replay.clearBreakpoints();
  if (
    replay.stepOver().state !== 'paused' ||
    Number(replay.current?.line) !== 4
  ) {
    throw new Error('Replay step failed');
  }
  if (
    replay.reverseStep().state !== 'paused' ||
    Number(replay.current?.line) !== 3
  ) {
    throw new Error('Reverse step failed');
  }
  if (
    replay.resume().state !== 'ended' ||
    JSON.stringify(replay.trace) !== JSON.stringify(recorded)
  ) {
    throw new Error('Replay Trace parity failed');
  }
  if (replay.runToHostInput(0).state !== 'input' || replay.trace.length) {
    throw new Error('Host Input seek failed');
  }
  return 9;
};
