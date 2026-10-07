import { compileLibrary, newGroup } from '@odgn/northtalk';
import { LiveDebugger, ReplayDebugger } from '../src/debug';

export const recoveryLibrary = `function fail
 try
  throw "original"
 finally
  put 9 into scratch
 end try
end fail
function work
 put 4 into accumulated
 try
  put fail() into ignored
 offer useValue value
  add value to accumulated
 end try
 return accumulated
end work`;
export const recoveryScript = `use work from rows
function policyValue
 return 3
end policyValue
on go
 put 1 into policy
 try
  put work() into answer
 catch "original" before unwind
  add 1 to policy
  choose offer useValue(policyValue())
 end try
 return [answer, policy]
end go`;

/** Recovery stepping and frame ownership under Bun, Node and the browser. */
export const verifyRecoveryDebugFeatures = (): number => {
  const record = (mode?: 'over' | 'out') => {
    const trace: string[] = [];
    const group = newGroup({ name: 'case', trace: line => trace.push(line) });
    const rows = compileLibrary({
      name: 'rows',
      source: recoveryLibrary,
      version: '1',
    });
    group.addLibrary(rows);
    const script = group.load({
      name: 's',
      source: recoveryScript,
    });
    const debug = new LiveDebugger(group, { now: () => 0n });
    for (const source of group.debug().sources()) {
      debug.registerSource(source.unit, source.script);
    }
    if (mode) {
      debug.setBreakpoints([
        mode === 'over' ? { unit: 's', line: 8 } : { unit: 'rows', line: 3 },
      ]);
    }
    script.deliver({ name: 'go' });
    debug.pump();
    if (mode) {
      if (
        debug
          .snapshot()
          .scripts[0]!.runs[0]!.frames.some(
            f => f.role || f.owner !== undefined,
          )
      ) {
        throw new Error('Ordinary frames unexpectedly gained dispatch fields');
      }
      debug.clearBreakpoints();
      if (mode === 'over') {
        debug.stepOver();
      } else {
        debug.stepOut();
      }
      if (debug.current?.unit !== 's' || debug.current.line !== 10) {
        throw new Error('Step over failed call did not enter active policy');
      }
      debug.stepOver();
      if (Number(debug.current?.line) !== 11) {
        throw new Error('Step over skipped a recovery statement');
      }
      const frames = debug.snapshot().scripts[0]!.runs[0]!.frames;
      const dispatch = frames.at(-1)!;
      const owner = frames[dispatch.owner!]!;
      if (
        dispatch.role !== 'dispatch' ||
        owner.role !== 'retained' ||
        !frames.some(f => f.unit === 'rows' && f.role === 'retained') ||
        dispatch.locals.find(([name]) => name === 'policy')?.[1].toString() !==
          '2' ||
        JSON.stringify(dispatch.locals) !== JSON.stringify(owner.locals)
      ) {
        throw new Error(
          'Dispatch frame does not expose its shared owner locals',
        );
      }
      debug.step();
      if (Number(debug.current?.line) !== 3) {
        throw new Error('Step into policy helper failed');
      }
      debug.stepOut();
      if (Number(debug.current?.line) !== 13) {
        throw new Error('Step out did not follow active caller depth');
      }
      debug.resume();
    }
    return trace;
  };
  const trace = record();
  for (const mode of ['over', 'out'] as const) {
    if (JSON.stringify(record(mode)) !== JSON.stringify(trace)) {
      throw new Error('Recovery debugging changed Trace or costs');
    }
  }
  const replay = new ReplayDebugger(
    {
      libraries: [
        { name: 'rows', source: '', text: recoveryLibrary, version: '1' },
      ],
      scripts: [{ name: 's', source: '', text: recoveryScript }],
    },
    trace,
  );
  replay.setBreakpoints([{ unit: 's', line: 8 }]);
  replay.resume();
  replay.clearBreakpoints();
  replay.stepOver();
  if (replay.current?.unit !== 's' || replay.current.line !== 10) {
    throw new Error('Replay did not follow active policy');
  }
  replay.stepOver();
  replay.reverseStep();
  if (Number(replay.current?.line) !== 10) {
    throw new Error(
      'Reverse replay did not reach the preceding policy statement',
    );
  }
  if (
    replay.resume().state !== 'ended' ||
    JSON.stringify(replay.trace) !== JSON.stringify(trace)
  ) {
    throw new Error('Recovery replay changed Trace or costs');
  }
  return 12;
};
