import { describe, expect, test } from 'bun:test';
import catalogue from '../../../spec/data/diagnostics.toml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkSource,
  checkSyntax,
  compileSource,
  parseSource,
  syntaxText,
  type SemanticElement,
  type DiagnosticCode,
  type SemanticName,
} from '../src';
import { kindNames, unconvertibleKinds } from '../src/constructs';

const names = (tree: SemanticElement): SemanticName[] => {
  const result: SemanticName[] = [];
  const stack = [tree];
  while (stack.length) {
    const element = stack.pop()!;
    if (element.kind === 'name') {
      result.push(element);
    }
    if (element.kind === 'node') {
      stack.push(...[...element.children].reverse());
    }
  }
  return result;
};

const diagnostics = (source: string) => {
  const result = checkSource(source);
  expect(result.error).toBeNull();
  return result.diagnostics.map(
    ({ code, span }) => [code, span.line, span.col] as const,
  );
};

describe('Core name resolution', () => {
  test('collects declarations and whole-body locals before resolving reads', () => {
    const source =
      'on t\n return f(later)\n if true then put 1 into later\nend t\nfunction f x\n return x\nend f';
    const result = checkSource(source);
    expect(result.ok).toBe(true);
    const occurrences = names(result.tree!.root).filter(
      name => name.text === 'later',
    );
    expect(occurrences.map(name => name.binding)).toEqual([
      occurrences[0]!.binding,
      occurrences[0]!.binding,
    ]);
    expect(occurrences[0]!.binding).toMatchObject({
      kind: 'local',
      initial: 'nothing',
    });
  });

  test('unknown values, calls and scalar positions are exact and ordered', () => {
    expect(
      diagnostics(
        'on t\r\n\tput "😀" & absent into x\r\n return missing(x)\r\nend t',
      ),
    ).toEqual([
      ['unknown name', 2, 12],
      ['unknown name', 3, 9],
    ]);
  });

  test('Handlers and Built-ins are callable but their bare names are not values', () => {
    expect(
      diagnostics(
        'on t\n put [t, min, f, pi] into xs\n return t(min(xs))\nend t\nfunction f\n return nothing\nend f',
      ),
    ).toEqual([
      ['not a value', 2, 7],
      ['not a value', 2, 10],
    ]);
  });

  test('Built-ins may be shadowed throughout a body', () => {
    const result = checkSource(
      'on t min\n put min(1) into pi\n return pi\nend t',
    );
    expect(result.ok).toBe(true);
    expect(
      names(result.tree!.root)
        .filter(name => name.text === 'min')
        .map(name => name.binding?.kind),
    ).toEqual(['parameter', 'parameter']);
  });

  test('clashes point to the later binding even when the function is later', () => {
    expect(
      diagnostics('on t\n put 1 into f\nend t\nfunction f\n return 1\nend f'),
    ).toEqual([['name clash', 4, 10]]);
    expect(diagnostics('script variable x\non t x\nend t')).toEqual([
      ['name clash', 2, 6],
    ]);
    expect(diagnostics('on t x\nend t\nconstant x = 1')).toEqual([
      ['name clash', 3, 10],
    ]);
  });

  test('duplicate bindings cover destructuring, parameter lists and captures', () => {
    expect(
      diagnostics(
        'on t [x, x], x\n let {a: y, b: y} be {}\n put <z: digit, z: digit> into p\nend t',
      ),
    ).toEqual([
      ['duplicate name', 1, 10],
      ['duplicate name', 1, 14],
      ['duplicate name', 2, 16],
      ['duplicate name', 3, 17],
    ]);
    expect(diagnostics('function f x, x\n return x\nend f')).toEqual([
      ['duplicate name', 1, 15],
    ]);
    expect(diagnostics('on t\n let x be 1\n let x be 2\nend t')).toEqual([]);
  });

  test('diagnostic ties follow the catalogue rather than checker pass order', () => {
    const source = 'script variable x\non t [x, x]\nend t';
    const result = diagnostics(source);
    expect(result).toEqual([
      ['name clash', 2, 7],
      ['name clash', 2, 10],
      ['duplicate name', 2, 10],
    ]);
    const codes = (catalogue.diagnostic as { code: string }[]).map(
      row => row.code,
    );
    for (const [code] of result) {
      expect(codes).toContain(code);
    }
    expect(codes.indexOf('name clash')).toBeLessThan(
      codes.indexOf('duplicate name'),
    );
  });

  test('message, property, map-key, kind and operation names are not value references', () => {
    expect(
      diagnostics(
        'on t\n external 1\n send hello to me\n ask clock to get\n put {missing: 1} into x\n return the missing of x is a number\nend t',
      ),
    ).toEqual([]);
  });

  test('nested Lambdas capture outer locals, with their own parameters and it', () => {
    const result = checkSource(
      'on t x\n put given y: given z: x + y + z into f\nend t',
    );
    expect(result.ok).toBe(true);
    const scopes = result.tree!.scopes;
    expect(
      scopes.map(scope => scope.captures.map(binding => binding.name)),
    ).toEqual([[], [], ['x'], ['x', 'y']]);
    expect(
      new Set(
        scopes
          .slice(1)
          .map(
            scope => scope.bindings.find(binding => binding.name === 'it')!.id,
          ),
      ).size,
    ).toBe(3);
  });

  test('Binary Pattern sizes require earlier bindings, pins use body names', () => {
    expect(
      diagnostics(
        'on t n\n let <<body: len bytes, len: uint16>> be nothing\n let <<len: uint16, body: (len + ^n) bytes>> be nothing\nend t',
      ),
    ).toEqual([['unknown name', 2, 14]]);
  });

  test('imports retain their kinds and renames and clash at the use name', () => {
    const options = {
      libraries: { helpers: { f: 'function', h: 'handler', c: 'constant' } },
    } as const;
    const result = checkSource(
      'use f from helpers as twice\nuse h, c from helpers\non t\n return [twice, h, c]\nend t',
      options,
    );
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'not a value',
    ]);
    expect(
      checkSource(
        'use f from helpers as t\non t\nend t',
        options,
      ).diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([['name clash', 1, 23]]);
  });

  test('Host object bindings resolve and cannot be rebound by a pattern', () => {
    const options = { objects: ['button'] };
    expect(checkSource('on t\n return button\nend t', options).ok).toBe(true);
    expect(
      checkSource('on t button\nend t', options).diagnostics.map(
        diagnostic => diagnostic.code,
      ),
    ).toEqual(['name clash']);
    expect(diagnostics('on t\n return button\nend t')).toEqual([
      ['unknown name', 2, 9],
    ]);
  });

  test('semantic conversion retains original source spans without trivia', () => {
    const source = '--😀\nconstant x = 1\non t\n return x\nend t --tail';
    const parsed = parseSource(source);
    expect(parsed.error).toBeNull();
    const result = checkSyntax(parsed.tree!);
    expect(syntaxText(parsed.tree!)).toBe(source);
    const reference = names(result.tree.root).find(
      name => name.text === 'x' && name.role === 'value',
    )!;
    expect(reference.span).toEqual({
      start: source.indexOf('x\n'),
      end: source.indexOf('x\n') + 1,
      line: 4,
      col: 9,
    });
    expect(reference.binding).toMatchObject({ name: 'x', kind: 'constant' });
  });

  test("checking the same syntax again uses each call's binding context", () => {
    const source = 'on t\n return external(1)\nend t';
    const parsed = parseSource(source);
    expect(parsed.error).toBeNull();
    const syntax = parsed.tree!;
    const first = checkSyntax(syntax, {
      existing: {
        external: { kind: 'function', contract: { required: 1, total: 1 } },
      },
    });
    const second = checkSyntax(syntax, {
      existing: {
        external: { kind: 'function', contract: { required: 2, total: 2 } },
      },
    });
    const third = checkSyntax(syntax);
    expect(first.ok).toBe(true);
    expect(second.diagnostics.map(d => d.code)).toEqual([
      'wrong argument count',
    ]);
    expect(third.diagnostics.map(d => d.code)).toEqual(['unknown name']);
    expect(
      names(first.tree.root).find(name => name.text === 'external')!.binding
        ?.contract,
    ).toEqual({ required: 1, total: 1 });
    expect(syntaxText(syntax)).toBe(source);
  });

  test('syntax errors suppress all semantic diagnostics', () => {
    const result = checkSource('on t\n return absent\n @\nend t');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('bad character');
    expect(result.tree).toBeNull();
    expect(result.diagnostics).toEqual([]);
  });

  test('semantic checking uses an explicit stack for deep source', () => {
    expect(
      checkSource('constant x = ' + '('.repeat(3000) + 'pi' + ')'.repeat(3000))
        .ok,
    ).toBe(true);
  });

  test('body bindings may shadow a Handler while Command Calls still select it', () => {
    const result = checkSource('on h\nend h\non t h\n h\n return h\nend t');
    expect(result.ok).toBe(true);
    expect(
      names(result.tree!.root)
        .filter(name => name.text === 'h')
        .map(name => [name.role, name.binding?.kind]),
    ).toEqual([
      ['declaration', 'handler'],
      ['binding', 'parameter'],
      ['command', 'handler'],
      ['value', 'parameter'],
    ]);
  });

  test('all body binding forms are collected, including Replace captures and key-path roots', () => {
    const result = checkSource(
      'on t\n return [a, b, c, d, e, f, rest, key]\n let {a} be {}\n repeat for each [b, ...rest] in []\n end repeat\n match nothing\n when c then return c\n end match\n try\n catch d\n end try\n wait for event e\n replace <f: digit> in key with f\n put 1 into the x of key\nend t',
    );
    expect(result.ok).toBe(true);
    expect(
      result.tree!.scopes[1]!.bindings.map(binding => binding.name),
    ).toEqual(['it', 'a', 'b', 'rest', 'c', 'd', 'e', 'f', 'key']);
  });

  test('Lambda write roots resolve captures from enclosing whole-body locals', () => {
    const result = checkSource(
      'on t\n put given\n put 1 into x\n end given into f\n put 2 into x\nend t',
    );
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([["can't write", 3, 13]]);
    expect(
      result.tree!.scopes[2]!.captures.map(binding => binding.name),
    ).toEqual(['x']);
    expect(
      result.tree!.scopes[2]!.bindings.map(binding => binding.name),
    ).toEqual(['it']);
  });

  test('a Binary Pattern field is bound after its size, with later field names still unknown', () => {
    expect(
      diagnostics('on t n\n let <<n: n bytes>> be nothing\nend t'),
    ).toEqual([['unknown name', 2, 11]]);
    expect(
      diagnostics(
        'on t\n let <<len: uint16, body: (len + other) bytes, other: uint16>> be nothing\nend t',
      ),
    ).toEqual([['unknown name', 2, 34]]);
  });

  test('Text Pattern captures in values do not declare body locals', () => {
    expect(
      diagnostics('on t\n put <x: digit> into p\n return x\nend t'),
    ).toEqual([['unknown name', 3, 9]]);
  });

  test('repeated Handler clauses each get their own locals', () => {
    const result = checkSource(
      'on t x\n return x\nend t\non t x\n return x\nend t',
    );
    expect(result.ok).toBe(true);
    const params = names(result.tree!.root).filter(
      name => name.role === 'binding',
    );
    expect(params[0]!.binding?.id).not.toBe(params[1]!.binding?.id);
  });

  test('unknown imports identify the missing Library or export', () => {
    expect(diagnostics('use f from absent\nuse absent from text')).toEqual([
      ['unknown import', 1, 12],
      ['unknown import', 2, 5],
    ]);
  });

  test('Replace captures survive grouping while spliced patterns do not declare captures', () => {
    expect(
      diagnostics(
        'on t\n put replace (<x: digit>) in "1" with x into y\nend t',
      ),
    ).toEqual([]);
    expect(
      diagnostics(
        'on t\n put replace <(<x: digit>)> in "1" with x into y\nend t',
      ),
    ).toEqual([['unknown name', 2, 41]]);
  });

  test('singular Binary Pattern size units resolve names', () => {
    for (const unit of ['byte', 'bit']) {
      expect(
        diagnostics(`on t\n let <<body: absent ${unit}>> be nothing\nend t`),
      ).toEqual([['unknown name', 2, 14]]);
      expect(
        diagnostics(
          `on t\n let <<len: uint16, body: len ${unit}>> be nothing\nend t`,
        ),
      ).toEqual([]);
    }
  });

  test('Library export metadata does not use inherited JavaScript properties', () => {
    const result = checkSource('use f from toString', { libraries: {} });
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([['unknown import', 1, 12]]);
  });

  test('all Standard Library sources pass the implemented name checks', () => {
    const directory = resolve(import.meta.dir, '../../../spec/stdlib');
    for (const path of new Bun.Glob('*.talk').scanSync({ cwd: directory })) {
      const result = checkSource(
        readFileSync(resolve(directory, path), 'utf8'),
        { unit: 'library' },
      );
      expect(result.error).toBeNull();
      expect(result.diagnostics).toEqual([]);
    }
  });
});

