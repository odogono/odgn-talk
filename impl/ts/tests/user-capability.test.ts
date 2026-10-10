import { expect, test } from 'bun:test';
import {
  bool,
  HostError,
  LoadError,
  list,
  newGroup,
  nothing,
  parseInstant,
  restore,
  ScriptError,
  text,
  userCapability,
  type Call,
  type UserImpl,
  type Value,
} from '../src/index';

const now = parseInstant('2026-10-02T12:00:00Z');
const costs = {
  confirm: { fuel: 3 },
  choose: { fuel: 5 },
  enter: { fuel: 7 },
  notify: { fuel: 2 },
};
const noUser: UserImpl = {
  confirm: () => {},
  choose: () => {},
  enter: () => {},
  notify: () => {},
};

// A Host that keeps each prompt's Call and what it was shown.
const recording = () => {
  const calls: Call<unknown>[] = [];
  const shown: unknown[][] = [];
  const impl: UserImpl = {
    confirm: (call, message) => {
      calls.push(call);
      shown.push(['confirm', message]);
    },
    choose: (call, items, prompt, multiple) => {
      calls.push(call);
      shown.push(['choose', items, prompt, multiple]);
    },
    enter: (call, message, fallback) => {
      calls.push(call);
      shown.push(['enter', message, fallback]);
    },
    notify: (_call, message, title) => {
      shown.push(['notify', message, title]);
    },
  };
  return { calls, impl, shown };
};

// Runs `body` as a Handler that keeps `it`, or the caught error's code, in
// `seen`, and returns the Group and Script.
const run = (impl: UserImpl, body: string) => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: `script variable seen = "pending"\non go\n  try\n    ${body}\n    put it into seen\n  catch {code: code}\n    put code into seen\n  end\nend`,
    grants: { user: userCapability(impl, costs).grant('all', undefined) },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  return g;
};
const seen = (g: ReturnType<typeof newGroup>): Value =>
  new Map(g.inspect().scripts.find(s => s.name === 's')!.vars).get('seen')!;

test('user validates its Host methods and needs every Operation cost', () => {
  for (const name of ['confirm', 'choose', 'enter', 'notify'] as const) {
    const { [name]: _, ...rest } = costs;
    expect(() => userCapability(noUser, rest)).toThrow(HostError);
    const { [name]: __, ...partial } = noUser;
    expect(() => userCapability(partial as unknown as UserImpl, costs)).toThrow(
      HostError,
    );
  }
  const user = userCapability(noUser, costs);
  expect([...user.operations.keys()].sort()).toEqual([
    'choose',
    'confirm',
    'enter',
    'notify',
  ]);
  for (const name of ['confirm', 'choose', 'enter']) {
    const op = user.operations.get(name)!;
    expect(op.mode).toBe('suspending');
    expect(op.mode === 'suspending' && op.maxPendingMs).toBe(2_147_483_647);
    expect(op.errors).toEqual([{ code: 'user busy', fields: {} }]);
  }
  expect(user.operations.get('notify')!.mode).toBe('fire-and-forget');
});

test('user calls are checked against the fixed modes and arities at load', () => {
  const g = newGroup({ name: 'g' });
  const grants = {
    user: userCapability(noUser, costs).grant('all', undefined),
  };
  for (const [body, code] of [
    ['ask user to confirm "x"', 'wrong mode'],
    ['tell user to confirm "x"', 'wrong mode'],
    ['ask user to notify "x" and wait', 'wrong mode'],
    ['ask user to choose and wait', 'wrong argument count'],
    ['ask user to enter "x", {}, 1 and wait', 'wrong argument count'],
    ['ask user to enter "x", {colour: "red"} and wait', 'wrong argument'],
  ]) {
    try {
      g.load({ name: 's', source: `on go\n  ${body}\nend`, grants });
      throw new Error(`loaded ${body}`);
    } catch (error) {
      expect(error).toBeInstanceOf(LoadError);
      expect((error as LoadError).diagnostics.map(d => d.code)).toContain(
        code!,
      );
    }
  }
});

test('confirm, choose and enter pass their arguments and options to the Host', () => {
  const { calls, impl, shown } = recording();
  run(impl, 'ask user to confirm "Delete?" and wait');
  run(impl, 'ask user to choose ["S", "M"] and wait');
  run(
    impl,
    'ask user to choose ["S", "M"], {prompt: "Size", multiple: true} and wait',
  );
  run(impl, 'ask user to choose ["S"], {prompt: nothing} and wait');
  run(impl, 'ask user to enter "Name?" and wait');
  run(impl, 'ask user to enter "Name?", {default: "Ann"} and wait');
  run(impl, 'tell user to notify "Done", {title: "Backup"}');
  run(impl, 'tell user to notify "Done"');
  expect(shown).toEqual([
    ['confirm', 'Delete?'],
    ['choose', ['S', 'M'], '', false],
    ['choose', ['S', 'M'], 'Size', true],
    ['choose', ['S'], '', false],
    ['enter', 'Name?', ''],
    ['enter', 'Name?', 'Ann'],
    ['notify', 'Done', 'Backup'],
    ['notify', 'Done', ''],
  ]);
  expect(calls.every(c => c.scriptName === 's')).toBe(true);
});

