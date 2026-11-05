import { describe, expect, test } from 'bun:test';
import { checkSource } from '../src/checker';
import { compileLibrary, newGroup, parseInstant } from '../src/index';

// Named Shapes (ADR 0168, spec chapter 7, Shape declarations).

const shapes = `shape Line is {sku: text, qty: number}
shape Money is GBP or USD
shape Invoice is {
  type: text,
  amount: Money,
  speed: m/s,
  span: a quantity of length,
  owner: object of Account,
  ref: optional text,
  note: (optional text),
  lines: list of Line,
  tags: list of (text or number),
  "made at": civil date,
  ...
}
shape Anything is {...}
shape Nested is list of list of object
shape Late is Early
shape Early is number or text`;

// The Trace of `go` putting `expr` into `out`, after `declarations`.
const trace = (declarations: string, expr: string, libraries = {}) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const compiled: ReturnType<typeof compileLibrary>[] = [];
  for (const [name, source] of Object.entries(libraries)) {
    compiled.push(
      compileLibrary(
        { name, source: source as string, version: '1' },
        compiled,
      ),
    );
    group.addLibrary(compiled.at(-1)!);
  }
  group
    .load({
      name: 's',
      source: `${declarations}\nscript variable out\non go\n  put ${expr} into out\nend go`,
    })
    .deliver({ name: 'go' });
  group.pump(parseInstant('2026-09-30T09:00:00Z'));
  group.inspect();
  return lines;
};
const value = (declarations: string, expr: string, libraries = {}) =>
  trace(declarations, expr, libraries)
    .at(-1)!
    .replace(/^vars s out=/, '');
const diagnostics = (source: string) =>
  checkSource(source).diagnostics.map(
    d => `${d.code} at ${d.span.line}:${d.span.col}`,
  );

describe('Shape declarations lower to Shape data', () => {
  test.each([
    [
      'Line',
      '{map: [{key: "sku", shape: "text"}, {key: "qty", shape: "number"}]}',
    ],
    ['Money', '{oneOf: [{quantity: "GBP"}, {quantity: "USD"}]}'],
    ['Anything', '{map: [], open: true}'],
    ['Nested', '{list: {list: "object"}}'],
    ['Late', '{oneOf: ["number", "text"]}'],
    [
      'Invoice',
      '{map: [{key: "type", shape: "text"}, {key: "amount", shape: {oneOf: [{quantity: "GBP"}, {quantity: "USD"}]}}, {key: "speed", shape: {quantity: "m/s"}}, {key: "span", shape: {unitKind: "length"}}, {key: "owner", shape: {object: "Account"}}, {key: "ref", shape: "text", optional: true}, {key: "note", shape: {optional: "text"}}, {key: "lines", shape: {list: {map: [{key: "sku", shape: "text"}, {key: "qty", shape: "number"}]}}}, {key: "tags", shape: {list: {oneOf: ["text", "number"]}}}, {key: "made at", shape: "civil date"}], open: true}',
    ],
  ])('%s', (name, data) => {
    expect(value(shapes, name)).toBe(data);
  });

  test('the Shape check Built-ins take a named Shape unchanged', () => {
    expect(value(shapes, 'check({sku: "a", qty: 2}, Line)')).toBe(
      '{sku: "a", qty: 2}',
    );
  });
});

describe('`is a` with a named Shape is `conforms`', () => {
  test.each([
    ['{sku: "a", qty: 2} is a Line', 'true'],
    ['{sku: "a"} is a Line', 'false'],
    ['{sku: "a"} is not a Line', 'true'],
    ['5 GBP is a Money', 'true'],
    ['5 EUR is an Money', 'false'],
    ['"x" is a Late', 'true'],
    ['3 is a number', 'true'],
  ])('%s', (expr, result) => {
    expect(value(shapes, expr)).toBe(result);
  });

  test('a Library exports a Shape, and `is a` reads it through `use`', () => {
    const libraries = {
      orders:
        'shape Line is {sku: text, qty: number}\nshape Lines is list of Line',
    };
    const use = 'use Line, Lines from orders\nshape Order is {lines: Lines}';
    expect(value(use, '{sku: "a", qty: 2} is a Line', libraries)).toBe('true');
    expect(
      value(use, '{lines: [{sku: "a", qty: 2}]} is an Order', libraries),
    ).toBe('true');
    expect(value(use, 'Order', libraries)).toBe(
      '{map: [{key: "lines", shape: {list: {map: [{key: "sku", shape: "text"}, {key: "qty", shape: "number"}]}}}]}',
    );
  });

  test('Shape data in a plain Constant is not a kind after `is a`', () => {
    expect(
      diagnostics(
        'constant Line = "number"\non t x\n  put x is a Line into y\nend t',
      ),
    ).toEqual(['unknown kind at 3:14']);
  });
});

describe('bad shape', () => {
  test.each([
    [
      'a Name that is no kind, Unit or Shape',
      'shape S is {a: Missing}',
      '1:16',
    ],
    ['a plain Constant', 'constant C = "text"\nshape S is C', '2:12'],
    ['an unknown Unit Kind', 'shape S is a quantity of colour', '1:26'],
    ['a repeated key', 'shape S is {a: text, b: text, a: number}', '1:31'],
    ['a Shape named like a kind', 'shape text is number', '1:7'],
    ['a Shape named `any`', 'shape any is number', '1:7'],
    ['a Shape named like a Unit', 'shape GBP is number', '1:7'],
    ['a Shape named like a plural Unit', 'shape days is number', '1:7'],
    ['a Shape named like a Unit Kind', 'shape length is number', '1:7'],
    ['a Shape that names itself', 'shape S is list of S', '1:20'],
    [
      'a cycle, at its first Name in source order',
      'shape A is {b: B}\nshape B is list of A',
      '1:16',
    ],
  ])('%s', (_, source, at) => {
    expect(diagnostics(source)).toEqual([`bad shape at ${at}`]);
  });

  test('a clash with another declaration is `name clash`', () => {
    expect(diagnostics('constant S = 1\nshape S is text')).toEqual([
      'name clash at 2:7',
    ]);
  });

  test('`private shape` is a load error in a Script, as `private constant` is', () => {
    expect(diagnostics('private shape S is text')).toEqual(
      diagnostics('private constant S = 1'),
    );
  });
});
