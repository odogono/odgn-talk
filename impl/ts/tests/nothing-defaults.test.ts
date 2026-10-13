import { describe, expect, test } from 'bun:test';
import {
  checkSource,
  compileSource,
  disassemble,
  parseSource,
  parseEntry,
  defineObjectKind,
  newGroup,
  parseInstant,
  text,
  list,
  compileLibrary,
} from '../src/index';
import { deliver, loadScript } from '../src/machine';
import { parse } from '../../../tools/grammar/parser';

const compile = (source: string) => {
  const compiled = compileSource(source, { name: 'test' });
  expect(compiled.error).toBeNull();
  expect(compiled.diagnostics).toEqual([]);
  return compiled.unit!;
};
const run = (expression: string, declarations = '') => {
  const script = loadScript(
    compile(`${declarations}\non go\nreturn ${expression}\nend go`),
  );
  const execution = deliver(script, 'go', []);
  const outcome = execution.finish();
  return { execution, outcome, script };
};
const value = (expression: string, declarations = '') => {
  const { outcome } = run(expression, declarations);
  if (outcome.kind !== 'completed') {
    throw new Error(JSON.stringify(outcome));
  }
  return outcome.result.toString();
};

describe('Nothing defaults', () => {
  test.each(['false', '0', '""', '[]', '{}', '1'])(
    '%s is present',
    expression => {
      expect(value(`${expression} otherwise (1 / 0)`)).toBe(expression);
    },
  );
  test.each([
    ['nothing otherwise 2', '2', 4],
    ['nothing otherwise nothing', 'nothing', 4],
    ['1 otherwise 2', '1', 2],
    ['1 otherwise 2 otherwise 3', '1', 3],
    ['nothing otherwise nothing otherwise 3', '3', 7],
  ])('%s preserves exact expression Fuel', (expression, expected, fuel) => {
    const { execution, outcome } = run(expression);
    expect(outcome.kind === 'completed' && outcome.result.toString()).toBe(
      expected,
    );
    // Clause dispatch and return together cost 6.
    expect(execution.fuel).toBe(fuel + 6);
  });
  test('evaluates selected operands once in source order', () => {
    const declarations = `script variable calls = []
function mark v
  put [...calls, v] into calls
  return v
end mark`;
    const { script, outcome } = run(
      'mark(nothing) otherwise mark(7) otherwise mark(8)',
      declarations,
    );
    expect(outcome.kind === 'completed' && outcome.result.toString()).toBe('7');
    expect(script.variables[0]!.toString()).toBe('[nothing, 7]');
    expect(run('(1 / 0) otherwise 4').outcome.kind).toBe('errored');
  });
  test.each([
    ['1 + 2 otherwise 9', '3'],
    ['false or true otherwise false', 'true'],
    ['nothing otherwise false or true', 'true'],
    ['nothing otherwise true and false', 'false'],
    ['(nothing otherwise 4) > 3', 'true'],
    ['nothing otherwise 1 < 2', 'true'],
    ['[nothing otherwise 1, 2 otherwise 3]', '[1, 2]'],
    [
      'the first item of [{active: nothing}, {active: true}] whose active otherwise false',
      '{active: true}',
    ],
    ['(the first item of [] whose true) otherwise 9', '9'],
  ])('precedence: %s', (expression, expected) =>
    expect(value(expression)).toBe(expected),
  );
  test('lambdas, constants, initializers and parameter defaults', () => {
    expect(
      value(
        'f()',
        `constant base = nothing otherwise 3
script variable initial = the optional absent of nothing otherwise base
function f x = (nothing otherwise 4)
return initial + x
end f`,
      ),
    ).toBe('7');
    expect(value('f(nothing)', 'constant f = given x: x otherwise 8')).toBe(
      '8',
    );
    const checked = checkSource('constant x = true otherwise absent()');
    expect(checked.diagnostics.length).toBeGreaterThan(0);
  });
  test('continuation depends on operator position', () => {
    expect(value('nothing otherwise -- comment\n  5')).toBe('5');
    const entry = parseEntry('nothing otherwise\n', () => false);
    expect(entry.error && entry.incomplete).toBe(true);
    expect(
      parseSource('on go otherwise\nreturn otherwise\nend go').error,
    ).toBeNull();
    expect(
      parseSource('on go\nput 1 into x\notherwise x\nend go').error,
    ).toBeNull();
  });
});