describe('Core binding and function contracts', () => {
  test('Constants reject every Container write at its root', () => {
    const commands = [
      'put 1 into c',
      'put 1 after c',
      'put 1 before c',
      'add 1 to c',
      'subtract 1 from c',
      'multiply c by 2',
      'divide c by 2',
      'delete c',
      'replace <digit> in c with "x"',
      'put 1 into item 1 of c',
      'put 1 into the key of c',
      "put 1 into c's key",
    ];
    for (const command of commands) {
      const source = `constant c = "1"\non t\n ${command}\nend t`;
      expect(diagnostics(source)).toEqual([
        ["can't write", 3, command.lastIndexOf('c') + 2],
      ]);
    }
  });

  test('imported Constants keep their binding when written through a rename', () => {
    const result = checkSource(
      'use epoch from date as origin\non t\n put 1 into origin\nend t',
    );
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([["can't write", 3, 13]]);
    const references = names(result.tree!.root).filter(
      name => name.text === 'origin',
    );
    expect(references[1]!.binding).toBe(references[0]!.binding);
  });

  test('writes to captured parameters and locals are read-only, including nested Lambdas', () => {
    expect(
      diagnostics(
        'on t x\n put 1 into y\n put given\n  add 1 to x\n  put given\n   delete the key of y\n  end given into nested\n end given into f\nend t',
      ),
    ).toEqual([
      ["can't write", 4, 12],
      ["can't write", 6, 22],
    ]);
  });

  test('Lambda locals, parameters, Script Variables and shadowed Built-ins remain writable', () => {
    expect(
      diagnostics(
        'script variable live\non t x\n put given x\n  put 1 into x\n  let own be 0\n  add 1 to own\n  put 1 into fresh\n  put 1 into live\n  put 1 into pi\n  return it\n end given into f\nend t',
      ),
    ).toEqual([]);
  });

  test('set rejects bare variables but accepts key paths for later kind checks', () => {
    expect(
      diagnostics(
        "on t\n set x to 1\n set the key of x to 2\n set x's key to 3\nend t",
      ),
    ).toEqual([['not a property', 2, 2]]);
    expect(diagnostics('constant c = 1\non t\n set c to 2\nend t')).toEqual([
      ['not a property', 3, 2],
      ["can't write", 3, 6],
    ]);
  });

  test('named calls enforce required and total parameter counts, including forward calls', () => {
    expect(
      diagnostics(
        'on t\n f()\n f(1)\n f(1, 2)\n f(1, 2, 3)\n f(1, 2, 3, 4)\n zero()\n zero(1)\nend t\nfunction f x, y = 2, z = 3\n return x\nend f\nfunction zero\nend zero',
      ),
    ).toEqual([
      ['wrong argument count', 2, 2],
      ['wrong argument count', 6, 2],
      ['wrong argument count', 8, 2],
    ]);
    expect(diagnostics('function f x\n return f()\nend f')).toEqual([
      ['wrong argument count', 2, 9],
    ]);
    expect(diagnostics('function f x = 1\n return f()\nend f')).toEqual([]);
  });

  test('Built-in and Standard Library contracts include optional arguments and renames', () => {
    expect(
      diagnostics(
        'use sortBy from list as ordered\non t\n put round() into x\n put round(1) into x\n put round(1, 2, "half up", 4) into x\n put ordered([]) into x\n put ordered([], given x: x) into x\n put ordered([], given x: x, "descending") into x\nend t',
      ),
    ).toEqual([
      ['wrong argument count', 3, 6],
      ['wrong argument count', 5, 6],
      ['wrong argument count', 6, 6],
    ]);
  });

  test('registered Library function contracts survive import renames', () => {
    const result = checkSource(
      'use f from helpers as renamed\non t\n renamed()\n renamed(1)\n renamed(1, 2)\n renamed(1, 2, 3)\nend t',
      {
        libraries: {
          helpers: {
            f: { kind: 'function', contract: { required: 1, total: 2 } },
          },
        },
      },
    );
    expect(result.error).toBeNull();
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([
      ['wrong argument count', 3, 2],
      ['wrong argument count', 6, 2],
    ]);
    expect(
      names(result.tree!.root).find(name => name.role === 'call')!.binding,
    ).toMatchObject({ contract: { required: 1, total: 2 } });
  });

  test('calls through variables and Handler clauses defer arity to run time', () => {
    expect(
      diagnostics(
        'on t min\n put named into f\n put given x: x into g\n return [f(), g(), min(), t()]\nend t\nfunction named x\n return x\nend named',
      ),
    ).toEqual([]);
  });

  test('every required parameter after a default reports default order at that parameter', () => {
    expect(diagnostics('function f a = 1, b, c = 3, d\nend f')).toEqual([
      ['default order', 1, 19],
      ['default order', 1, 29],
    ]);
  });

  test('initializers and defaults allow literals, earlier Constants and Built-ins', () => {
    expect(
      diagnostics(
        'constant first = 2\nconstant second = round(first + pi)\nscript variable value = [second, {key: the length of "😀"}, <digit>, <<1 as uint8>>]\nfunction f a = first, b = round(2, 1), c = {key: newline}\nend f',
      ),
    ).toEqual([]);
    expect(
      diagnostics(
        'use epoch from date\nconstant origin = epoch\nfunction f x = origin\nend f',
      ),
    ).toEqual([]);
  });

  test('literal map keys and property names are not forbidden runtime references', () => {
    expect(
      diagnostics(
        'constant c = {me: 1, it: 2}\nconstant d = the me of c\nfunction f x = the it of c\nend f',
      ),
    ).toEqual([]);
    expect(diagnostics('constant c = ["me", "it"]')).toEqual([]);
  });

  test('Lambda literals defer their bodies but cannot capture parameters in defaults', () => {
    expect(
      diagnostics(
        'script variable live\nconstant identity = given x: x\nscript variable callback = given x: live + x\nfunction f action = given x: helper(x)\nend f\nfunction helper x\n return x\nend helper',
      ),
    ).toEqual([]);
    expect(
      diagnostics(
        'function f a, callback = given x: given y: a + x + y\nend f',
      ),
    ).toEqual([['not constant', 1, 44]]);
  });

  test('initializers reject forward and self references at the first forbidden token', () => {
    expect(
      diagnostics(
        'constant a = b + a\nconstant b = 1\nscript variable v = v\nfunction f x = later\nend f\nconstant later = 2',
      ),
    ).toEqual([
      ['not constant', 1, 14],
      ['not constant', 3, 21],
      ['not constant', 4, 16],
    ]);
  });

  test('defaults reject parameters, Script Variables and user functions, including bare Function Values', () => {
    expect(
      diagnostics(
        'script variable v\nfunction f a, b = a, c = v, d = helper(), e = helper\nend f\nfunction helper\nend helper',
      ),
    ).toEqual([
      ['not constant', 2, 19],
      ['not constant', 2, 26],
      ['not constant', 2, 33],
      ['not constant', 2, 47],
    ]);
  });

  test('runtime-only constructs are forbidden even without ordinary name references', () => {
    const expressions = ['me', 'it', 'the target'];
    for (const expression of expressions) {
      expect(diagnostics(`constant c = ${expression}`)).toContainEqual([
        'not constant',
        1,
        14,
      ]);
    }
    expect(diagnostics('constant c = missing + me')).toEqual([
      ['unknown name', 1, 14],
      ['not constant', 1, 14],
    ]);
    expect(diagnostics('constant c = f()\nfunction f x\nend f')).toEqual([
      ['wrong argument count', 1, 14],
      ['not constant', 1, 14],
    ]);
  });

  test('contract diagnostics retain scalar columns, UTF-16 spans and catalogue ordering', () => {
    const source =
      'constant c = 1\r\non t\r\n\tput ["😀", f()] into c\r\nend t\r\nfunction f a = me, b\r\nend f';
    const result = checkSource(source);
    expect(result.error).toBeNull();
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([
      ['wrong argument count', 3, 12],
      ["can't write", 3, 22],
      ['not constant', 5, 16],
      ['default order', 5, 20],
    ]);
    expect(result.diagnostics[0]!.span).toEqual({
      start: source.indexOf('f()'),
      end: source.indexOf('f()') + 1,
      line: 3,
      col: 12,
    });
  });
});

