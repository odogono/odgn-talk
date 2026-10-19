// The same callback Host runs under Bun, Node and a browser worker.
import {
  createCore,
  nothing,
  num,
  shape,
  ScriptError,
  type Value,
  type WasmSource,
} from '../src/wasm/index';

export const callbackScenario = async (
  wasm: WasmSource,
  binaryCallbacks: boolean,
) => {
  const core = await createCore({ wasm, binaryCallbacks });
  const events: string[] = [];
  const trace: string[] = [];
  const api = core.defineCapability(
    'api',
    {
      echo: {
        mode: 'immediate',
        args: [shape.value],
        result: shape.value,
        cost: { fuel: 1 },
        segmentBound: true,
        do: (call, value) => {
          events.push('echo');
          call.charge(2);
          return value!;
        },
      },
      fail: {
        mode: 'immediate',
        errors: [{ code: 'refused' }],
        cost: { fuel: 1 },
        do: () => {
          throw new ScriptError('refused', 'No');
        },
      },
    },
    {
      begin: () => {
        events.push('begin');
        return { status: 'ok' };
      },
      commit: () => {
        events.push('commit');
        return { status: 'ok' };
      },
      rollback: () => {
        events.push('rollback');
        return { status: 'ok' };
      },
    },
    c => {
      events.push(`release:${c.reason}`);
    },
  );
  const kind = core.defineObjectKind<{ value: Value }>({
    name: 'box',
    props: {
      value: {
        shape: shape.value,
        get: o => {
          events.push('get');
          return o.native.value;
        },
        set: (o, v) => {
          events.push(`set:${v}`);
          o.native.value = v;
        },
      },
    },
  });
  const group = core.newGroup({ name: 'g', trace: line => trace.push(line) });
  const box = group.object(kind, 'box', { value: num(1) });
  const script = group.load({
    name: 's',
    owner: box,
    grants: { api: api.grant('all', undefined) },
    source: [
      'on go',
      '  set the value of me to nothing',
      '  ask api to echo [the value of me, 0.00, <<0, 255>>, {"$x": true}]',
      '  return it',
      'end go',
      'on fail',
      '  try',
      '    ask api to fail',
      '  catch e',
      '    return the code of e',
      '  end try',
      'end fail',
    ].join('\n'),
  });
  const first = script.requestPump({ name: 'go' }, 1n);
  if (!first.admitted) {
    throw first.error;
  }
  if (!first.pump.ok) {
    throw first.pump.error;
  }
  const value = (await first.requested.result).toString();
  const failed = script.request({ name: 'fail' });
  group.pump(2n);
  const failure = (await failed.result).toString();
  // Stop queues release hooks for the next Pump.
  script.stop('done');
  group.pump(3n);
  return {
    value,
    failure,
    events,
    trace,
    setterNothing: box.native.value === nothing,
  };
};