describe('optional map-key reads', () => {
  test.each([
    'length',
    'target',
    'first',
    'if',
    'optional',
    'code points',
    '"of"',
    '"city"',
    '("city")',
  ])('literal/computed key %s', key => {
    const literal =
      key === 'code points'
        ? '"code points"'
        : key === '("city")'
          ? 'city'
          : key;
    expect(value(`the optional ${key} of {${literal}: 7}`)).toBe('7');
    expect(value(`the optional ${key} of nothing`)).toBe('nothing');
    expect(value(`the optional ${key} of {}`)).toBe('nothing');
  });
  test('ordinary reads and every nullable step remain distinct', () => {
    expect(value('the optional of {optional: 7}')).toBe('7');
    expect(value('the length of [1, 2]')).toBe('2');
    expect(
      value('the optional b of the optional a of nothing otherwise 9'),
    ).toBe('9');
    expect(run('the optional b of the a of nothing').outcome.kind).toBe(
      'errored',
    );
    expect(run('the optional b of the optional a of {a: 1}').outcome.kind).toBe(
      'errored',
    );
    expect(
      value('the optional city of {city: nothing} otherwise "unknown"'),
    ).toBe('"unknown"');
  });
  test('computed keys run before receivers and validate after both', () => {
    const declarations = `script variable calls = []
function mark v
put [...calls, v] into calls
return v
end mark`;
    const { script, outcome } = run(
      'the optional (mark("x")) of mark(nothing)',
      declarations,
    );
    expect(outcome.kind).toBe('completed');
    expect(script.variables[0]!.toString()).toBe('["x", nothing]');
    const receiverError = run('the optional (1) of (1 / 0)').outcome;
    expect(
      receiverError.kind === 'errored' &&
        receiverError.error.get('code').toString(),
    ).toBe('"division by zero"');
  });
  test.each([
    ['the optional (1) of nothing', 'text', '1'],
    ['the optional x of 1', 'map', '1'],
    ['the optional x of []', 'map', '[]'],
    ['the optional x of "a"', 'map', '"a"'],
    ['the optional x of <<0x00>>', 'map', '<<0x00>>'],
  ])(
    'errors retain value and read position: %s',
    (expression, expected, bad) => {
      const { outcome } = run(expression);
      expect(outcome.kind).toBe('errored');
      if (outcome.kind !== 'errored') {
        return;
      }
      expect(outcome.error.get('code').toString()).toBe('"wrong kind"');
      expect(outcome.error.get('expected').toString()).toBe(
        JSON.stringify(expected),
      );
      expect(outcome.error.get('value').toString()).toBe(bad);
      expect(outcome.error.hasKey('path')).toBe(false);
      expect(outcome.error.get('at').get('column').toString()).toBe('8');
    },
  );
  test.each([
    'put 1 into',
    'set',
    'add 1 to',
    'subtract 1 from',
    'multiply',
    'divide',
    'delete',
  ])('rejects Container: %s', prefix => {
    const suffix =
      prefix === 'set'
        ? ' to 1'
        : ['multiply', 'divide'].includes(prefix)
          ? ' by 1'
          : '';
    const source = `on go m\n${prefix} the optional x of m${suffix}\nend go`;
    expect(parseSource(source).error?.code).toBe('not a container');
    expect(parse(source).error?.code).toBe('not a container');
  });
  test('Guards check all operands and skip runtime errors', () => {
    expect(
      checkSource(
        'function f\nreturn true\nend f\non go where true otherwise f()\nend go',
      ).diagnostics.map(d => d.code),
    ).toContain('not in a guard');
    const source = `on go m where the optional active of m otherwise false
return 1
end go
on go m
return 2
end go`;
    const script = loadScript(compile(source));
    const execution = deliver(script, 'go', [list()]);
    expect(execution.finish().kind).toBe('completed');
    expect(
      execution.records.some(
        r => r.kind === 'guard-skip' && r.code === 'wrong kind',
      ),
    ).toBe(true);
    expect(
      checkSource('on go where the optional title of obj\nend go', {
        objects: ['obj'],
      }).diagnostics,
    ).toEqual([]);
  });
  test('Disassembly preserves all three instructions and operator positions', () => {
    const unit = compile(
      'on go m\nreturn the optional x of m otherwise the optional ("y") of m\nend go',
    );
    const output = disassemble(unit);
    expect(output).toContain('2:8 get-optional-key "x"');
    expect(output).toContain('2:28 branch-not-nothing');
    expect(output).toContain('2:28 pop');
    expect(output).toContain('2:38 get-optional-key-computed');
  });
  test.each([false, true])(
    'rejects Host Objects without getters, disposed=%s',
    async disposed => {
      let calls = 0;
      const group = newGroup({ name: 'g' });
      const object = group.object(
        defineObjectKind({
          name: 'item',
          props: {
            title: {
              get: () => {
                calls++;
                return text('hello');
              },
            },
          },
        }),
        'a',
        null,
      );
      const script = group.load({
        name: 's',
        objects: { obj: object },
        source: `on go x
try
return the optional title of x
catch e
return e
end try
end go
on goId x
try
return the optional id of x
catch e
return e
end try
end goId
on known
try
return the optional id of obj
catch e
return e
end try
end known
on knownTitle
try
return the optional title of obj
catch e
return e
end try
end knownTitle
on stored
return the optional x of {x: obj}
end stored`,
      });
      const now = parseInstant('2026-10-13T00:00:00Z');
      if (disposed) {
        group.dispose(object);
        group.pump(now);
      }
      for (const message of [
        { name: 'go', args: [object.value] },
        { name: 'goId', args: [object.value] },
        { name: 'known' },
        { name: 'knownTitle' },
      ]) {
        const request = script.request(message);
        const result = request.result;
        group.pump(now);
        const error = await result;
        expect(error.get('code').toString()).toBe('"wrong kind"');
        expect(error.get('expected').toString()).toBe('"map"');
      }
      expect(calls).toBe(0);
      const stored = script.request({ name: 'stored' });
      group.pump(now);
      expect(await stored.result).toBe(object.value);
    },
  );
});