describe('Core control-flow and body-context checks', () => {
  test('exit repeat and next repeat outside any loop report at their first token', () => {
    expect(
      diagnostics(
        'on t\n exit repeat\n if true then next repeat\n repeat 2 times\n  exit repeat\n end repeat\n next repeat\nend t\nfunction f\n exit repeat\nend f',
      ),
    ).toEqual([
      ['outside a loop', 2, 2],
      ['outside a loop', 3, 15],
      ['outside a loop', 7, 2],
      ['outside a loop', 10, 2],
    ]);
  });

  test('a Lambda body has its own loops, so an enclosing loop does not count', () => {
    expect(
      diagnostics(
        'on t xs\n repeat for each x in xs\n  put given\n   next repeat\n   repeat forever\n    exit repeat\n   end repeat\n  end given into f\n end repeat\nend t',
      ),
    ).toEqual([['outside a loop', 4, 4]]);
  });

  test('next stays a Command Call name unless repeat follows', () => {
    expect(diagnostics('on t\n next 1\nend t')).toEqual([]);
  });

  test('return, veto and pass inside finally leave cleanup', () => {
    expect(
      diagnostics(
        'on t\n try\n  return 1\n catch e\n  return 2\n finally\n  if true then veto\n  return 3\n end try\nfinally\n pass t\nend t',
      ),
    ).toEqual([
      ['leaves finally', 7, 16],
      ['veto outside a decision', 7, 16],
      ['leaves finally', 8, 3],
      ['leaves finally', 11, 2],
    ]);
    expect(
      diagnostics('function f\n try\n finally\n  return 1\n end try\nend f'),
    ).toEqual([['leaves finally', 4, 3]]);
  });

  test('loop transfers may stay inside finally but not reach a loop outside it', () => {
    expect(
      diagnostics(
        'on t\n repeat 2 times\n  try\n  finally\n   next repeat\n   repeat 3 times\n    exit repeat\n    try\n    finally\n     next repeat\n    end try\n   end repeat\n   exit repeat\n  end try\n end repeat\nend t',
      ),
    ).toEqual([
      ['leaves finally', 5, 4],
      ['leaves finally', 10, 6],
      ['leaves finally', 13, 4],
    ]);
  });

  test('a loop inside a nested finally may be left from within that finally', () => {
    expect(
      diagnostics(
        'on t\n try\n finally\n  repeat 2 times\n   try\n   finally\n    repeat 2 times\n     next repeat\n    end repeat\n   end try\n   exit repeat\n  end repeat\n end try\nend t',
      ),
    ).toEqual([]);
  });

  test('a Lambda inside finally returns from itself and has its own loops', () => {
    expect(
      diagnostics(
        'on t\n repeat 2 times\n  try\n  finally\n   put given x\n    repeat 2 times\n     exit repeat\n    end repeat\n    exit repeat\n    return x\n   end given into f\n  end try\n end repeat\nend t',
      ),
    ).toEqual([['outside a loop', 9, 5]]);
  });

  test('pass and the target are rejected inside any Lambda, however nested', () => {
    expect(
      diagnostics(
        'on t\n put the target into a\n put the target of a into b\n put given: the target into f\n put given x\n  put given: [x, the target] into g\n  pass t\n end given into h\n pass t\nend t',
      ),
    ).toEqual([
      ['not in a lambda', 4, 13],
      ['not in a lambda', 6, 18],
      ['not in a lambda', 7, 3],
    ]);
  });

  test('pass in a Lambda inside finally reports only that it is in a Lambda', () => {
    expect(
      diagnostics(
        'on t\n try\n finally\n  put given\n   pass other\n  end given into f\n end try\nend t',
      ),
    ).toEqual([['not in a lambda', 5, 4]]);
  });

  test('Lambdas in initializers and defaults may not use the target', () => {
    expect(
      diagnostics(
        'constant c = given: the target\nfunction f a = given: the target\nend f',
      ),
    ).toEqual([
      ['not in a lambda', 1, 21],
      ['not in a lambda', 2, 23],
    ]);
  });

  test('pass must name the message of its enclosing Handler, case-sensitively', () => {
    expect(
      diagnostics(
        'on greet\n pass greet\n if true then pass Greet else pass other\nend greet\non error\n pass error\nfinally\n pass greet\nend error',
      ),
    ).toEqual([
      ['wrong message', 3, 20],
      ['wrong message', 3, 36],
      ['leaves finally', 8, 2],
      ['wrong message', 8, 7],
    ]);
  });

  test('each Handler clause checks pass against its own message', () => {
    expect(
      diagnostics(
        'on a\n pass a\nend a\non b\n pass a\nend b\non a x\n pass a\nend a',
      ),
    ).toEqual([['wrong message', 5, 7]]);
  });

  test('a Fallback Handler passes only `any message`, and only it may', () => {
    expect(
      diagnostics(
        'on any message m\n pass any message\n pass jump\n put given: 1 into f\nend any message\non jump\n pass any message\nend jump\non any message m, deciding\nend\non any message m\n put given\n  pass any message\n end given into f\nend',
      ),
    ).toEqual([
      ['wrong message', 3, 7],
      ['wrong message', 7, 7],
      ['bad suffixes', 9, 19],
      ['not in a lambda', 13, 3],
    ]);
  });

  test('a Library may not hold a Fallback Handler', () => {
    const result = checkSource('on any message m\n return 1\nend any message', {
      unit: 'library',
    });
    expect(
      result.diagnostics.map(d => [d.code, d.span.line, d.span.col]),
    ).toEqual([['not in a library', 1, 1]]);
  });

  test('`any` before anything but `message` still names a Handler', () => {
    expect(diagnostics('on any x\n pass any\nend any')).toEqual([]);
  });

  test('valid Handler suffix combinations are accepted', () => {
    expect(
      diagnostics(
        'on a, queued\nend a\non b x, dropping, deciding\nend b\non c, deciding, replacing\nend c\non error e where true, queued, during msg\nend error',
      ),
    ).toEqual([]);
  });

  test('bad suffixes reports the first suffix that breaks a combining rule', () => {
    const heads = [
      ['on a, queued, dropping', 15],
      ['on a, dropping, replacing, queued', 17],
      ['on a, deciding, deciding', 17],
      ['on a, queued, deciding', 15],
      ['on a, deciding, queued', 17],
      ['on a, during m', 7],
      ['on a x, deciding, during m, during n', 19],
      ['on error, during m, during n', 21],
    ] as const;
    for (const [head, col] of heads) {
      const name = head.slice(3, head.indexOf(','));
      const message = name.split(' ')[0];
      expect(diagnostics(`${head}\nend ${message}`)).toEqual([
        ['bad suffixes', 1, col],
      ]);
    }
  });

  test('control diagnostics interleave by position with scalar columns and UTF-16 spans', () => {
    const source =
      'on t, queued, queued\r\n\tput ["😀", absent] into x\r\n\texit repeat\r\n\tput given: the target into f\r\nfinally\r\n\tpass u\r\nend t';
    const result = checkSource(source);
    expect(result.error).toBeNull();
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([
      ['bad suffixes', 1, 15],
      ['unknown name', 2, 12],
      ['outside a loop', 3, 2],
      ['not in a lambda', 4, 13],
      ['leaves finally', 6, 2],
      ['wrong message', 6, 7],
    ]);
    const pass = source.indexOf('pass');
    expect(
      result.diagnostics.find(({ code }) => code === 'leaves finally')!.span,
    ).toEqual({ start: pass, end: pass + 4, line: 6, col: 2 });
    const the = source.indexOf('the target');
    expect(
      result.diagnostics.find(({ code }) => code === 'not in a lambda')!.span,
    ).toEqual({ start: the, end: the + 3, line: 4, col: 13 });
  });
});

