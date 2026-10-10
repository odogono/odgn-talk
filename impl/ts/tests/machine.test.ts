import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileSource } from '../src/lowering';
import {
  callFunction,
  deliver,
  UnitLoadError,
  loadScript,
  type Limits,
  type Outcome,
} from '../src/machine';
import { NotImplementedError } from '../src/operations';
import { readDisplay } from '../src/readers';
import { checkSource } from '../src/checker';
import {
  compile,
  matchSearch,
  runProgram,
  type RunKind,
} from '../src/patterns';
import { characters } from '../src/text';
import { viewSource } from '../src/view';
import { list, text, type Value } from '../src/values';

const load = (source: string, limits: Partial<Limits> = {}, name = 'test') => {
  const compiled = compileSource(source, { name });
  if (!compiled.unit) {
    throw new Error(
      compiled.error?.code ??
        compiled.diagnostics
          .map(d => `${d.code} ${d.span.line}:${d.span.col}`)
          .join(', '),
    );
  }
  return loadScript(compiled.unit, limits);
};
const run = (
  source: string,
  message = 'go',
  args: Value[] = [],
  limits: Partial<Limits> = {},
) => {
  const script = load(source);
  const r = deliver(script, message, args, limits);
  const outcome = r.finish();
  const vars = Object.fromEntries(
    script.unit.variables.map((n, i) => [n, script.variables[i]!.toString()]),
  );
  return { outcome, run: r, script, vars };
};
const result = (outcome: Outcome) => {
  if (outcome.kind === 'completed') {
    return outcome.result.toString();
  }
  if (outcome.kind === 'errored') {
    return `error ${outcome.error.toString()}`;
  }
  return outcome.kind;
};
// The result of a `go` Handler with this body, and any declarations after it.
const value = (body: string, after = '') =>
  result(run(`on go\n${body}\nend go\n${after}`).outcome);

describe('the text-model seed cases', () => {
  const root = resolve(import.meta.dir, '../../../corpus/text-model');
  const cases = readdirSync(root).filter(name =>
    readFileSync(join(root, name, 'case.toml'), 'utf8').includes(
      'kind = "trace"',
    ),
  );
  test.each(cases)("%s reproduces the seed Trace's values and raises", name => {
    const dir = join(root, name);
    const trace = readFileSync(join(dir, 'case.trace'), 'utf8').split('\n');
    const talk = readdirSync(dir).find(f => f.endsWith('.talk'))!;
    const scriptName = talk.replace('.talk', '');
    const input = trace.find(line => /^> (deliver|request) /.test(line))!;
    const message = /message=(\w+)/.exec(input)![1]!;
    const argsText = /args=(.*)$/.exec(input)?.[1];
    const args = argsText ? readDisplay(argsText) : list();
    const script = load(readFileSync(join(dir, talk), 'utf8'), {}, scriptName);
    const r = deliver(
      script,
      message,
      Array.from({ length: args.length }, (_, i) => args.index(i + 1)),
    );
    expect(r.finish().kind).toBe('completed');
    const vars = `vars ${scriptName} ${script.unit.variables
      .map((n, i) => `${n}=${script.variables[i]!.toString()}`)
      .join(' ')}`;
    expect(vars).toBe(trace.find(line => line.startsWith('vars '))!);
    expect(
      r.records.map(
        rec =>
          rec.kind === 'raise' &&
          `raise ${scriptName}/r1 code="${rec.code}" at=${rec.unit}:${rec.pc} pos=${rec.line}:${rec.col}`,
      ),
    ).toEqual(trace.filter(line => line.startsWith('raise ')));
  });
});