test.each([
  ['1 otherwise 2', 5, 10],
  ['nothing otherwise 2', 6, 16],
  ['the optional x of nothing', 7, 8],
  ['the optional ("x") of nothing', 8, 8],
])(
  'Fuel exhaustion before branch/pop/read: %s',
  (expression, budget, column) => {
    const script = loadScript(compile(`on go\nreturn ${expression}\nend go`));
    const execution = deliver(script, 'go', [], { fuelPerRun: budget });
    expect(execution.finish()).toMatchObject({
      kind: 'limit fault',
      limit: 'fuelPerRun',
      line: 2,
      col: column,
    });
  },
);

test('optional instructions charge 3 even for invalid receivers and keys', () => {
  for (const [expression, paid] of [
    ['the optional x of nothing', 10],
    ['the optional x of 1', 12],
    ['the optional (1) of nothing', 13],
  ] as const) {
    expect(run(expression).execution.fuel).toBe(paid);
  }
});

test.each(['the optional x of 1', 'the optional (1 / 0) of nothing'])(
  'stdlib-style attribution retains entering call: %s',
  async expression => {
    const library = compileLibrary(
      {
        name: 'helper',
        version: '1',
        source: `function read\nreturn ${expression}\nend read`,
      },
      [],
      {},
      { atCaller: true },
    );
    const group = newGroup({ name: 'g' });
    group.addLibrary(library);
    const script = group.load({
      name: 's',
      source:
        'use read from helper\non go\ntry\nreturn read()\ncatch e\nreturn e\nend try\nend go',
    });
    const request = script.request({ name: 'go' });
    group.pump(parseInstant('2026-10-13T00:00:00Z'));
    const error = await request.result;
    expect(error.get('at').toString()).toBe(
      '{unit: "s", handler: "go", line: 4, column: 8}',
    );
  },
);

test('compatibility: labels reject, commands change Selector, grouped indexes survive', () => {
  for (const source of [
    'on choose x otherwise y\nend choose',
    'on go\nwait for choose x otherwise y\nend go',
    'on go\npass choose otherwise\nend go',
  ]) {
    expect(parseSource(source).error).not.toBeNull();
    expect(parse(source).error).not.toBeNull();
  }
  const output = disassemble(
    compile(
      'on choose x\nreturn x\nend choose\non go\nchoose nothing otherwise 4\nend go',
    ),
  );
  expect(output).toContain('call-handler choose 1');
  expect(output).not.toContain('choose:otherwise:');
  const sent = disassemble(
    compile(
      'on choose x\nreturn x\nend choose\non go\nsend to me: choose nothing otherwise 4\nend go',
    ),
  );
  expect(sent).toContain('send choose 1');
  expect(sent).not.toContain('choose:otherwise:');
  // A migrated label sits beside `otherwise` in the same message.
  const renamed = disassemble(
    compile(
      'on choose x fallback y\nreturn x otherwise y\nend choose\non go\nchoose nothing fallback 4\nsend to me: choose nothing fallback 4\nend go',
    ),
  );
  expect(renamed).toContain('call-handler choose:fallback: 2');
  expect(renamed).toContain('send choose:fallback: 2');
  expect(value('item (otherwise) of [7]', 'constant otherwise = 1')).toBe('7');
  expect(
    parseSource('on go xs, otherwise\nreturn item otherwise of xs\nend go')
      .error,
  ).not.toBeNull();
  expect(
    value('f(nothing, 3)', 'function f x, y\nreturn x otherwise y\nend f'),
  ).toBe('3');
});