/** The 1-based line and scalar column of the nth occurrence of `needle`. */
const at = (source: string, needle: string, nth = 1): [number, number] => {
  let offset = -1;
  for (let count = 0; count < nth; count++) {
    offset = source.indexOf(needle, offset + 1);
  }
  expect(offset).toBeGreaterThanOrEqual(0);
  const lines = source.slice(0, offset).split(/\r\n|\r|\n/);
  return [lines.length, [...lines.at(-1)!].length + 1];
};
type Expected = [DiagnosticCode, string, number?];
const expectAt = (source: string, expected: Expected[], options = {}) => {
  const result = checkSource(source, options);
  expect(result.error).toBeNull();
  expect(
    result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
  ).toEqual(
    expected.map(([code, needle, nth]) => [code, ...at(source, needle, nth)]),
  );
};

/** One `as number` after 3000 nested Text Patterns around `atom`. */
const nested = (atom: string) =>
  `on t\n put < ${'< '.repeat(3000)}${atom}${'>'.repeat(3000)} as number> into a\nend t`;

describe('Core construct and Guard checks', () => {
  test('map literals report the second of two equal keys after NFC', () => {
    expectAt(
      'on t\n put {a: 1, "a": 2, b: 3, "\u00e9": 4, "e\u0301": 5, b: 6} into m\n let {a: x, a: y} be m\nend t',
      [
        ['duplicate key', '"a"'],
        ['duplicate key', '"e\u0301"'],
        ['duplicate key', 'b: 6'],
      ],
    );
  });

  test('number literals beyond the limits report the literal, in patterns and builds too', () => {
    const fraction = `0.${'0'.repeat(6176)}`;
    expect(
      diagnostics(
        `on t\n put ${'9'.repeat(34)} + 0.${'1'.repeat(34)} + ${fraction} + 0x1ed09bead87c0378d8e63ffffffff + 0x000${'f'.repeat(28)} into a\nend t`,
      ),
    ).toEqual([]);
    const bad = [
      '1'.repeat(35),
      `1${'0'.repeat(34)}`,
      `1.${'0'.repeat(34)}`,
      `0.${'0'.repeat(6177)}`,
      `0x${'f'.repeat(29)}`,
      '0x1ed09bead87c0378d8e6400000000',
    ];
    for (const literal of bad) {
      expect(diagnostics(`on t\n put ${literal} into a\nend t`)).toEqual([
        ['bad number', 2, 6],
      ]);
    }
    const long = '1'.repeat(35);
    expectAt(
      `on t x\n match x\n  when -${long} then put 1 into y\n end match\n put <<${long}>> & <${long} "a"> into z\nend t`,
      [
        ['bad number', long, 1],
        ['bad number', long, 2],
        ['bad number', long, 3],
      ],
    );
  });

  test('kind tests and conversions accept chapter 3 kinds, integer tests and Units', () => {
    expect(
      diagnostics(
        'on t x\n put [x is a number, x is not an integer, x is a civil date, x is a function, x can be a kg, x can be km, x can be a text, x can be a list] into a\n put x as text as bytes as civil date as instant as number as kg as km/hr into b\nend t',
      ),
    ).toEqual([]);
  });

  test('unknown kinds report the kind name, and `as` with no conversion reports `as`', () => {
    const source =
      'on t x\n put [x is a length, x is a kg, x can be integer, x can be a widget] into a\n put x as integer into b\n put x as list as map into c\nend t';
    expectAt(source, [
      ['unknown kind', 'length'],
      ['unknown kind', 'kg'],
      ['unknown kind', 'integer'],
      ['unknown kind', 'widget'],
      ['unknown kind', 'integer', 2],
      ['no conversion', 'as list'],
      ['no conversion', 'as map'],
    ]);
    // `nothing` is reserved, so `as nothing` is already a syntax error.
    for (const kind of [...unconvertibleKinds].filter(
      kind => kind !== 'nothing',
    )) {
      expect(diagnostics(`on t x\n put x as ${kind} into b\nend t`)).toEqual([
        ['no conversion', 2, 8],
      ]);
    }
  });

  test('chapter 3 kind tables match the checker', () => {
    const chapter = readFileSync(
      resolve(import.meta.dir, '../../../spec/03-values.md'),
      'utf8',
    );
    const kinds = chapter
      .slice(chapter.indexOf('## Kinds'), chapter.indexOf('- **Kind names:**'))
      .matchAll(/^\| `([ a-z]+)` \|/gm);
    expect(new Set([...kinds].map(match => match[1]))).toEqual(
      new Set(kindNames),
    );
    const unconvertible = chapter.match(
      /\*\*Kinds with no conversion:\*\* `as` with any other kind name \(([^)]*)\)/,
    )![1]!;
    expect(
      new Set([...unconvertible.matchAll(/`([ a-z]+)`/g)].map(m => m[1])),
    ).toEqual(new Set(unconvertibleKinds));
  });

  test('ignoring case after kind and emptiness tests has nothing to fold', () => {
    expectAt(
      'on t x\n put [x is a text ignoring case, x is not empty ignoring case, x can be a number ignoring case, x is "A" ignoring case, x is in ["a"] ignoring case, x contains "a" ignoring case] into a\nend t',
      [
        ['nothing to fold', 'ignoring', 1],
        ['nothing to fold', 'ignoring', 2],
        ['nothing to fold', 'ignoring', 3],
      ],
    );
  });

  test('delimited by needs an item chunk or the items property in its chain', () => {
    expect(
      diagnostics(
        'on t s\n put [item 2 of s delimited by ";", word 1 of item 2 of s delimited by ";", items 1..2 of line 1 of s delimited by ";", the last item of s delimited by ";", the items of s delimited by ";", s\'s items delimited by ";", the first word of item 3 of s delimited by ";"] into a\nend t',
      ),
    ).toEqual([]);
    expectAt(
      'on t s\n put [word 1 of s delimited by ";", the lines of s delimited by ";", the first word of s delimited by ";", line 1 of word 2 of s delimited by ";", s\'s lines delimited by ";", the code points of s delimited by ";"] into a\nend t',
      [1, 2, 3, 4, 5, 6].map(
        nth => ['no item chunk', 'delimited', nth] as Expected,
      ),
    );
  });

  test('Text Pattern Captures inside any repetition report the Capture name', () => {
    expectAt(
      'on t s\n put [<n: digit, rest: text>, <one or more of <a: digit>>, <zero or more of <<b: digit>>>, <optional <c: "x" or d: "y">>, <3 <e: letter>>, <2 <f: <g: digit>>>] into a\nend t',
      [
        ['capture in repetition', 'a:'],
        ['capture in repetition', 'b:'],
        ['capture in repetition', 'c:'],
        ['capture in repetition', 'd:'],
        ['capture in repetition', 'e:'],
        ['capture in repetition', 'f:'],
        ['capture in repetition', 'g:'],
      ],
    );
  });

  test('a Text Pattern spliced inside a repetition is checked as its own pattern', () => {
    expect(
      diagnostics('on t\n put <one or more of (<n: digit>)> into a\nend t'),
    ).toEqual([]);
  });

  test('Typed Elements allow only a number', () => {
    expectAt('on t\n put <a number, an text, a date> into a\nend t', [
      ['unknown kind', 'text'],
      ['unknown kind', 'date'],
    ]);
  });

  test('Text Pattern as number needs an element that matches only ASCII digits', () => {
    expect(
      diagnostics(
        'on t\n put <a number as number, digits as number, digit as number, "42" as number, one or more of digit as number, 4 digits as number, <digit, optional digit> as number, n: digits as number, <"1" or "2"> as number, digits lazily as number> into a\nend t',
      ),
    ).toEqual([]);
    expectAt(
      'on t\n put <letters as number, "4a" as number, "" as number, optional digit as number, zero or more of digit as number, 0 digit as number, <text start> as number, ("1") as number, <"1" or "x"> as number, <a number, digit> as number, digits as text, digits as widget> into a\nend t',
      [
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(
          nth => ['no conversion', 'as ', nth] as Expected,
        ),
        ['unknown kind', 'widget'],
      ],
    );
  });

  test('as number checks deeply nested Text Patterns without recursion', () => {
    expect(diagnostics(nested('digit'))).toEqual([]);
    expectAt(nested('letter'), [['no conversion', 'as number']]);
  });

  test('a rest that is not last reports its `...`', () => {
    expectAt(
      'on t v\n match v\n  when [a, ...] then put 1 into x\n  when [..., b] then put 1 into x\n  when [...r, c, ...s] then put 1 into x\n  when <<..., d: uint8>> then put 1 into x\n  when <<e: uint8, ...f as text>> then put 1 into x\n end match\n put [...v, 1] into y\nend t',
      [
        ['rest not last', '..., b'],
        ['rest not last', '...r'],
        ['rest not last', '..., d'],
      ],
    );
  });

  test('each run of bit fields adds up to whole bytes, reported at its first field', () => {
    expectAt(
      'on t v\n match v\n  when <<a: 4 bits, b: 4 bits, c: uint8, d: 1 bit, e: 7 bits>> then put 1 into x\n  when <<f: 3 bits, g: uint8, h: 5 bits>> then put 1 into x\n  when <<_: 9 bits, i: 1 byte, j: 2 bits, k: 6 bit, l: 1 bits>> then put 1 into x\n end match\n put <<1 as 4 bits, 2 as 4 bits, 6 as uint8, 30 as 3 bits, 4 as uint8, 50 as 5 bits>> into y\nend t',
      [
        ['bits not whole bytes', 'f:'],
        ['bits not whole bytes', 'h:'],
        ['bits not whole bytes', '_:'],
        ['bits not whole bytes', 'j:'],
        ['bits not whole bytes', '30'],
        ['bits not whole bytes', '50'],
      ],
    );
  });

  test('private starts a declaration only in a Library', () => {
    const source =
      'private function f\nend f\nprivate constant c = 1\nprivate on h\nend h';
    expect(diagnostics(source)).toEqual([
      ['not in a script', 1, 1],
      ['not in a script', 3, 1],
      ['not in a script', 4, 1],
    ]);
    expect(checkSource(source, { unit: 'library' }).diagnostics).toEqual([]);
  });

  test('Guards may call Built-ins and read locals, ids, keys and Built-in properties', () => {
    const result = checkSource(
      "script variable limit = 3\non t x where abs(x) > limit and x's count < power(1, 2) and me's id = the id of button and the length of me = 0 and the target = button\n match x\n  when [a] where a is in the keys of x then put 1 into y\n end match\nend t",
      { objects: ['button'] },
    );
    expect(result.diagnostics).toEqual([]);
  });

  test('Guards reject non-Built-in calls, Lambdas and Host Object properties other than id', () => {
    const source =
      'function f x\n return x\nend f\non t x where f(x) and abs(x) > 0\n try\n  put 1 into y\n catch e where abs(given v: v) or the name of me = "a"\n  put 2 into y\n end try\n match x\n  when n where button\'s label = n or the "label" of the target = n or the "id" of button = n then put 3 into y\n end match\nend t\non u upper where upper(1)\nend u';
    expectAt(
      source,
      [
        ['not in a guard', 'f(x)'],
        ['not in a guard', 'given'],
        ['not in a guard', 'the name'],
        ['not in a guard', "'s label"],
        ['not in a guard', 'the "label"'],
        ['not in a guard', 'upper(1)'],
      ],
      { objects: ['button'] },
    );
  });

  test('construct diagnostics keep scalar columns, UTF-16 spans and catalogue order', () => {
    const source = `private on t\r\n\tput ["😀", {a: 1, a: 2}, x as list, 1${'0'.repeat(34)}] into y\r\nend t`;
    const result = checkSource(source);
    expect(result.error).toBeNull();
    expect(
      result.diagnostics.map(({ code, span }) => [code, span.line, span.col]),
    ).toEqual([
      ['not in a script', 1, 1],
      ['duplicate key', 2, 19],
      ['unknown name', 2, 26],
      ['no conversion', 2, 28],
      ['bad number', 2, 37],
    ]);
    const key = source.indexOf('a: 2');
    expect(
      result.diagnostics.find(({ code }) => code === 'duplicate key')!.span,
    ).toEqual({ start: key, end: key + 1, line: 2, col: 19 });
  });
});

