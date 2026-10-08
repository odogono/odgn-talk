import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import { functionValue } from '../src/values';
import {
  newGroup,
  restore,
  defineCapability,
  defineObjectKind,
  ScriptError,
  map,
  compileLibrary,
  shape,
  type Call,
  type LoadOptions,
  num,
  MailboxFull,
  readDisplay,
  parseInstant,
  type Group,
  type Value,
} from '../src/index';

// A Request or Call that rejects with `send failed`, giving the reason in its data.
const expectSendFailed = async (result: Promise<unknown>, reason: string) => {
  const error = await result.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(ScriptError);
  expect((error as ScriptError).code).toBe('send failed');
  expect((error as ScriptError).data.get('reason').asText()).toBe(reason);
};

const clock = parseInstant('2026-09-30T09:00:00Z');
const setup = (source: string, options: Partial<LoadOptions> = {}) => {
  const lines: string[] = [];
  const group = newGroup({
    name: 'functions',
    trace: line => lines.push(line),
  });
  const home = group.load({ ...options, name: 'home', source });
  home.deliver({ name: 'exported' });
  const reports = operationalReports(group.pump(clock).reports);
  const report = reports.find(r => r.kind === 'run end');
  if (!report || report.kind !== 'run end' || !report.result) {
    throw new Error('no exported Function Value');
  }
  return { group, home, fn: report.result, lines };
};
const named = `script variable total = 0
on exported
  return accumulate
end exported
function accumulate n = 5
  put total + n into total
  return total
end accumulate`;
const caller = (group: Group, fn: Value, suffix = ' and wait') => {
  const script = group.load({
    name: 'caller',
    source: `on go f\n  f(7)${suffix}\n  return it\nend go`,
  });
  return script.request({ name: 'go', args: [fn] });
};

describe('Function Value calls', () => {
  test('the Host calls a named function with defaults in its Home Script', async () => {
    const { group, fn, lines } = setup(named);
    const requested = group.call(fn, []);
    expect(lines.some(line => line.startsWith('> call-value '))).toBe(false);
    const reports = operationalReports(group.pump(clock).reports);
    expect((await requested.result).toString()).toBe('5');
    expect(reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        script: 'home',
        fn,
        outcome: 'completed',
        fuel: 11,
      }),
    );
    expect(lines).toContain(
      `> call-value ${requested.id} fn=<function home:accumulate>`,
    );
    expect(
      lines.some(
        line =>
          line.includes('fn=<function home:accumulate>') &&
          line.startsWith('seg '),
      ),
    ).toBe(true);
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('5');
  });

  test('a foreign call is a mailbox Run and replies to its suspended caller', async () => {
    const { group, fn, lines } = setup(named);
    const requested = caller(group, fn);
    const reports = operationalReports(group.pump(clock).reports);
    expect((await requested.result).toString()).toBe('7');
    expect(
      reports.filter(r => r.kind === 'run end').map(r => r.script),
    ).toEqual(['home', 'caller']);
    expect(lines).toContain(
      'send caller/r1.c1 to=home fn=<function home:accumulate> args=[7] wait=yes',
    );
    expect(lines.some(line => line.includes('end=call-value-wait'))).toBe(true);
  });

  test('a foreign call without and wait raises would suspend', async () => {
    const { group, fn } = setup(named);
    const requested = caller(group, fn, '');
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'errored');
    const report = reports.find(r => r.kind === 'run end');
    expect(report?.kind === 'run end' && report.error?.code).toBe(
      'would suspend',
    );
  });

  test('Group ownership is checked even when Scripts have the same name', () => {
    const a = setup(named);
    const b = setup(named);
    expect(() => b.group.call(a.fn, [])).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
  });

  test('a queued Host call checks staleness at drain, after reload', async () => {
    const { group, home, fn, lines } = setup(named);
    const requested = group.call(fn, [num(1)]);
    home.reload(named, 'carry variables');
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'function gone');
    expect(reports.filter(r => r.kind === 'run end')).toEqual([]);
    expect(lines).toContain(`note ${requested.id} kind=function-gone`);
  });

  test('a Lambda keeps its captures and may suspend in a Host call', async () => {
    const { group, fn } = setup(
      `on exported\n  put 3 into factor\n  return given n\n    wait 1 s\n    return n * factor\n  end given\nend exported`,
    );
    const requested = group.call(fn, [num(7)]);
    group.pump(clock);
    expect(group.inspect().scripts[0]!.runs[0]!.status).toBe('suspended');
    group.pump(clock + 1_000_000_000n);
    expect((await requested.result).toString()).toBe('21');
  });
});