test('staged Disassembly agrees with TS and reference lowering', async () => {
  const { readFileSync } = await import('node:fs');
  const { compileSource: referenceCompile } =
    await import('../../../tools/machine/compile');
  const source = readFileSync(
    new URL('../../testdata/nothing-defaults/main.talk', import.meta.url),
    'utf8',
  );
  const expected = readFileSync(
    new URL('../../testdata/nothing-defaults/main.dis', import.meta.url),
    'utf8',
  );
  const unit = compileSource(source, { name: 'main' }).unit!;
  expect(disassemble(unit)).toBe(expected);
  const reference = referenceCompile('main', 'script', source);
  expect(reference.code.map(i => ({ op: i.op, args: i.args }))).toEqual(
    unit.code.map(i => ({ op: i.op, args: i.operands })),
  );
  // The reference compiler's older stores and Guard branches have independent
  // source-map conventions; compare positions of this feature's instructions.
  const feature = new Set([
    'branch-not-nothing',
    'get-optional-key',
    'get-optional-key-computed',
  ]);
  expect(
    reference.code.filter(i => feature.has(i.op)).map(i => [i.line, i.col]),
  ).toEqual(unit.code.filter(i => feature.has(i.op)).map(i => [i.line, i.col]));
});

test('restricted replace slots require grouping and names remain legal', () => {
  const source =
    'on go\nreturn replace "a" in nothing otherwise "a" with "b"\nend go';
  expect(parseSource(source).error).not.toBeNull();
  expect(parse(source).error).not.toBeNull();
  // An ungrouped fallback after the replacement belongs to the whole replace.
  expect(value('replace "a" in "a" with "x" otherwise "b"')).toBe('"x"');
  expect(
    value(
      'replace "a" in (nothing otherwise "a") with (nothing otherwise "b")',
    ),
  ).toBe('"b"');
  expect(
    value('otherwise()', 'function otherwise\nreturn 7\nend otherwise'),
  ).toBe('7');
  expect(value('the optional otherwise of {otherwise: 8}')).toBe('8');
});

test('Guard fallback selection and forbidden calls are independent of reachability', () => {
  const source =
    'on go m where the optional active of m otherwise false\nreturn 1\nend go\non go m\nreturn 2\nend go';
  for (const [expression, expected] of [
    ['{}', '2'],
    ['{active: true}', '1'],
    ['nothing', '2'],
  ]) {
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source: `${source}\non check\nreturn go(${expression})\nend check`,
    });
    script.deliver({ name: 'check' });
    const report = group.pump(parseInstant('2026-10-13T00:00:00Z'));
    expect(
      report.reports.some(r => 'result' in r && String(r.result) === expected),
    ).toBe(true);
  }
  for (const guard of ['f() otherwise true', 'true otherwise f()']) {
    expect(
      checkSource(
        `function f\nreturn true\nend f\non go where ${guard}\nend go`,
      ).diagnostics.map(d => d.code),
    ).toContain('not in a guard');
  }
});

test.each([
  ['return 1 otherwise', 3, 1],
  ['return otherwise 1', 2, 18],
  ['return the optional of', 2, 23],
])(
  'missing operands report the same position in both parsers: %s',
  (line, l, c) => {
    const source = `on go\n${line}\nend go`;
    for (const error of [parseSource(source).error, parse(source).error]) {
      expect(error).toMatchObject({ tok: { line: l, col: c } });
    }
  },
);

test('Whose conditions reject calls on either side of otherwise', () => {
  const diagnostics = checkSource(
    'function f\nreturn true\nend f\non go xs\nreturn the first item of xs whose f() otherwise true\nend go',
  ).diagnostics;
  expect(diagnostics).toMatchObject([
    { code: 'not in a whose', span: { line: 5, col: 35 } },
  ]);
});