describe('Cost Model 0', () => {
  test('each instruction is charged its rate, and each clause tried the `clause` rate', () => {
    const r = run(
      'script variable markLength\nscript variable joinedLength\non join base, mark\n  put the length of mark into markLength\n  put base & mark into joined\n  put the length of joined into joinedLength\n  return joined\nend join',
      'join',
      [text('e'), text('́')],
    );
    expect(result(r.outcome)).toBe('"é"');
    // load 1, property 4, store-var 2, load 1, load 1, concat 4, store 1,
    // load 1, property 4, store-var 2, load 1, return 2, and `clause` 4.
    expect(r.run.fuel).toBe(28);
    // The concat's text, 16 + 2, and two numbers, 16 each.
    expect(r.run.alloc).toBe(50);
  });

  test('a Run past its Fuel faults at that instruction, before it acts, and rolls back', () => {
    const source =
      'script variable n = 0\non go\n  put 1 into n\n  put 2 into n\n  put 3 into n\nend go';
    const full = run(source);
    expect(full.run.fuel).toBe(4 + 3 * 3 + 3);
    const r = run(source, 'go', [], { fuelPerRun: 9 });
    expect(r.outcome).toEqual({
      kind: 'limit fault',
      unit: 'test',
      handler: 'go',
      limit: 'fuelPerRun',
      pc: 7,
      line: 4,
      col: 3,
      rollback: ['n'],
    });
    expect(r.run.fuel).toBe(8);
    expect(r.vars.n).toBe('0');
  });

  test('a call past the call depth faults at the call, before its charge', () => {
    const r = run(
      'on go\n  return down(1)\nend go\nfunction down n\n  return down(n + 1)\nend down',
      'go',
      [],
      { callDepth: 5 },
    );
    expect(r.outcome).toMatchObject({
      kind: 'limit fault',
      unit: 'test',
      limit: 'callDepth',
      line: 5,
    });
  });

  test('allocation past the budget faults', () => {
    const r = run('on go\n  put "abcdefgh" & "ijkl" into x\nend go', 'go', [], {
      allocPerRun: 20,
    });
    expect(r.outcome).toMatchObject({
      kind: 'limit fault',
      unit: 'test',
      limit: 'allocPerRun',
      line: 2,
    });
  });

  test('catch search charges 4 per frame it leaves and acceptance costs 1', () => {
    const base =
      'on go\n  try\n    put f() into x\n  catch e\n  end try\nend go\nfunction f\n  return g()\nend f\nfunction g\n  ';
    const thrown = run(`${base}throw "x"\nend g`).run.fuel;
    const caught = run(`${base}return 1\nend g`).run.fuel;
    expect(thrown).toBeGreaterThan(caught);
    expect(thrown - caught).toBe(
      // const 1, throw 10, the unwind of two frames 8, then the catch
      // handler's store 1, catch-accept 1, the clause's load, store and move 3 and its jump 1;
      // against const 1, two returns 4, the store 1 and the try's jump 1.
      1 + 10 + 8 + 1 + 1 + 3 + 1 - (1 + 4 + 1 + 1),
    );
  });
});