describe('collecting targets', () => {
  test('are whole-body locals readable before, during and after the loop', () => {
    expect(
      checkSource(
        'on t\n say acc\n repeat while the length of acc < 2 collecting 1 into acc\n say acc\n end repeat\n return acc\nend t',
      ).ok,
    ).toBe(true);
  });
  test('clash with globals and their own iteration binding', () => {
    expect(
      diagnostics(
        'script variable acc\non t\n repeat 0 times collecting 1 into acc\n end repeat\nend t',
      ),
    ).toEqual([['name clash', 3, 35]]);
    expect(
      diagnostics(
        'on t\n repeat for each acc in [] collecting acc into acc\n end repeat\nend t',
      ),
    ).toEqual([['name clash', 2, 48]]);
  });
  test('reject body writes, pattern bindings and nested collecting targets', () => {
    for (const [body, col] of [
      ['put 1 into acc', 13],
      ['put 1 into item 1 of acc', 23],
      ['let [acc] be []', 7],
      ['repeat 0 times collecting 1 into acc\n end repeat', 35],
    ] as const) {
      expect(
        diagnostics(
          `on t\n repeat 1 times collecting 1 into acc\n ${body}\n end repeat\nend t`,
        ),
      ).toEqual([["can't write", 3, col]]);
    }
  });
  test('clashes with Constants and well-known objects at the later name', () => {
    expect(
      diagnostics(
        'constant acc = 1\non t\n repeat 0 times collecting 1 into acc\n end repeat\nend t',
      ),
    ).toEqual([['name clash', 3, 35]]);
    expect(
      diagnostics(
        'on t\n repeat 0 times collecting 1 into acc\n end repeat\nend t\nconstant acc = 1',
      ),
    ).toEqual([['name clash', 5, 10]]);
    const checked = checkSource(
      'on t\n repeat 0 times collecting 1 into acc\n end repeat\nend t',
      { objects: ['acc'] },
    );
    expect(checked.error).toBeNull();
    expect(
      checked.diagnostics.map(d => [d.code, d.span.line, d.span.col]),
    ).toEqual([['name clash', 2, 35]]);
  });
  test('protects iteration, catch and capture bindings as well as arithmetic writes', () => {
    for (const [body, line, col] of [
      ['repeat for each acc in []\n end repeat', 3, 18],
      ['try\n catch acc\n end try', 4, 8],
      ['add 1 to acc', 3, 11],
      ['put given\n put [] into acc\n end given into f', 4, 14],
      ['let <acc: digit> be "1"', 3, 7],
    ] as const) {
      expect(
        diagnostics(
          `on t\n repeat 1 times collecting 1 into acc\n ${body}\n end repeat\nend t`,
        ),
      ).toEqual([["can't write", line, col]]);
    }
  });
  test('may shadow a local Handler name', () => {
    expect(
      checkSource(
        'on t\n repeat 1 times collecting 1 into t\n end repeat\n return t\nend t',
      ).ok,
    ).toBe(true);
  });
  test('allows writes after the loop and Lambda locals that shadow the target', () => {
    expect(
      checkSource(
        'on t\n repeat 1 times collecting 1 into acc\n put given acc: acc into f\n end repeat\n put [] into acc\nend t',
      ).ok,
    ).toBe(true);
  });
});

