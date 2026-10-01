import { describe, expect, test } from 'bun:test';
import catalogue from '../spec/data/diagnostics.toml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkSource,
  checkSyntax,
  parseSource,
  syntaxText,
  type SemanticElement,
  type SemanticName,
} from '../src';

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
    expect(result.ok).toBe(true);
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
    const directory = resolve(import.meta.dir, '../spec/stdlib');
    for (const path of new Bun.Glob('*.talk').scanSync({ cwd: directory })) {
      const result = checkSource(
        readFileSync(resolve(directory, path), 'utf8'),
      );
      expect(result.error).toBeNull();
      expect(result.diagnostics).toEqual([]);
    }
  });
});