test('answers resume the Run, and a cancel is false or Nothing', () => {
  for (const [body, answer, expected] of [
    ['ask user to confirm "x" and wait', bool(true), 'true'],
    ['ask user to confirm "x" and wait', bool(false), 'false'],
    ['ask user to choose ["S", "M"] and wait', text('M'), '"M"'],
    ['ask user to choose ["S", "M"] and wait', nothing, 'nothing'],
    [
      'ask user to choose ["S", "M", "L"], {multiple: true} and wait',
      list(text('S'), text('L')),
      '["S", "L"]',
    ],
    ['ask user to choose ["S", "M"], {multiple: true} and wait', list(), '[]'],
    ['ask user to enter "x" and wait', text('Ann'), '"Ann"'],
    ['ask user to enter "x" and wait', nothing, 'nothing'],
  ] as const) {
    const { calls, impl } = recording();
    const g = run(impl, body);
    calls[0]!.answer(answer);
    g.pump(now + 1n);
    expect(seen(g).toString()).toBe(expected);
  }
});

test('a choose answer that is not an item, or not a subsequence, is a host error', () => {
  for (const [options, answer] of [
    ['', text('X')],
    ['', list(text('S'))],
    [', {multiple: true}', text('S')],
    [', {multiple: true}', list(text('M'), text('S'))],
    [', {multiple: true}', list(text('S'), text('S'))],
    ['', bool(true)],
  ] as const) {
    const { calls, impl } = recording();
    const g = run(impl, `ask user to choose ["S", "M"]${options} and wait`);
    calls[0]!.answer(answer);
    g.pump(now + 1n);
    expect(seen(g).asText()).toBe('host error');
  }
  const { calls, impl } = recording();
  const g = run(
    impl,
    'ask user to choose ["S", "S"], {multiple: true} and wait',
  );
  calls[0]!.answer(list(text('S'), text('S')));
  g.pump(now + 1n);
  expect(seen(g).toString()).toBe('["S", "S"]');
});

test('the Core refuses an empty choose and unknown options before the Host', () => {
  const { calls, impl } = recording();
  expect(seen(run(impl, 'ask user to choose [] and wait')).asText()).toBe(
    'out of domain',
  );
  expect(
    seen(
      run(
        impl,
        'put {colour: "red"} into o\n    ask user to enter "x", o and wait',
      ),
    ).asText(),
  ).toBe('wrong kind');
  expect(
    seen(
      run(
        impl,
        'put {multiple: "yes"} into o\n    ask user to choose ["S"], o and wait',
      ),
    ).asText(),
  ).toBe('wrong kind');
  expect(
    seen(
      run(impl, 'put [1] into xs\n    ask user to choose xs and wait'),
    ).asText(),
  ).toBe('wrong kind');
  expect(calls).toEqual([]);
});

test('a Host fails a second prompt with user busy', () => {
  const pending = new Set<string>();
  const impl: UserImpl = {
    ...noUser,
    confirm: call => {
      if (pending.has(call.scriptName)) {
        throw new ScriptError('user busy', 'Another prompt is waiting');
      }
      pending.add(call.scriptName);
    },
  };
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source:
      'script variable seen = []\non go\n  try\n    ask user to confirm "x" and wait\n  catch {code: code}\n    put code after seen\n  end\nend',
    grants: { user: userCapability(impl, costs).grant('all', undefined) },
  });
  s.deliver({ name: 'go' });
  s.deliver({ name: 'go' });
  g.pump(now);
  expect(seen(g).toString()).toBe('["user busy"]');
});

test('a pending choose keeps its answer rule across save and restore', () => {
  const { impl } = recording();
  const g = run(impl, 'ask user to choose ["S", "M"] and wait');
  const calls: Call<unknown>[] = [];
  const restored = restore(g.save(), {
    name: 'copy',
    libraries: [],
    grants: () =>
      userCapability(
        {
          ...noUser,
          choose: call => {
            calls.push(call);
          },
        },
        costs,
      ).grant('all', undefined),
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  restored.group.settle('s/r1.c1', { reissue: true });
  restored.group.pump(now + 1n);
  calls[0]!.answer(text('X'));
  restored.group.pump(now + 2n);
  expect(
    new Map(restored.group.inspect().scripts.find(s => s.name === 's')!.vars)
      .get('seen')!
      .asText(),
  ).toBe('host error');
});