const sleeping = `script variable done = 0
on exported
  return given n
    wait 1 s
    put n into done
    return n
  end given
end exported`;
const restoreOptions = (lines: string[]) => ({
  name: 'restored',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
  trace: (line: string) => lines.push(line),
});

describe('Function call lifecycle', () => {
  test('a foreign receiver spends its Home Script Grants', async () => {
    const calls: Call<number>[] = [];
    const cap = defineCapability<number>('stock', {
      get: {
        mode: 'immediate',
        result: shape.number,
        cost: { fuel: 3 },
        do: call => {
          calls.push(call);
          return num(call.binding);
        },
      },
    });
    const { group, fn } = setup(
      'on exported\n return given n\n  ask stock to get\n  return it\n end given\nend exported',
      {
        grants: { stock: cap.grant('all', 43) },
      },
    );
    const requested = caller(group, fn);
    group.pump(clock);
    expect((await requested.result).toString()).toBe('43');
    expect(calls.map(call => call.scriptName)).toEqual(['home']);
  });

  test('Host calls respect mailbox admission and limit overrides', async () => {
    const { group, fn } = setup(named, { limits: { mailboxDepth: 1 } });
    expect(() =>
      group.call(fn, [], { limits: { fuelPerRun: 10_000_001 } }),
    ).toThrow();
    const requested = group.call(fn, [], { limits: { fuelPerRun: 4 } });
    expect(() => group.call(fn, [])).toThrow(MailboxFull);
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'limit fault');
    expect(reports).toContainEqual(
      expect.objectContaining({ outcome: 'limit fault', fn, limit: 'fuel' }),
    );
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
  });

  test('foreign calls validate arity before sending', async () => {
    const { group, fn, lines } = setup(named);
    const script = group.load({
      name: 'caller',
      source: 'on go f\n f(1, 2) and wait\nend go',
    });
    const requested = script.request({ name: 'go', args: [fn] });
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'errored');
    expect(reports).toContainEqual(
      expect.objectContaining({ error: expect.anything(), script: 'caller' }),
    );
    expect(lines.some(line => line.startsWith('send '))).toBe(false);
    const report = reports.find(r => r.kind === 'run end');
    expect(report?.kind === 'run end' && report.error?.code).toBe(
      'wrong arity',
    );
  });

  test('Host arity errors do not enter the function body', async () => {
    const { group, fn } = setup(named);
    const requested = group.call(fn, [num(1), num(2)]);
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'errored');
    const report = reports.find(r => r.kind === 'run end');
    expect(report?.kind === 'run end' && report.error?.code).toBe(
      'wrong arity',
    );
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
  });

  test('foreign receiver errors reach the caller as send failed with the inner error', async () => {
    const { group, fn } = setup(
      'on exported\n return given n: 1 / 0\nend exported',
    );
    const requested = caller(group, fn);
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'errored');
    const report = reports.find(
      r => r.kind === 'run end' && r.script === 'caller',
    );
    expect(
      report?.kind === 'run end' && report.error?.data.get('reason').asText(),
    ).toBe('errored');
    expect(
      report?.kind === 'run end' &&
        report.error?.data.get('error').get('code').asText(),
    ).toBe('division by zero');
  });

  test('a foreign receiver faults on its own limits and rolls back its Segment', async () => {
    const { group, fn } = setup(named, { limits: { fuelPerRun: 10 } });
    const requested = caller(group, fn);
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'errored');
    expect(reports).toContainEqual(
      expect.objectContaining({ script: 'home', outcome: 'limit fault', fn }),
    );
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
  });

  test('cancelling a foreign caller abandons its wait and leaves the receiver live', async () => {
    const { group, fn, lines } = setup(sleeping);
    const requested = caller(group, fn);
    group.pump(clock);
    group.script('caller')!.cancelRun('caller/r1');
    group.pump(clock);
    await expectSendFailed(requested.result, 'cancelled');
    expect(lines).toContain('abandon caller/r1.c1');
    const reports = operationalReports(
      group.pump(clock + 1_000_000_000n).reports,
    );
    expect(reports).toContainEqual(
      expect.objectContaining({ script: 'home', outcome: 'completed' }),
    );
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('7');
  });

  test('a foreign timeout abandons only the caller wait', async () => {
    const { group, fn, lines } = setup(sleeping);
    const script = group.load({
      name: 'caller',
      limits: { maxWaitMs: 10 },
      source: 'on go f\n f(7) and wait\nend go',
    });
    const requested = script.request({ name: 'go', args: [fn] });
    group.pump(clock);
    const reports = operationalReports(group.pump(clock + 10_000_000n).reports);
    await expectSendFailed(requested.result, 'errored');
    const report = reports.find(r => r.kind === 'run end');
    expect(report?.kind === 'run end' && report.error?.code).toBe('timeout');
    expect(lines).toContain('abandon caller/r1.c1');
    group.pump(clock + 1_000_000_000n);
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('7');
  });

  test('an aborted Host call runs cancellation cleanup and rejects its future', async () => {
    const { group, fn, lines } = setup(
      'script variable cleaned = false\non exported\n return given n\n  try\n   wait 1 s\n  finally\n   put true into cleaned\n  end try\n end given\nend exported',
    );
    const controller = new AbortController();
    const requested = group.call(fn, [num(1)], { signal: controller.signal });
    group.pump(clock);
    controller.abort();
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'cancelled');
    expect(reports).toContainEqual(
      expect.objectContaining({ outcome: 'cancelled', fn }),
    );
    expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('true');
    expect(lines.some(line => line.startsWith('> cancel-delivery '))).toBe(
      true,
    );
  });

  test('a queued Host call cancelled before dispatch has no Run', async () => {
    const { group, fn, lines } = setup(named);
    const controller = new AbortController();
    const requested = group.call(fn, [], { signal: controller.signal });
    controller.abort();
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(requested.result, 'cancelled');
    expect(reports).toContainEqual(
      expect.objectContaining({ outcome: 'cancelled', fn, fuel: 0 }),
    );
    expect(lines).toContain(
      `run outcome=cancelled delivery=${requested.id} fn=${fn} fuel=0 alloc=0`,
    );
  });

  test('a stopped foreign receiver fails the caller', async () => {
    const { group, home, fn } = setup(sleeping);
    const requested = caller(group, fn);
    group.pump(clock);
    home.stop('finished');
    group.pump(clock);
    await expectSendFailed(requested.result, 'errored');
  });

  test('Function Value Runs are concurrent even with an existing queued Handler', async () => {
    const { group, fn } = setup(
      `${sleeping}\non hold, queued\n wait 10 s\nend hold`,
    );
    group.script('home')!.deliver({ name: 'hold' });
    const a = group.call(fn, [num(1)]);
    const b = group.call(fn, [num(2)]);
    group.pump(clock);
    expect(group.inspect().scripts[0]!.runs).toHaveLength(3);
    group.pump(clock + 1_000_000_000n);
    expect((await a.result).toString()).toBe('1');
    expect((await b.result).toString()).toBe('2');
  });

  test('a foreign wait and its receiver survive restore without Host settlement', () => {
    const { group, fn } = setup(sleeping);
    caller(group, fn);
    group.pump(clock);
    const restored = restore(group.save(), restoreOptions([]));
    expect(restored.result.pending).toEqual([]);
    const reports = operationalReports(
      restored.group.pump(clock + 1_000_000_000n).reports,
    );
    expect(
      reports
        .filter(r => r.kind === 'run end')
        .map(r => [r.script, r.result?.toString()]),
    ).toEqual([
      ['home', '7'],
      ['caller', '7'],
    ]);
  });

  test('restored Script-held functions belong to the new Group; old Host handles do not', async () => {
    const { group, fn } = setup(
      'script variable callback = given n: n + 1\non exported\n return callback\nend exported',
    );
    const restored = restore(group.save(), restoreOptions([]));
    expect(() => restored.group.call(fn, [num(1)])).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
    const newFn = restored.group.inspect().scripts[0]!.vars[0]![1];
    const requested = restored.group.call(newFn, [num(2)]);
    restored.group.pump(clock);
    expect((await requested.result).toString()).toBe('3');
  });

  test('Host calls execute Library Function Values in the right code unit', async () => {
    const library = compileLibrary({
      name: 'shelf',
      version: '1',
      source:
        'constant factor = 3\nfunction times n = 7\n return n * factor\nend times',
    });
    const group = newGroup({ name: 'libraries' });
    group.addLibrary(library);
    const home = group.load({
      name: 'home',
      source: 'use times from shelf\non exported\n return times\nend exported',
    });
    home.deliver({ name: 'exported' });
    const report = operationalReports(group.pump(clock).reports).find(
      r => r.kind === 'run end',
    );
    const fn = report?.kind === 'run end' ? report.result! : undefined!;
    const requested = group.call(fn, []);
    group.pump(clock);
    expect((await requested.result).toString()).toBe('21');
  });
});

