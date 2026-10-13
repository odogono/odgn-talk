import { describe, expect, test } from 'bun:test';
import {
  checkSource,
  newGroup,
  nothing,
  num,
  compileSource,
  disassemble,
  parseSource,
} from '../src/index';
import { deliver, loadScript } from '../src/machine';
import { parse } from '../../../tools/grammar/parser';
import { compileSource as referenceCompile } from '../../../tools/machine/compile';

const source = (expression: string) => `on go\nreturn ${expression}\nend go`;
const compile = (text: string) => {
  const result = compileSource(text, { name: 'test' });
  if (!result.unit) {
    throw new Error(
      result.error?.message ?? JSON.stringify(result.diagnostics),
    );
  }
  return result.unit;
};
const run = (text: string, fuelPerRun?: number) => {
  const script = loadScript(compile(text));
  const execution = deliver(
    script,
    'go',
    [],
    fuelPerRun === undefined ? {} : { fuelPerRun },
  );
  const outcome = execution.finish();
  return { outcome, fuel: execution.fuel, execution };
};
const value = (expression: string) => {
  const { outcome } = run(source(expression));
  if (outcome.kind !== 'completed') {
    throw new Error(JSON.stringify(outcome));
  }
  return outcome.result.toString();
};

describe('Nothing defaults and optional map-key reads', () => {
  test.each([
    ['nothing', '9'],
    ['false', 'false'],
    ['0', '0'],
    ['""', '""'],
    ['[]', '[]'],
    ['{}', '{}'],
  ])('only Nothing defaults: %s', (left, expected) => {
    expect(value(`${left} otherwise 9`)).toBe(expected);
  });

  test('lazy evaluation and left-associated Fuel', () => {
    expect(value('1 otherwise (1 / 0)')).toBe('1');
    expect(value('nothing otherwise nothing')).toBe('nothing');
    const baseline = run(source('1')).fuel - 1;
    for (const [expression, fuel] of [
      ['1 otherwise 2', 2],
      ['nothing otherwise 2', 4],
      ['1 otherwise 2 otherwise 3', 3],
      ['nothing otherwise nothing otherwise 3', 7],
    ] as const) {
      expect(run(source(expression)).fuel - baseline).toBe(fuel);
    }
  });

  test.each([
    ['the optional city of {city: "London"}', '"London"'],
    ['the optional city of {}', 'nothing'],
    ['the optional city of {city: nothing}', 'nothing'],
    ['the optional city of nothing', 'nothing'],
    [
      'the optional city of the optional address of {} otherwise "unknown"',
      '"unknown"',
    ],
    ['the optional length of {length: 4}', '4'],
    ['the optional target of {target: 4}', '4'],
    ['the optional first of {first: 4}', '4'],
    ['the optional code points of {"code points": 4}', '4'],
    ['the optional optional of {optional: 4}', '4'],
    ['the optional "of" of {"of": 4}', '4'],
    ['the optional ("city") of {city: 4}', '4'],
    ['the optional of {optional: 4}', '4'],
    ['the length of [1, 2]', '2'],
  ])('map-only key behavior: %s', (expression, expected) => {
    expect(value(expression)).toBe(expected);
    expect(parse(source(expression)).error).toBeNull();
    expect(() =>
      referenceCompile('test', 'script', source(expression)),
    ).not.toThrow();
  });

  test('precedence, boundaries, continuation and contextual names', () => {
    expect(value('nothing otherwise false or true')).toBe('true');
    expect(value('1 + 2 otherwise 0')).toBe('3');
    expect(value('(nothing otherwise 4) > 3')).toBe('true');
    expect(value('nothing otherwise -- fallback\n 4')).toBe('4');
    expect(
      value(
        'the first item of [{active: nothing}] whose active otherwise false',
      ),
    ).toBe('nothing');
    expect(value('(the first item of [] whose true) otherwise 4')).toBe('4');
    const text = 'constant otherwise = 4\non go\nreturn otherwise\nend go';
    expect(run(text).outcome.kind).toBe('completed');
    expect(parseSource(source('nothing otherwise')).error).not.toBeNull();
    expect(
      parseSource(source('replace "a" in nothing otherwise "a" with "b"'))
        .error,
    ).not.toBeNull();
    expect(
      parseSource(source('replace "a" in (nothing otherwise "a") with "b"'))
        .error,
    ).toBeNull();
  });

  test('computed keys validate after operands, with read positions and no path', () => {
    for (const [expression, expected] of [
      ['the optional (1) of nothing', 'text'],
      ['the optional x of 1', 'map'],
      ['the optional x of []', 'map'],
      ['the optional x of "x"', 'map'],
    ]) {
      const { outcome } = run(source(expression!));
      expect(outcome.kind).toBe('errored');
      if (outcome.kind !== 'errored') {
        continue;
      }
      expect(outcome.error.get('expected').toString()).toBe(`"${expected}"`);
      expect(outcome.error.get('at').get('column').toString()).toBe('8');
      expect(outcome.error.get('path').toString()).toBe('nothing');
    }
    const { outcome } = run(source('the optional (1) of (1 / 0)'));
    expect(outcome.kind).toBe('errored');
    if (outcome.kind === 'errored') {
      expect(outcome.error.get('code').toString()).not.toBe('"wrong kind"');
    }
    expect(run(source('the x of nothing')).outcome.kind).toBe('errored');
  });

  test('checks unselected operands and rejects all optional writes', () => {
    expect(
      checkSource(
        'function f\nreturn true\nend f\non go where true otherwise f()\nend go',
      ).ok,
    ).toBe(false);
    expect(checkSource('constant x = 1 otherwise unknown').ok).toBe(false);
    for (const statement of [
      'put 1 into the optional x of m',
      'set the optional x of m to 1',
      'add 1 to the optional x of m',
      'delete the optional x of m',
      'put 1 into the x of the optional y of m',
    ]) {
      const text = `on go m\n${statement}\nend go`;
      expect(parseSource(text).error?.code).toBe('not a container');
      expect(parse(text).error?.code).toBe('not a container');
    }
  });

  test('constants, initializers, parameter defaults and Guards use the same evaluation', () => {
    const text = `constant x = nothing otherwise 4
script variable y = the optional missing of {} otherwise x
function f a = nothing otherwise y
return a
end f
on go where the optional active of {} otherwise false
return 0
end go
on go
return f()
end go`;
    // Parameter defaults may reference Constants, but never Script Variables.
    expect(checkSource(text).ok).toBe(false);
    const out = run(text.replace('otherwise y', 'otherwise x')).outcome;
    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.result.toString()).toBe('4');
    }
  });

  test('instruction source positions and exact budget boundaries', () => {
    const unit = compile(
      source('nothing otherwise the optional ("x") of nothing'),
    );
    expect(
      unit.code
        .filter(i => ['branch-not-nothing', 'pop'].includes(i.op))
        .map(i => [i.line, i.col]),
    ).toEqual([
      [2, 16],
      [2, 16],
    ]);
    expect(unit.code.find(i => i.op === 'get-optional-key-computed')?.col).toBe(
      26,
    );
    expect(disassemble(unit)).toContain('get-optional-key-computed');
    const full = run(source('nothing otherwise 3'));
    for (let fuel = 0; fuel < full.fuel; fuel++) {
      expect(run(source('nothing otherwise 3'), fuel).outcome.kind).toBe(
        'limit fault',
      );
    }
  });
});