describe('values and operators', () => {
  test('decimal arithmetic keeps its exponents', () => {
    expect(
      value(
        '  return [0.1 + 0.2, 2.50 * 3, 10 / 4, 7.50 / 3, 1 / 0.01, 2 ^ 10, -7 mod 3, 7 div 2]',
      ),
    ).toBe('[0.3, 7.50, 2.5, 2.50, 100, 1024, -1, 3]');
    expect(value('  return 1 / 3')).toBe(
      '0.3333333333333333333333333333333333',
    );
  });

  test('ordering and equality follow chapter 3', () => {
    expect(
      value(
        '  return [[1, "b"] < [2, "a"], [1, 2] < [1, 2, 0], "Zebra" < "apple", 1.0 = 1, "A" = "a" ignoring case]',
      ),
    ).toBe('[true, true, true, true, true]');
    expect(value('  return 1 < "1"')).toContain(
      'error {code: "can\'t compare"',
    );
  });

  test("a Core-raised error is a map with its keys in chapter 6's order", () => {
    const { outcome } = run('on go\n  return "007" + 1\nend go');
    if (outcome.kind !== 'errored') {
      throw new Error('expected an error');
    }
    const error = outcome.error;
    expect(error.entries().map(([k]) => k)).toEqual([
      'code',
      'message',
      'expected',
      'got',
      'value',
      'at',
    ]);
    expect(error.get('message').asText()).toBe(
      'Expected "number", but got "text": "007"',
    );
    expect(error.get('at').toString()).toBe(
      '{unit: "test", handler: "go", line: 2, column: 16}',
    );
  });

  test('ranges and integer ranges', () => {
    expect(
      value(
        '  return [the length of (5..7), item 1 of (5..7), the items of (1..3), 5 is in 1..9, 3..1]',
      ),
    ).toBe('[3, 5, [1, 2, 3], true, 3..1]');
  });

  test.each(['[1, 2]', '[]', '(1..3)', '(3..1)', '"a,b"', '""'])(
    'the items of %s rejects an empty delimiter',
    source => {
      const { outcome } = run(
        `on go\n  return the items of ${source} delimited by ""\nend go`,
      );
      expect(outcome.kind).toBe('errored');
      if (outcome.kind !== 'errored') {
        throw new Error('expected an empty-delimiter error');
      }
      expect(outcome.error.get('code').asText()).toBe('out of range');
      expect(outcome.error.get('field').asText()).toBe('delimiter');
      expect(outcome.error.get('value').asText()).toBe('');
      expect(outcome.error.get('at').toString()).toBe(
        '{unit: "test", handler: "go", line: 2, column: 10}',
      );
    },
  );

  test.each(['[1, 2]', '(1..3)'])(
    'the items of %s rejects a non-text delimiter',
    source => {
      const { outcome } = run(
        `on go\n  return the items of ${source} delimited by 42\nend go`,
      );
      expect(outcome.kind).toBe('errored');
      if (outcome.kind !== 'errored') {
        throw new Error('expected a delimiter kind error');
      }
      expect(outcome.error.get('code').asText()).toBe('wrong kind');
      expect(outcome.error.get('expected').asText()).toBe('text');
      expect(outcome.error.get('got').asText()).toBe('number');
      expect(outcome.error.get('value').toString()).toBe('42');
    },
  );

  test('the items property accepts nonempty delimiters on lists and ranges', () => {
    expect(
      value(
        '  return [the items of [1, 2] delimited by ";", the items of [] delimited by ";", the items of (1..3) delimited by ";", the items of (3..1) delimited by ";"]',
      ),
    ).toBe('[[1, 2], [], [1, 2, 3], []]');
  });

  test('chunk reads and writes', () => {
    expect(
      value(
        '  put "a,b,c" into row\n  put "X" into item 2 of row\n  put [1, 2] into xs\n  put 9 into item 4 of xs\n  return [row, xs, items 2..3 of "a,b,c,d"]',
      ),
    ).toBe('["a,X,c", [1, 2, nothing, 9], "b,c"]');
    expect(
      value(
        '  put "one two  three" into s\n  delete word 2 of s\n  put [1, 2, 3] into xs\n  delete item 1 of xs\n  return [s, xs]',
      ),
    ).toBe('["one three", [2, 3]]');
  });
});

