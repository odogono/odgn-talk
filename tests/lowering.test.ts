import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  checkSource,
  compileSource,
  disassemble,
  exportsOf,
  LoweringError,
  type CodeUnit,
  type Instruction,
} from '../src/index';
import { patternSource, quantityText } from '../src/canonical';
import { instructionSpec, operandKinds } from '../src/code-unit';
import { instructions } from '../src/generated/machine';
import { viewSource } from '../src/view';

const root = resolve(import.meta.dir, '..');
const files = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? files(path)
        : path.endsWith('.talk')
          ? [path]
          : [];
    });

const compile = (
  source: string,
  options: Partial<Parameters<typeof compileSource>[1]> = {},
): CodeUnit => {
  const result = compileSource(source, { name: 'test', ...options });
  if (!result.unit) {
    throw new Error(
      result.error
        ? `${result.error.code} at ${result.error.tok.line}:${result.error.tok.col}`
        : result.diagnostics
            .map(d => `${d.code} at ${d.span.line}:${d.span.col}`)
            .join(', '),
    );
  }
  return result.unit;
};
const code = (unit: CodeUnit, body = 1) =>
  disassemble(unit)
    .split('\n')
    .filter(line => /^ {2}\d{4} /.test(line))
    .slice(unit.bodies[body]!.start, unit.bodies[body]!.end)
    .map(line => line.slice(2));
const section = (unit: CodeUnit, heading: string) => {
  const lines = disassemble(unit).split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) {
    return [];
  }
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) {
      break;
    }
    out.push(line.slice(2));
  }
  return out;
};

// ---------------------------------------------------------------------------
// The structural check every lowering must pass: machine.toml's operands and
// stack effects, one depth per instruction on every path, and every Unwind
// Table entry's depth matching the stack where its range starts.
// ---------------------------------------------------------------------------

const leaves = new Set([
  'jump',
  'return',
  'clause-fail',
  'throw',
  'rethrow',
  'raise',
  'end-cleanup',
  'veto',
  'pass',
]);
const count = (unit: CodeUnit, ins: Instruction, effect: number | string) => {
  if (typeof effect === 'number') {
    return effect;
  }
  const [kind, plus] = effect.split(' + ');
  const value = ins.operands[operandKinds(ins).indexOf(kind!)]!;
  const n =
    kind === 'event'
      ? unit.events[value as number]!.branches.reduce(
          (sum, branch) =>
            sum +
            (branch.kind === 'after'
              ? 1
              : (branch.from ? 1 : 0) + branch.captures),
          unit.events[value as number]!.timeout ? 1 : 0,
        )
      : (value as number);
  return n + (plus ? Number(plus) : 0);
};
const verify = (unit: CodeUnit): string[] => {
  const problems: string[] = [];
  for (const body of unit.bodies) {
    const depth = new Map<number, number>();
    const work: [number, number][] = [];
    const reach = (pc: number, d: number, from: number) => {
      if (pc < body.start || pc >= body.end) {
        problems.push(`${body.name}: ${from} leaves the body for ${pc}`);
        return;
      }
      const had = depth.get(pc);
      if (had === undefined) {
        depth.set(pc, d);
        work.push([pc, d]);
      } else if (had !== d) {
        problems.push(`${body.name}: ${pc} is reached with ${had} and ${d}`);
      }
    };
    const entries = unit.unwind.filter(
      entry => entry.start >= body.start && entry.start < body.end,
    );
    const done = new Set<object>();
    reach(body.start, 0, body.start);
    for (;;) {
      while (work.length) {
        const [pc, d] = work.pop()!;
        const ins = unit.code[pc]!;
        const spec = instructionSpec.get(ins.op)!;
        const kinds = operandKinds(ins);
        const pops = count(unit, ins, spec.pops);
        const pushes = count(unit, ins, spec.pushes);
        if (d < pops) {
          problems.push(`${body.name}: ${pc} ${ins.op} pops ${pops} of ${d}`);
          continue;
        }
        kinds.forEach((kind, i) => {
          if (kind === 'label') {
            const jumps = 'jumps' in spec ? spec.jumps : 0;
            reach(
              ins.operands[i] as number,
              ins.op === 'jump' ? d : d - pops + jumps,
              pc,
            );
          }
        });
        if (!leaves.has(ins.op)) {
          reach(pc + 1, d - pops + pushes, pc);
        }
      }
      const next = entries.find(e => !done.has(e) && depth.has(e.start));
      if (!next) {
        break;
      }
      done.add(next);
      if (depth.get(next.start) !== next.depth) {
        problems.push(
          `${body.name}: the ${next.kind} entry at ${next.start} has depth ${next.depth}, the stack ${depth.get(next.start)}`,
        );
      }
      reach(
        next.target,
        next.kind === 'catch' ? next.depth + 1 : next.depth,
        next.start,
      );
    }
    if (!leaves.has(unit.code[body.end - 1]!.op)) {
      problems.push(`${body.name} can run off its end`);
    }
  }
  return problems;
};