test('Function display values are resolved against earlier Host-held handles', () => {
  const { fn } = setup(
    'on exported\n put ">" into mark\n return given n: [mark, n]\nend exported',
  );
  const display = `[${fn}, {nested: ${fn}}]`;
  expect(() => readDisplay(display)).toThrow();
  const decoded = readDisplay(display, undefined, text =>
    text === fn.toString() ? fn : undefined,
  );
  expect(decoded.index(1)).toBe(fn);
  expect(decoded.index(2).get('nested')).toBe(fn);
});

test('a Host arity failure is outside the function body and spends no execution Fuel', async () => {
  const { group, fn } = setup(
    'on exported\n return work\nend exported\nfunction work n\n try\n  return n\n catch problem\n  return 99\n end try\nend work',
  );
  const requested = group.call(fn, []);
  const reports = operationalReports(group.pump(clock).reports);
  await expectSendFailed(requested.result, 'errored');
  const report = reports.find(r => r.kind === 'run end');
  expect(report?.kind === 'run end' && report.error?.code).toBe('wrong arity');
  expect(report?.kind === 'run end' && report.fuel).toBe(0);
});

test('a full foreign mailbox refuses before assigning a call id', async () => {
  const lines: string[] = [];
  const group = newGroup({ name: 'full', trace: line => lines.push(line) });
  const script = group.load({
    name: 'caller',
    source:
      'on go f\n try\n  f(1) and wait\n catch "mailbox full"\n  wait 0 s\n end try\n f(7) and wait\n return it\nend go',
  });
  const home = group.load({
    name: 'home',
    limits: { mailboxDepth: 1 },
    source: `${named}\non ping\nend ping`,
  });
  home.deliver({ name: 'exported' });
  const report = operationalReports(group.pump(clock).reports).find(
    r => r.kind === 'run end',
  );
  const fn = report?.kind === 'run end' ? report.result! : undefined!;
  home.deliver({ name: 'ping' });
  const requested = script.request({ name: 'go', args: [fn] });
  group.pump(clock);
  group.pump(clock);
  expect((await requested.result).toString()).toBe('7');
  expect(lines.filter(line => line.startsWith('send '))).toEqual([
    'send caller/r1.c1 to=home fn=<function home:accumulate> args=[7] wait=yes',
  ]);
});