describe('control and errors', () => {
  test('catch clauses, finally and rethrow', () => {
    expect(
      value(
        '  try\n    throw {code: "x", n: 1}\n  catch {code: "y"}\n    return "y"\n  catch {code: c, n: n} where n > 0\n    return c\n  end try',
      ),
    ).toBe('"x"');
    const r = run(
      'script variable log = []\non go\n  try\n    throw "a"\n  finally\n    put "f" after log\n  end try\nend go',
    );
    expect(result(r.outcome)).toBe(
      'error {code: "a", at: {unit: "test", handler: "go", line: 4, column: 5}}',
    );
    expect(r.vars.log).toBe('["f"]');
  });

  test('an error in a finally block replaces the one in flight, as its `during`', () => {
    const r = run(
      'on go\n  try\n    throw "first"\n  finally\n    throw "second"\n  end try\nend go',
    );
    expect(result(r.outcome)).toBe(
      'error {code: "second", at: {unit: "test", handler: "go", line: 5, column: 5}, during: {code: "first", at: {unit: "test", handler: "go", line: 3, column: 5}}}',
    );
  });

  test('return through finally runs it first', () => {
    const r = run(
      'script variable log = []\non go\n  repeat for each x in [1, 2, 3]\n    try\n      if x = 2 then next repeat\n      if x = 3 then return x\n    finally\n      put x after log\n    end try\n  end repeat\nend go',
    );
    expect(result(r.outcome)).toBe('3');
    expect(r.vars.log).toBe('[1, 2, 3]');
  });

  test('a Guard that errors skips its clause, and no matching clause is unhandled', () => {
    const source =
      'on pick n where n > 10\n  return "big"\nend pick\non pick n\n  return "small"\nend pick';
    const r = run(source, 'pick', [text('x')]);
    expect(result(r.outcome)).toBe('"small"');
    expect(
      r.run.records.map(rec => (rec.kind === 'guard-skip' ? rec.code : null)),
    ).toEqual(["can't compare"]);
    expect(run(source, 'pick', []).outcome.kind).toBe('unhandled');
    expect(run(source, 'other', []).outcome.kind).toBe('unhandled');
  });

  test('a Handler called by name tries its clauses, and raises `no match` at the call', () => {
    const sizes =
      'on size n where n > 9\n  return "big"\nend size\non size n where n < 3\n  return "small"\nend size';
    expect(value('  return [size(1), size(50)]', sizes)).toBe(
      '["small", "big"]',
    );
    expect(value('  return size(5)', sizes)).toContain('code: "no match"');
  });

  test('loops', () => {
    expect(
      value(
        '  put 0 into n\n  repeat 3 times\n    add 1 to n\n  end repeat\n  repeat while n < 10\n    add 2 to n\n  end repeat\n  repeat for each i in 1..3\n    add i to n\n  end repeat\n  return n',
      ),
    ).toBe('17');
  });
});

describe('Lambdas and Function Values', () => {
  test('captures by value, display and arity', () => {
    expect(
      value(
        '  put 3 into k\n  put given x: x * k into triple\n  put 4 into k\n  return [triple(14), triple]',
      ),
    ).toBe('[42, <function test:3:7 {k: 3}>]');
    expect(value('  put given x: x into f\n  return f(1, 2)')).toContain(
      'code: "wrong arity"',
    );
    expect(value('  put 5 into f\n  return f(1)')).toContain(
      'code: "wrong kind"',
    );
    expect(
      value(
        '  put twice into f\n  return [f(4), f]',
        'function twice x, y = 2\n  return x * y\nend twice',
      ),
    ).toBe('[8, <function test:twice>]');
  });

  test('kindOf, functionArity and functionName', () => {
    expect(
      value(
        '  return [kindOf(nothing), kindOf(3), kindOf(3 kg), kindOf([]), kindOf("2026-09-27" as civil date), kindOf(given x: x)]',
      ),
    ).toBe(
      '["nothing", "number", "quantity", "list", "civil date", "function"]',
    );
    expect(
      value(
        '  put given a, b: a into both\n  return [functionArity(twice), functionName(twice), functionArity(both), functionName(both), functionArity(none)]',
        'function twice x, y = 2\n  return x * y\nend twice\nfunction none\n  return 0\nend none',
      ),
    ).toBe('[1..2, "twice", 2..2, nothing, 0..0]');
    expect(value('  return functionArity(3)')).toContain(
      'expected: "function", got: "number"',
    );
    expect(value('  return functionName("f")')).toContain(
      'expected: "function", got: "text"',
    );
  });
});