test('default and computed-key operands execute once in source order', () => {
  const text = `script variable log = ""
function key
put log & "k" into log
return "x"
end key
function receiver
put log & "r" into log
return nothing
end receiver
function fallback
put log & "f" into log
return 7
end fallback
on go
put the optional (key()) of receiver() otherwise fallback() into result
put result otherwise fallback() into again
return [result, again, log]
end go`;
  const outcome = run(text).outcome;
  expect(outcome.kind).toBe('completed');
  if (outcome.kind === 'completed') {
    expect(outcome.result.toString()).toBe('[7, 7, "krf"]');
  }
  expect(run(text.replace('return "x"', 'return 1')).outcome.kind).toBe(
    'errored',
  );
});

test('optional reads charge exactly three Fuel including errors', () => {
  const base = run(source('nothing')).fuel;
  expect(run(source('the optional x of nothing')).fuel - base).toBe(3);
  expect(run(source('the optional ("x") of nothing')).fuel - base).toBe(4);
  // Catching replaces the surrounding return on all paths, so only the
  // evaluated constants and the read distinguish these runs.
  const caught = (expression: string) =>
    run(
      `on go\ntry\nput ${expression} into x\ncatch e\nreturn 0\nend try\nend go`,
    );
  const literal = caught('the optional x of 1');
  const computed = caught('the optional (1) of nothing');
  expect(computed.fuel - literal.fuel).toBe(1);
  for (const expression of [
    'the optional x of nothing',
    'the optional (1) of nothing',
  ]) {
    const full = run(source(expression));
    for (let fuel = 0; fuel < full.fuel; fuel++) {
      expect(run(source(expression), fuel).outcome.kind).toBe('limit fault');
    }
  }
});