// Well-known objects for the corpus's sources: each Script's other names
// come from case.toml, which this check stands in for.
const compileFile = (path: string): CodeUnit => {
  const source = readFileSync(path, 'utf8');
  const dir = path.slice(0, path.lastIndexOf('/'));
  const setup = statSync(join(dir, 'case.toml'), { throwIfNoEntry: false })
    ? (Bun.TOML.parse(readFileSync(join(dir, 'case.toml'), 'utf8')) as {
        libraries?: { source: string }[];
      })
    : {};
  const unit =
    path.includes('/stdlib/') ||
    setup.libraries?.some(library => library.source === basename(path))
      ? 'library'
      : 'script';
  const libraries: Record<string, ReturnType<typeof exportsOf>> = {};
  for (const sibling of files(dir)) {
    const checked = checkSource(readFileSync(sibling, 'utf8'), {
      unit: 'library',
    });
    if (sibling !== path && checked.tree) {
      libraries[basename(sibling, '.talk')] = exportsOf(checked.tree);
    }
  }
  let objects: string[] = [];
  for (;;) {
    const result = compileSource(source, {
      name: basename(path, '.talk'),
      unit,
      objects,
      libraries,
    });
    if (result.unit) {
      return result.unit;
    }
    const unknown = result.diagnostics
      .filter(d => d.code === 'unknown name')
      .map(d => d.message.replace('unknown name: ', ''));
    if (!unknown.length || unknown.every(name => objects.includes(name))) {
      throw new Error(
        `${path}: ${result.error?.code ?? result.diagnostics.map(d => d.code).join(', ')}`,
      );
    }
    objects = [...new Set([...objects, ...unknown])];
  }
};

describe('the lowering of every source', () => {
  const sources = [
    ...files(join(root, 'spec/stdlib')),
    ...files(join(root, 'corpus')),
    join(root, 'tools/machine/lowering.talk'),
  ];
  test.each(sources.map(path => [path.slice(root.length + 1), path]))(
    '%s agrees with machine.toml on every path',
    (_, path) => {
      const unit = compileFile(path);
      expect(verify(unit)).toEqual([]);
      const text = disassemble(unit);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain('\r');
      expect(text).not.toContain('undefined');
    },
  );

  test('the Disassembly Cases emit every instruction of machine.toml', () => {
    const used = new Set<string>();
    for (const path of files(join(root, 'corpus/disassembly'))) {
      for (const ins of compileFile(path).code) {
        used.add(ins.op);
      }
    }
    expect(instructions.map(i => i.name).filter(n => !used.has(n))).toEqual([]);
  });
});