describe('Text Patterns', () => {
  test('searches, whole matches and the Match Search', () => {
    expect(
      value(
        '  return ["$895" contains <"$", digits>, "ID-0042" matches <"ID-", 4 digits>, "ok WARN" ends with <"WARN">, offset("q", "aq")]',
      ),
    ).toBe('[true, true, true, 2]');
    expect(
      value('  return every match of <n: digits as number> in "a1 b22"'),
    ).toBe(
      '[{text: "1", range: 2..2, captures: {n: 1}, ranges: {n: 2..2}}, {text: "22", range: 5..6, captures: {n: 22}, ranges: {n: 5..6}}]',
    );
  });

  test('replace, and splices', () => {
    expect(
      value(
        '  put "Smith, Ann" into names\n  replace <last: word, ", ", first: word> in names with first & " " & last\n  return [names, replace <zero or more of "-"> in "a-b" with "+"]',
      ),
    ).toBe('["Ann Smith", "+a+b+"]');
    expect(
      value(
        '  put <4 digits> into tail\n  return [<"ID", ("-"), (tail)>, <(tail), "x">]',
      ),
    ).toBe('[<"ID", "-", <4 digits>>, < <4 digits>, "x">]');
  });

  test('destructuring with a Text Pattern binds its Captures', () => {
    expect(
      value(
        '  let <"ID-", id: 4 digits as number> be "ID-0042"\n  match "a: b"\n    when contains <word, ": ", tail: text> then return [id, tail]\n  end match',
      ),
    ).toBe('[42, "b"]');
  });
});

describe("chapter 8's matcher", () => {
  const runs: [string, string, RunKind | 'all', string, number][] = [
    ['<"$", digits>', '$895', 'search', '$895', 10],
    ['<"$", digits lazily>', '$895', 'search', '$8', 6],
    ['<"a" or "ab">', 'ab', 'search', 'a', 6],
    ['<"ab" or "a">', 'ab', 'search', 'ab', 7],
    ['<"ID-", 4 digits>', 'ID-0042', 'whole', 'ID-0042', 8],
    ['<3 digits>', 'a1234b', 'search', '123', 11],
    ['<word break, "cat", word break>', 'a cat, dog', 'search', '', 8],
    ['<text, "x">', 'aaaxbx', 'search', 'aaaxbx', 16],
    ['<text lazily, "x">', 'aaaxbx', 'search', 'aaax', 11],
    ['<a number>', 'is -12.5 kg', 'search', '-12.5', 20],
    ['<"WARN">', 'ok WARN', 'suffix', 'WARN', 12],
    ['<"ok">', 'ok WARN', 'prefix', 'ok', 3],
    ['<digits>', 'a1 b22 c333', 'all', '1|22|333', 21],
    ['<optional "x">', 'ab', 'all', '||', 12],
  ];
  test.each(runs)(
    '%s on %p (%s) gives %p in %d steps',
    (source, subject, kind, want, steps) => {
      const decl = viewSource(
        checkSource(`constant p = ${source}`).tree!.root,
      )[0]!;
      if (decl.k !== 'constant' || decl.value.k !== 'pattern') {
        throw new Error('not a pattern');
      }
      const program = compile(decl.value.pattern.els);
      const cs = characters(subject);
      if (kind === 'all') {
        const all = matchSearch(program, cs);
        expect(
          all.found.map(f => cs.slice(f.start, f.end).join('')).join('|'),
        ).toBe(want);
        expect(all.steps).toBe(steps);
      } else {
        const one = runProgram(program, cs, 0, kind);
        expect(
          one.found ? cs.slice(one.found.start, one.found.end).join('') : '',
        ).toBe(want);
        expect(one.steps).toBe(steps);
      }
    },
  );
});

describe('loading', () => {
  test('the initialiser runs uncharged, and a failing one is a load error', () => {
    const script = load(
      'constant base = 2\nscript variable total = base * 3\non go\nend go',
    );
    expect(script.variables.map(v => v.toString())).toEqual(['6']);
    expect(() => load('constant x = 1 / 0\non go\nend go')).toThrow(
      UnitLoadError,
    );
  });

  test("a literal Text Pattern past the size limit doesn't load", () => {
    expect(() =>
      load('on go\n  return <100 digits>\nend go', { patternSize: 50 }),
    ).toThrow('pattern too large');
  });

  test('what this Core does not run yet says so', () => {
    expect(() => run('on go\n  tell log to write 1\nend go')).toThrow(
      NotImplementedError,
    );
  });

  test('deep expressions run without the native call stack', () => {
    const script = load(
      'constant n = ' + '('.repeat(3000) + '1 + 1' + ')'.repeat(3000),
    );
    expect(script.definitions[0]!.toString()).toBe('2');
  });

  test('a function runs as a Run of its own', () => {
    const script = load('function double x\n  return x * 2\nend double');
    expect(
      result(callFunction(script, 'double', [readDisplay('21')]).finish()),
    ).toBe('42');
  });
});