test('queued Function Values and their captures count toward mailbox Persistent State', async () => {
  const { group, home, fn } = setup(
    `on exported\n put "${'x'.repeat(100)}" into held\n return given: the length of held\nend exported\non ping\n return nothing\nend ping`,
    { limits: { persistentState: 64 } },
  );
  home.deliver({ name: 'ping' });
  const requested = group.call(fn, []);
  const reports = operationalReports(group.pump(clock).reports);
  expect(reports).toContainEqual(
    expect.objectContaining({
      outcome: 'limit fault',
      handler: 'ping',
      limit: 'persistent',
    }),
  );
  expect((await requested.result).toString()).toBe('100');
});

test("Host arguments cannot pass another Group's Function Value, including nested values", () => {
  const a = setup(named);
  const b = setup(named);
  expect(() =>
    b.group.call(b.fn, [readDisplay(`[${a.fn}]`, undefined, () => a.fn)]),
  ).toThrow(expect.objectContaining({ code: 'wrong group' }));
});

test('a Library Constant callback receives the importing Script as its Home Script', async () => {
  const library = compileLibrary({
    name: 'callbacks',
    version: '1',
    source: 'constant callback = given n: n + 1',
  });
  const group = newGroup({ name: 'callbacks' });
  group.addLibrary(library);
  const home = group.load({
    name: 'home',
    source:
      'use callback from callbacks\non exported\n return callback\nend exported',
  });
  home.deliver({ name: 'exported' });
  const report = operationalReports(group.pump(clock).reports).find(
    r => r.kind === 'run end',
  );
  const fn = report?.kind === 'run end' ? report.result! : undefined!;
  expect(fn.homeScript()).toBe('home');
  const requested = group.call(fn, [num(3)]);
  group.pump(clock);
  expect((await requested.result).toString()).toBe('4');
});