// A `tell` block's lines are checked as the one-line calls they stand for
// (ADR 0063).
const tellBlockDiagnostics = (source: string, options = {}) =>
  checkSource(source, options).diagnostics.map(d => [
    d.code,
    d.span.line,
    d.span.col,
  ]);

describe('tell blocks', () => {
  test('apply suspension rules to a waiting line at its Operation name', () => {
    expect(
      tellBlockDiagnostics(
        'function f\n tell feed\n  fetch 1 and wait\n end tell\nend f',
      ),
    ).toEqual([["can't suspend here", 3, 3]]);
    expect(
      tellBlockDiagnostics(
        'on fetchIt\n tell feed\n  fetch 1 and wait\n end tell\nend fetchIt\non go\n fetchIt\nend go',
      ),
    ).toEqual([['missing and wait', 7, 2]]);
    expect(
      tellBlockDiagnostics(
        'on t\n wait for all\n  try\n   tell feed\n    fetch 1 and wait\n   end tell\n  catch e\n  end try\n end wait\nend t',
      ),
    ).toEqual([['not in a join', 5, 5]]);
    expect(
      tellBlockDiagnostics(
        'on t\n wait for all\n  tell feed\n   fetch 1 and wait\n  end tell\n end wait\nend t',
      ),
    ).toEqual([]);
    expect(tellBlockDiagnostics('on t\n tell feed\n end tell\nend t')).toEqual(
      [],
    );
  });

  test('call each line as its Operation mode allows, and report a missing Grant once', () => {
    const source =
      'on t\n tell till\n  price\n  note\n  fetch and wait\n end tell\n tell drawer\n  open\n  close\n end tell\nend t';
    const grants = {
      till: {
        price: { mode: 'immediate' as const, args: [] },
        note: { mode: 'fire-and-forget' as const, args: [] },
        fetch: { mode: 'suspending' as const, args: [] },
      },
    };
    expect(tellBlockDiagnostics(source, { grants })).toEqual([
      ['unknown operation', 7, 7],
    ]);
    const unit = compileSource(
      source.replace(/ tell drawer[^]*end tell\n/, ''),
      {
        name: 't',
        grants,
      },
    ).unit!;
    expect(
      unit.code
        .map(({ op }) => op)
        .filter(op => ['ask', 'tell', 'ask-wait'].includes(op)),
    ).toEqual(['ask', 'tell', 'ask-wait']);
  });
});