describe('collecting clauses', () => {
  test('initializes every head before evaluating it and nests collected lists', () => {
    expect(
      value(`repeat 0 times collecting 1 into zero
end repeat
repeat for each n in [] collecting n into empty
end repeat
repeat while the length of xs < 2 collecting [1, 2] into xs
end repeat
repeat until the length of ys = 2 collecting 3 into ys
end repeat
repeat forever collecting 4 into zs
 if the length of zs = 2 then exit repeat
end repeat
return [zero, empty, xs, ys, zs]`),
    ).toBe('[[], [], [[1, 2], [1, 2]], [3, 3], [4, 4]]');
  });
  test('collects after the body and skips next and exit', () => {
    expect(
      value(`repeat for each n in 1..6 collecting doubled into xs
 if n = 2 then next repeat
 if n = 5 then exit repeat
 put n * 2 into doubled
end repeat
return xs`),
    ).toBe('[2, 6, 8]');
  });
  test('retains the partial list when the expression raises', () => {
    expect(
      value(`try
 repeat for each n in [2, 1, 0] collecting 6 / n into xs
 end repeat
catch e
 return xs
end try`),
    ).toBe('[3, 6]');
  });
  test('captures each iteration binding in the collected Lambda', () => {
    expect(
      value(`repeat for each n in [1, 2] collecting given x: x * n into fs
end repeat
put item 1 of fs into f
put item 2 of fs into g
return [f(3), g(3)]`),
    ).toBe('[3, 6]');
  });
});

describe('Whose Clauses', () => {
  test('every gives a list, and an ordinal or last one chunk or nothing', () => {
    expect(
      value(`put [{amount: 5, paid: true}, {amount: 50, paid: false}, {amount: 70, paid: true}] into orders
return [every item of orders whose amount > 10, the first item of orders whose it's paid, the last item of orders whose amount > 1, the second item of orders whose it's paid, the third item of orders whose it's paid, every item of orders whose amount > 100]`),
    ).toBe(
      '[[{amount: 50, paid: false}, {amount: 70, paid: true}], {amount: 5, paid: true}, {amount: 70, paid: true}, {amount: 70, paid: true}, nothing, []]',
    );
  });
  test('text chunks give lists of texts, with `delimited by`', () => {
    expect(
      value(`put "a bb" & newline & newline & "ccc" into report
return [every line of report whose length > 1, every word of report whose length = 2, the second line of report whose it is empty, every item of "a;;b" delimited by ";" whose it is not empty, the first item of line 1 of "x;y" delimited by ";" whose it is "y", every character of "abc" whose it <> "b"]`),
    ).toBe('[["a bb", "ccc"], ["bb"], nothing, ["a", "b"], "y", ["a", "c"]]');
  });
  test('the n-th match stops the walk, and `it` is the chunk', () => {
    expect(
      value(
        'return [the second item of [1, 2, 3, 0] whose 6 / it > 1, every item of [1, 2, 3] whose (every item of [it, 5] whose it > 2) is not empty, it]',
      ),
    ).toBe('[2, [1, 2, 3], nothing]');
  });
  test('a condition that is not a boolean raises `wrong kind`', () => {
    const outcome = run(
      'on go\nreturn every item of [1] whose it\nend go',
    ).outcome;
    expect(outcome.kind).toBe('errored');
    expect(outcome.kind === 'errored' && outcome.error.toString()).toContain(
      'code: "wrong kind", message: "Expected " & quote & "boolean" & quote & ", but got " & quote & "number" & quote & ": 1", expected: "boolean", got: "number", value: 1, at: {unit: "test", handler: "go", line: 2, column: 26}',
    );
  });
});