test('Library callback Constants and defaults remain separate in two importing Groups', async () => {
  const library = compileLibrary({
    name: 'callbacks2',
    version: '1',
    source:
      'constant callback = given n: n + 1\nconstant bundle = {work: callback}\nfunction invoke n, fn = callback\n return fn(n)\nend invoke',
  });
  const groups = ['one', 'two'].map(name => {
    const group = newGroup({ name });
    group.addLibrary(library);
    const home = group.load({
      name: 'home',
      source:
        'use bundle, invoke from callbacks2\non exported\n return bundle\nend exported\non go\n return invoke(4)\nend go',
    });
    home.deliver({ name: 'exported' });
    const report = operationalReports(group.pump(clock).reports).find(
      r => r.kind === 'run end',
    );
    const bundle = report?.kind === 'run end' ? report.result! : undefined!;
    return { group, home, fn: bundle.get('work') };
  });
  for (const { group, home, fn } of groups) {
    const callback = group.call(fn, [num(6)]);
    const invoke = home.request({ name: 'go' });
    group.pump(clock);
    expect((await callback.result).toString()).toBe('7');
    expect((await invoke.result).toString()).toBe('5');
  }
  expect(() => groups[0]!.group.call(groups[1]!.fn, [])).toThrow(
    expect.objectContaining({ code: 'wrong group' }),
  );
});

test('uncaught Function call errors expose fn and arguments through during', async () => {
  const { group, fn } = setup(
    'script variable failed\non exported\n return given n: 1 / 0\nend exported\non error problem, during context\n put context into failed\nend error',
  );
  const requested = group.call(fn, [num(4)]);
  group.pump(clock);
  await expectSendFailed(requested.result, 'errored');
  const failed = group.inspect().scripts[0]!.vars[0]![1];
  expect(failed.get('fn')).toBe(fn);
  expect(failed.get('args').toString()).toBe('[4]');
});

describe('Function ownership at Host boundaries', () => {
  test('broadcasts refuse foreign handles before assigning an id', () => {
    const a = setup(named);
    const b = setup(named);
    const message = { name: 'exported', args: [map([['callback', a.fn]])] };
    expect(() => b.group.broadcast(message)).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
    expect(() => b.group.decideBroadcast(message)).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
    expect(b.group.broadcast({ name: 'exported' })).toBe('b1');
  });

  test('ownership validation traverses local Function captures', () => {
    const a = setup(named);
    const b = setup(named);
    const hidden = functionValue({
      ...b.fn.asFunction()!,
      captures: [['callback', a.fn]],
    });
    expect(() => b.group.call(b.fn, [hidden])).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
  });

  for (const path of ['result', 'property', 'failure'] as const) {
    test(`a foreign callback in a Host ${path} becomes host error`, async () => {
      const a = setup(named);
      const cap = defineCapability('stock', {
        get: {
          mode: 'immediate',
          args: [],
          result: shape.value,
          cost: { fuel: 1 },
          errors: [{ code: 'unavailable' }],
          do: () => {
            if (path === 'failure') {
              throw new ScriptError(
                'unavailable',
                'Unavailable',
                map([['callback', a.fn]]),
              );
            }
            return map([['callback', a.fn]]);
          },
        },
      });
      const group = newGroup({ name: 'receiver' });
      const kind = defineObjectKind<null>({
        name: 'holder',
        props: { callback: { get: () => a.fn } },
      });
      const owner = group.object(kind, 'owner', null);
      const home = group.load({
        name: 'home',
        owner,
        grants: { stock: cap.grant('all', undefined) },
        source:
          path === 'property'
            ? 'on go\n return the callback of me\nend go'
            : 'on go\n ask stock to get\n return it\nend go',
      });
      const request = home.request({ name: 'go' });
      const reports = operationalReports(group.pump(clock).reports);
      await expectSendFailed(request.result, 'errored');
      const report = reports.find(r => r.kind === 'run end');
      expect(report?.kind === 'run end' && report.error?.code).toBe(
        'host error',
      );
    });
  }

  test('Call answers and failures reject foreign handles and leave the pending call usable', async () => {
    const a = setup(named);
    let pending: Call<void> | undefined;
    const cap = defineCapability('stock', {
      get: {
        mode: 'suspending',
        args: [],
        result: shape.value,
        cost: { fuel: 1 },
        errors: [{ code: 'unavailable' }],
        start: call => {
          pending = call;
        },
      },
    });
    const group = newGroup({ name: 'receiver' });
    const home = group.load({
      name: 'home',
      grants: { stock: cap.grant('all', undefined) },
      source: 'on go\n ask stock to get and wait\n return it\nend go',
    });
    const request = home.request({ name: 'go' });
    group.pump(clock);
    expect(() => pending!.answer(a.fn)).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
    expect(() =>
      pending!.fail(
        new ScriptError(
          'unavailable',
          'Unavailable',
          map([['callback', a.fn]]),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'wrong group' }));
    pending!.answer(num(9));
    group.pump(clock);
    expect((await request.result).toString()).toBe('9');
  });

  test('restored settlements reject foreign handles without consuming the pending call', () => {
    const a = setup(named);
    const cap = defineCapability('stock', {
      get: {
        mode: 'suspending',
        args: [],
        result: shape.value,
        cost: { fuel: 1 },
        errors: [{ code: 'unavailable' }],
        start: () => {},
      },
    });
    const grant = cap.grant('all', undefined);
    const group = newGroup({ name: 'receiver' });
    group
      .load({
        name: 'home',
        grants: { stock: grant },
        source: 'on go\n ask stock to get and wait\nend go',
      })
      .deliver({ name: 'go' });
    group.pump(clock);
    const restored = restore(group.save(), {
      ...restoreOptions([]),
      grants: () => grant,
    });
    const id = restored.result.pending[0]!.id;
    expect(() => restored.group.settle(id, { answer: a.fn })).toThrow(
      expect.objectContaining({ code: 'wrong group' }),
    );
    expect(() =>
      restored.group.settle(id, {
        fail: new ScriptError(
          'unavailable',
          'Unavailable',
          map([['callback', a.fn]]),
        ),
      }),
    ).toThrow(expect.objectContaining({ code: 'wrong group' }));
    restored.group.settle(id, { answer: num(9) });
    expect(
      operationalReports(restored.group.pump(clock).reports),
    ).toContainEqual(
      expect.objectContaining({ kind: 'run end', outcome: 'completed' }),
    );
  });
});