describe('Timeout Blocks', () => {
  test('refuse a Command Call that waits, outside a Lambda', () => {
    expect(
      tellBlockDiagnostics(
        'on b\n wait 1 s\nend b\non t\n with timeout of 1 s\n  b and wait\n  wait 1 s\n end timeout\nend t',
      ),
    ).toEqual([['not in a timeout', 6, 3]]);
    expect(
      tellBlockDiagnostics(
        'on t f\n with timeout of 1 s\n  put given\n   f() and wait\n  end given into g\n  send b to me and wait\n end timeout\nend t',
      ),
    ).toEqual([]);
  });

  test('need a Suspension Point outside a Lambda and a Join', () => {
    expect(
      tellBlockDiagnostics(
        'on t\n with timeout of 1 s\n  put given\n   wait 1 s\n  end given into f\n end timeout\nend t',
      ),
    ).toEqual([['empty timeout', 2, 2]]);
    expect(
      tellBlockDiagnostics(
        'on t\n wait for all\n  with timeout of 1 s\n   send x to me and wait\n  end timeout\n end wait\nend t',
      ),
    ).toEqual([['empty timeout', 3, 3]]);
    expect(
      tellBlockDiagnostics(
        'on t\n with timeout of 1 s\n  wait for all\n   send x to me and wait\n  end wait\n end timeout\nend t',
      ),
    ).toEqual([]);
  });
});