describe('the code unit', () => {
  test('sections in order, and an empty one left out', () => {
    const unit = compile('on go\nend go');
    expect(disassemble(unit)).toBe(
      [
        'unit test script',
        'constants',
        '  0 nothing',
        'bodies',
        '  0 init initialiser () locals 1 0000..0001',
        '  1 handler go clause 1 () locals 1 0002..0004',
        'code',
        '  0000 1:1 const 0 ; nothing',
        '  0001 1:1 return',
        '  0002 2:1 const 0 ; nothing',
        '  0003 2:1 return',
        '  0004 2:1 clause-fail',
        '',
      ].join('\n'),
    );
  });

  test('definitions: Constants, imported ones, then defaults, in source order', () => {
    const unit = compile(
      [
        'constant a = 1',
        'use epoch from date',
        'function f x, y = a',
        'end f',
        'constant b = a + 1',
        'function g z = "z"',
        'end g',
      ].join('\n'),
    );
    expect(section(unit, 'definitions')).toEqual([
      '0 a',
      '1 date:epoch',
      '2 b',
      '3 f.y',
      '4 g.z',
    ]);
    expect(section(unit, 'bodies')).toContain(
      '1 function f (x, y = 3) locals 3 0012..0013',
    );
    // The initialiser stores the unit's own definitions only.
    expect(code(unit, 0)).toEqual([
      '0000 1:14 const 0 ; 1',
      '0001 1:1 store-definition a',
      '0002 3:19 load-definition a',
      '0003 3:15 store-definition f.y',
      '0004 5:14 load-definition a',
      '0005 5:18 const 0 ; 1',
      '0006 5:16 add',
      '0007 5:1 store-definition b',
      '0008 6:16 const 1 ; "z"',
      '0009 6:12 store-definition g.z',
      '0010 1:1 const 2 ; nothing',
      '0011 1:1 return',
    ]);
  });

  test('slots: arguments, parameter pattern names, then locals by first binding site', () => {
    const unit = compile(
      'on h [p, ...q], r\n  let [s, ...t] be r\n  put 1 into u\n  repeat for each v in t\n  end repeat\nend h',
    );
    expect(unit.bodies[1]!.locals).toEqual([
      'it',
      '(1)',
      'r',
      'p',
      'q',
      's',
      't',
      'u',
      'v',
      '(9)',
      '(10)',
      '(11)',
    ]);
  });

  test('a temp is the lowest released slot', () => {
    const unit = compile(
      'on h x\n  put item 1 of x delimited by ";" into a\n  put item 2 of x delimited by "," into b\nend h',
    );
    expect(code(unit).filter(line => / store \d/.test(line))).toEqual([
      '0005 2:7 store 4 ; (4)',
      '0008 2:3 store 2 ; a',
      '0012 3:7 store 4 ; (4)',
      '0015 3:3 store 3 ; b',
    ]);
  });

  test('a Lambda in the initialiser is named after it, and a nested one after its Lambda', () => {
    const unit = compile(
      'constant f = given x: x\non h k\n  put given a\n    return given b: a + b + k\n  end given into g\nend h',
    );
    expect(unit.bodies.map(b => `${b.kind} ${b.name} ${b.captures}`)).toEqual([
      'init initialiser 0',
      'handler h 0',
      'lambda initialiser:1:14 0',
      'lambda h:3:7 1',
      'lambda h:3:7:4:12 2',
    ]);
  });

  test('a body that holds a Suspension Point may suspend', () => {
    const unit = compile('on h\n  wait 1 s\nend h\non k\n  h and wait\nend k');
    expect(unit.bodies.map(b => b.maySuspend)).toEqual([false, true, true]);
  });

  test('a well-known object is shown by name, in first-use order', () => {
    const unit = compile(
      'on h\n  send a to door\n  send b to lamp\n  send c to door\nend h',
      {
        objects: ['lamp', 'door'],
      },
    );
    expect(section(unit, 'objects')).toEqual(['0 door', '1 lamp']);
    expect(code(unit).filter(line => line.includes('load-object'))).toEqual([
      '0002 2:13 load-object door',
      '0004 3:13 load-object lamp',
      '0006 4:13 load-object door',
    ]);
  });
});