test('Host Call MaxWait overrides apply to foreign callbacks', async () => {
  const { group, fn } = setup(
    'on exported\n return given cb\n  cb(7) and wait\n  return it\n end given\nend exported',
  );
  const remote = group.load({ name: 'remote', source: sleeping });
  remote.deliver({ name: 'exported' });
  const report = operationalReports(group.pump(clock).reports).find(
    r => r.kind === 'run end',
  );
  const callback = report?.kind === 'run end' ? report.result! : undefined!;
  const request = group.call(fn, [callback], { limits: { maxWaitMs: 10 } });
  group.pump(clock);
  const reports = operationalReports(group.pump(clock + 10_000_000n).reports);
  expect(reports).toContainEqual(
    expect.objectContaining({
      kind: 'run end',
      script: 'home',
      error: expect.anything(),
    }),
  );
  await expectSendFailed(request.result, 'errored');
  expect(
    group.inspect().scripts.find(s => s.name === 'remote')!.runs[0]!.status,
  ).toBe('suspended');
});

for (const reissue of [false, true]) {
  for (const failure of [false, true]) {
    test(`automatic Capability ${failure ? 'failure' : 'answer'} rejects foreign callbacks as host error${reissue ? ' after reissue' : ''}`, async () => {
      const a = setup(named);
      const cap = defineCapability('stock', {
        get: {
          mode: 'suspending',
          args: [],
          result: shape.value,
          cost: { fuel: 1 },
          errors: [{ code: 'unavailable' }],
          run: () =>
            failure
              ? Promise.reject(
                  new ScriptError(
                    'unavailable',
                    'Unavailable',
                    map([['callback', a.fn]]),
                  ),
                )
              : Promise.resolve(a.fn),
        },
      });
      const grant = cap.grant('all', undefined);
      let group = newGroup({ name: 'receiver' });
      group
        .load({
          name: 'home',
          grants: { stock: grant },
          source: 'on go\n ask stock to get and wait\nend go',
        })
        .deliver({ name: 'go' });
      group.pump(clock);
      if (reissue) {
        const restored = restore(group.save(), {
          ...restoreOptions([]),
          grants: () => grant,
        });
        group = restored.group;
        group.settle(restored.result.pending[0]!.id, { reissue: true });
        group.pump(clock);
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      const reports = operationalReports(group.pump(clock).reports);
      const report = reports.find(r => r.kind === 'run end');
      expect(report?.kind === 'run end' && report.error?.code).toBe(
        'host error',
      );
      expect(group.inspect().scripts[0]!.runs).toHaveLength(0);
    });
  }
}