describe('Whose Clauses', () => {
  test('a Whose Key is no name read, and a later name is a local', () => {
    expect(
      diagnostics(
        'on t xs\n put 1 into amount\n return every item of xs whose amount > amount\nend t',
      ),
    ).toEqual([]);
    expect(
      diagnostics('on t xs\n return every item of xs whose amount > 1\nend t'),
    ).toEqual([]);
    expect(
      diagnostics(
        'on t xs\n return every item of xs whose amount > 1 and region is "EU"\nend t',
      ),
    ).toEqual([['unknown name', 2, 47]]);
    expect(
      diagnostics('on t xs\n return every item of xs whose (limit) > 1\nend t'),
    ).toEqual([['unknown name', 2, 33]]);
  });
  test('an unknown name in a condition suggests `it’s`', () => {
    const result = checkSource(
      'on t xs\n return the first item of xs whose it > 1 and region is "EU"\nend t',
    );
    expect(result.diagnostics.map(d => d.message)).toEqual([
      "unknown name: region; a key of the chunk is `it's region`",
    ]);
    expect(
      checkSource('on t\n return region\nend t').diagnostics[0]!.message,
    ).toBe('unknown name: region');
  });
  test('a condition calls only Built-ins and holds no Lambda', () => {
    expect(
      diagnostics(
        'function f x\n return x\nend f\non t xs\n return every item of xs whose f(it) and abs(it) > 1\nend t',
      ),
    ).toEqual([['not in a whose', 5, 32]]);
    expect(
      diagnostics(
        'on t xs\n put 1 into abs\n return every item of xs whose abs(it) > 1\nend t',
      ),
    ).toEqual([['not in a whose', 3, 32]]);
    expect(
      diagnostics(
        'function f x\n return x\nend f\non t xs\n return every item of xs whose (given: f(1)) is empty\nend t',
      ),
    ).toEqual([['not in a whose', 5, 33]]);
    // A nested clause's call is reported once, and its source is the outer
    // condition's.
    expect(
      diagnostics(
        'function f x\n return x\nend f\non t xs\n return every item of xs whose (every item of f(it) whose f(it)) is empty\nend t',
      ),
    ).toEqual([
      ['not in a whose', 5, 47],
      ['not in a whose', 5, 59],
    ]);
    // Only the condition is restricted.
    expect(
      diagnostics(
        'function f x\n return x\nend f\non t xs\n return every item of f(xs) whose it > 1\nend t',
      ),
    ).toEqual([]);
  });
  test('an Every Head with `delimited by` needs an `item` chunk', () => {
    expect(
      diagnostics(
        'on t s\n return every line of s delimited by ";" whose it is empty\nend t',
      ),
    ).toEqual([['no item chunk', 2, 25]]);
    expect(
      diagnostics(
        'on t s\n return every line of item 2 of s delimited by ";" whose it is empty\nend t',
      ),
    ).toEqual([]);
  });
});