describe('positions', () => {
  test("a Container write's root store is the statement's, and its levels their own", () => {
    const unit = compile(
      'on h x\n  put 1 into x\n  put 2 into item 3 of x\nend h',
    );
    expect(code(unit)).toEqual([
      '0002 2:7 const 1 ; 1',
      '0003 2:3 store 1 ; x',
      '0004 3:7 const 2 ; 2',
      '0005 3:3 store 2 ; (2)',
      '0006 3:19 const 3 ; 3',
      '0007 3:14 store 3 ; (3)',
      '0008 3:3 load 1 ; x',
      '0009 3:3 store 4 ; (4)',
      '0010 3:14 load 3 ; (3)',
      '0011 3:14 load 4 ; (4)',
      '0012 3:3 load 2 ; (2)',
      '0013 3:14 chunk-set item',
      '0014 3:3 store 1 ; x',
      '0015 4:1 const 0 ; nothing',
      '0016 4:1 return',
      '0017 4:1 clause-fail',
    ]);
  });

  test("a Guard's test is at its first token, and a loop's at `repeat`", () => {
    const unit = compile(
      'on h n where n > 1\n  repeat while n < 3\n  end repeat\nend h',
    );
    expect(code(unit)).toContain('0005 1:14 branch-false 0013');
    expect(code(unit)).toContain('0009 2:3 branch-false 0011');
    expect(code(unit)).toContain('0010 2:3 jump 0006');
  });

  test("a parenthesised Guard's test is at its opening parenthesis", () => {
    const unit = compile('on h n where (n) > 1\nend h');
    expect(code(unit)).toContain('0005 1:14 branch-false 0008');
  });

  test('the ordinal of an ordinal chunk is at its chunk word', () => {
    const unit = compile('on h x\n  return the last word of x\nend h');
    expect(code(unit).slice(0, 3)).toEqual([
      '0002 2:19 const 1 ; -1',
      '0003 2:27 load 1 ; x',
      '0004 2:19 chunk-get word',
    ]);
  });
});

const patternOf = (text: string) => {
  const checked = checkSource(`constant p = ${text}`);
  const decl = viewSource(checked.tree!.root)[0]!;
  if (decl.k !== 'constant' || decl.value.k !== 'pattern') {
    throw new Error('not a pattern');
  }
  return patternSource(decl.value.pattern);
};

describe('constants', () => {
  test('Quantities are in normal form', () => {
    expect(quantityText('1', 'days')).toBe('1 day');
    expect(quantityText('1.0', 'day')).toBe('1.0 day');
    expect(quantityText('-1', 'days')).toBe('-1 day');
    expect(quantityText('0', 'day')).toBe('0 days');
    expect(quantityText('5', 'inches/s')).toBe('5 inch/s');
    expect(quantityText('3', 'm*kg/s^2')).toBe('3 kg*m/s^2');
    expect(quantityText('2', 'm*m')).toBe('2 m^2');
    expect(quantityText('4', 'm/m')).toBe('4');
    expect(quantityText('5', '1/s')).toBe('5 1/s');
    expect(quantityText('1', 'USD/EUR')).toBe('1 USD/EUR');
    expect(quantityText('9', 'm/kg*s')).toBe('9 m/kg*s');
    expect(quantityText('9', 's*m/kg')).toBe('9 m*s/kg');
  });

  test('each distinct constant enters the pool once, as the lowering first uses it', () => {
    const unit = compile(
      'on h\n  return [1, "1", 1.0, 1, 0x01, pi, true, "1"]\nend h',
    );
    expect(section(unit, 'constants')).toEqual([
      '0 nothing',
      '1 1',
      '2 "1"',
      '3 1.0',
      '4 pi',
      '5 true',
    ]);
  });

  test('text is NFC, in its display form', () => {
    const unit = compile('on h\n  return ["e\u0301", "tab\there", ""]\nend h');
    expect(section(unit, 'constants')).toEqual([
      '0 nothing',
      '1 "é"',
      '2 "tab" & tab & "here"',
      '3 ""',
    ]);
  });

  test('a Text Pattern constant is its canonical source', () => {
    expect(patternOf('<  "ID" ,0x04  digits >')).toBe('<"ID", 4 digits>');
    expect(patternOf('<<4 digits> , "x">'.replace('<<', '< <'))).toBe(
      '< <4 digits>, "x">',
    );
    expect(patternOf('<<"a"> lazily>'.replace('<<', '< <'))).toBe(
      '< <"a"> lazily>',
    );
    expect(patternOf('<"a", <>, < <> >, "b">')).toBe('<"a", "b">');
    expect(patternOf('<digits lazily ignoring case as number>')).toBe(
      '<digits as number ignoring case lazily>',
    );
    expect(
      patternOf('<n: "a" or "b", one or more of letter, optional space>'),
    ).toBe('<n: "a" or "b", one or more of letter, optional space>');
    expect(patternOf('<uppercase letters, text start, a number>')).toBe(
      '<uppercase letters, text start, a number>',
    );
    expect(patternOf('<"é">')).toBe('<"é">');
    expect(patternOf('<(1), "x", (2)>')).toBe('<(1), "x", (2)>');
    expect(patternOf('<>')).toBe('<>');
  });

  test('a Text Pattern with splices is a template, its splices numbered', () => {
    const unit = compile('on h a, b\n  return <(a), "-", <(b)>>\nend h');
    expect(section(unit, 'constants')).toContain('1 <(1), "-", <(2)>>');
    expect(code(unit).slice(0, 3)).toEqual([
      '0002 2:12 load 1 ; a',
      '0003 2:23 load 2 ; b',
      '0004 2:10 make-pattern 1 2 ; <(1), "-", <(2)>>',
    ]);
  });
});