test('source compatibility excludes labels but retains names and grouped indexes', () => {
  for (const text of [
    'on move x otherwise y\nend move',
    'on go\nwait for move x otherwise y\nend go',
    'on go\npass move otherwise\nend go',
  ]) {
    expect(parseSource(text).error).not.toBeNull();
    expect(parse(text).error).not.toBeNull();
  }
  const text =
    'on go\nput 1 into otherwise\nreturn item (otherwise) of [8]\nend go';
  expect(run(text).outcome.kind).toBe('completed');
  expect(
    parseSource(text.replace('(otherwise)', 'otherwise')).error,
  ).not.toBeNull();
  const oldCall = compile(
    'on go a, b\nmove a otherwise b\nend go\non move x\nend move',
  );
  expect(oldCall.code.find(i => i.op === 'call-handler')?.operands).toContain(
    'move',
  );
  expect(oldCall.code.some(i => i.op === 'branch-not-nothing')).toBe(true);
  const oldSend = compile('on go a, b\nsend to me: move a otherwise b\nend go');
  expect(oldSend.code.find(i => i.op === 'send')?.operands).toEqual([
    'move',
    1,
  ]);
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const script = group.load({
    name: 's',
    source:
      'script variable result\non move a instead b\nput a otherwise b into result\nend move',
  });
  // Host producers use the renamed Selector; supply its two arguments.
  script.deliver({ name: 'move:instead:', args: [nothing, num(5)] });
  group.pump(0n);
  group.inspect();
  expect(lines.at(-1)).toBe('vars s result=5');
});

test('the staged source emits all new instructions and runs without shared expectations', async () => {
  const text = await Bun.file(
    new URL('./fixtures/nothing-defaults/main.talk', import.meta.url),
  ).text();
  const unit = compile(text);
  for (const op of [
    'branch-not-nothing',
    'get-optional-key',
    'get-optional-key-computed',
  ]) {
    expect(unit.code.some(i => i.op === op)).toBe(true);
  }
  expect(() => referenceCompile('test', 'script', text)).not.toThrow();
  const outcome = run(text).outcome;
  expect(outcome.kind).toBe('completed');
  if (outcome.kind === 'completed') {
    expect(outcome.result.toString()).toBe('[1, 3, [4, 9]]');
  }
});

const guarded = (expression: string) =>
  `on go where ${expression}\nreturn 1\nend go\non go\nreturn 2\nend go`;

test('Guards select true, skip nonbooleans and preserve all operand checks', () => {
  for (const [expression, expected] of [
    ['the optional active of {active: true} otherwise false', '1'],
    ['the optional active of {} otherwise false', '2'],
    ['the optional active of {active: 4} otherwise false', '2'],
    ['the optional active of 4 otherwise true', '2'],
  ]) {
    const outcome = run(guarded(expression!)).outcome;
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.result.toString()).toBe(expected!);
    }
  }
  const forbidden = 'function f\nreturn true\nend f\n';
  for (const expression of [
    'f() otherwise true',
    'true otherwise f()',
    'the optional (f()) of {}',
  ]) {
    expect(
      checkSource(forbidden + guarded(expression)).diagnostics.some(
        d => d.code === 'not in a guard',
      ),
    ).toBe(true);
  }
  expect(value('the optional if of {"if": 4}')).toBe('4');
  expect(run(source('the optional x of <<>>')).outcome.kind).toBe('errored');
});