describe('events', () => {
  test("an event test captures the waiting body's locals and binds into its slots", () => {
    const unit = compile(
      'on h k\n  wait for paid {order: o, from: ^k} or 5 s\n  wait for\n    when done x then say x\n    after 1 s then say "late"\n  end wait\nend h',
    );
    expect(section(unit, 'events')).toEqual([
      '0 when paid body 2 captures 1 binds 2; or',
      '1 when done body 3 binds 3; after',
    ]);
    expect(section(unit, 'bodies').slice(2)).toEqual([
      '2 event paid (…) captures 1 locals 5 0027..0041',
      '3 event done (x) locals 2 0042..0045',
    ]);
    // The captures, then the timeout, then the wait; the test returns `o`.
    expect(code(unit).slice(0, 4)).toEqual([
      '0002 2:3 load 1 ; k',
      '0003 2:41 const 1 ; 5 s',
      '0004 2:3 wait-for 0',
      '0005 2:3 store 0 ; it',
    ]);
    expect(code(unit, 2).slice(-4)).toEqual([
      '0038 2:3 load 2 ; o',
      '0039 2:3 list 1',
      '0040 2:3 return',
      '0041 2:3 clause-fail',
    ]);
  });
});

describe('deep source', () => {
  test('nested expressions lower without the native call stack', () => {
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{x:', '}'],
    ]) {
      const unit = compile(
        'constant n = ' + open!.repeat(3000) + '1' + close!.repeat(3000),
      );
      expect(unit.code.length).toBeGreaterThan(2);
    }
  });

  test('nested blocks lower without the native call stack', () => {
    const unit = compile(
      'on h x\n' +
        'if x then\n'.repeat(2000) +
        'put 1 into y\n' +
        'end if\n'.repeat(2000) +
        'end h',
    );
    expect(verify(unit)).toEqual([]);
  });
});

const unsettled = (source: string, options = {}) => {
  try {
    compile(source, options);
  } catch (error) {
    return error;
  }
  return null;
};

describe('what the Spec leaves unsettled', () => {
  test('a Quantity literal naming two Units of one Unit Kind', () => {
    expect(unsettled('constant a = 2 m*ft')).toBeInstanceOf(LoweringError);
  });
  test('a bit field whose width is not an integer literal', () => {
    expect(
      unsettled('on h n\n  return << 1 as (n) bits >>\nend h'),
    ).toBeInstanceOf(LoweringError);
  });
  test('a Container rooted in a well-known object', () => {
    expect(
      unsettled('on h\n  put 1 into door\nend h', { objects: ['door'] }),
    ).toBeInstanceOf(LoweringError);
  });
});

test('no code unit with a syntax error or a load diagnostic', () => {
  expect(
    compileSource('on h\n  put 1 into\nend h', { name: 't' }).unit,
  ).toBeNull();
  const unknown = compileSource('on h\n  return absent\nend h', { name: 't' });
  expect(unknown.unit).toBeNull();
  expect(unknown.diagnostics.map(d => d.code)).toEqual(['unknown name']);
});
