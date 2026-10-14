import { describe, expect, test } from 'bun:test';
import { decodeShape, shapeDiagnostics } from '../src/capabilities';
import {
  defineObjectKind,
  list,
  map,
  newGroup,
  num,
  parseInstant,
  text,
} from '../src/index';

// A Script's Trace for `go` putting `expr` into `out`, as in stdlib.test.ts.
const trace = (expr: string): string[] => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  group
    .load({
      name: 's',
      source: `script variable out\non go\n  put ${expr} into out\nend go`,
    })
    .deliver({ name: 'go' });
  group.pump(parseInstant('2026-09-30T09:00:00Z'));
  group.inspect();
  return lines;
};
// `expr`'s value, or its error map without `at`.
const value = (expr: string): string => {
  const lines = trace(expr);
  const run = lines.find(line => line.startsWith('run '))!;
  const error = run.match(/ error=({.*}) fuel=/);
  if (error) {
    return `error ${error[1]!.replace(/, at: {[^}]*}}$/, '}')}`;
  }
  return lines.at(-1)!.replace(/^vars s out=/, '');
};

describe('the Shape check Built-ins', () => {
  test.each([
    // Every scalar spelling, `any` and `value`.
    ['conforms(3, "number")', 'true'],
    ['conforms("x", "number")', 'false'],
    ['conforms(nothing, "nothing")', 'true'],
    ['conforms(true, "boolean")', 'true'],
    ['conforms(5 m, "quantity")', 'true'],
    ['conforms([1], "list")', 'true'],
    ['conforms({}, "map")', 'true'],
    ['conforms(1..2, "range")', 'true'],
    ['conforms(<<1>>, "bytes")', 'true'],
    ['conforms([given x: x], "any")', 'false'],
    ['conforms([given x: x], "value")', 'true'],
    ['conforms(given x: x, "function")', 'true'],
    // Wrappers: exact Units, Unit Kinds, lists, optional, unions.
    ['conforms(5 m, {quantity: "m"})', 'true'],
    ['conforms(5 cm, {quantity: "m"})', 'false'],
    ['conforms(500 cm, {quantity: "m"})', 'false'],
    ['conforms(5 m, {unitKind: "length"})', 'true'],
    ['conforms(5 m^2, {unitKind: "length"})', 'false'],
    ['conforms([1, 2], {list: "number"})', 'true'],
    ['conforms([1, "x"], {list: "number"})', 'false'],
    ['conforms(nothing, {optional: "text"})', 'true'],
    ['conforms(3, {oneOf: ["text", "number"]})', 'true'],
    ['conforms(true, {oneOf: ["text", "number"]})', 'false'],
    // Maps: open and closed, absent versus Optional.
    ['conforms({a: 1}, {map: [{key: "a", shape: "number"}]})', 'true'],
    ['conforms({a: 1, b: 2}, {map: [{key: "a", shape: "number"}]})', 'false'],
    [
      'conforms({a: 1, b: 2}, {map: [{key: "a", shape: "number"}], open: true})',
      'true',
    ],
    [
      'conforms({a: 1, b: [given x: x]}, {map: [{key: "a", shape: "number"}], open: true})',
      'false',
    ],
    ['conforms({}, {map: [{key: "a", shape: {optional: "text"}}]})', 'false'],
    [
      'conforms({}, {map: [{key: "a", shape: "text", optional: true}]})',
      'true',
    ],
    [
      'conforms({a: nothing}, {map: [{key: "a", shape: {optional: "text"}}]})',
      'true',
    ],
    // Explicit false flags and ignored metadata.
    [
      'conforms({a: 1}, {map: [{key: "a", shape: "number", optional: false}], open: false})',
      'true',
    ],
    ['conforms(3, {list: "number", note: "ignored"})', 'false'],
    ['conforms([3], {list: "number", note: [1, {deep: true}]})', 'true'],
    // `check` gives the value itself; `explain` gives records.
    ['check({a: 1}, {map: [{key: "a", shape: "number"}]})', '{a: 1}'],
    ['explain(3, "number")', '[]'],
    [
      'explain("x", "number")',
      '[{code: "wrong kind", expected: "number", got: "text", value: "x"}]',
    ],
    [
      'explain([1, "x", true], {list: "number"})',
      '[{code: "wrong kind", expected: "number", got: "text", value: "x", path: [2]}, {code: "wrong kind", expected: "number", got: "boolean", value: true, path: [3]}]',
    ],
    [
      'explain("x", {list: "number"})',
      '[{code: "wrong kind", expected: "list", got: "text", value: "x"}]',
    ],
    [
      'explain({}, {map: [{key: "a", shape: "number"}, {key: "b", shape: "text"}]})',
      '[{code: "wrong kind", expected: "number", got: "nothing", value: nothing, path: ["a"]}, {code: "wrong kind", expected: "text", got: "nothing", value: nothing, path: ["b"]}]',
    ],
    [
      'explain({a: 1, z: 2, y: 3}, {map: [{key: "a", shape: "number"}]})',
      '[{code: "wrong kind", expected: "nothing", got: "number", value: 2, path: ["z"]}, {code: "wrong kind", expected: "nothing", got: "number", value: 3, path: ["y"]}]',
    ],
    [
      'explain(true, {oneOf: ["text", {list: "number"}]})',
      '[{code: "wrong kind", expected: "text or list", got: "boolean", value: true, alternatives: [[{code: "wrong kind", expected: "text", got: "boolean", value: true}], [{code: "wrong kind", expected: "list", got: "boolean", value: true}]]}]',
    ],
    [
      'explain(3, {optional: "text"})',
      '[{code: "wrong kind", expected: "text or nothing", got: "number", value: 3}]',
    ],
    [
      'explain([given x: x], "any")',
      '[{code: "not encodable", kind: "function", path: [1]}]',
    ],
    // `check` raises the first mismatch, with no Capability context.
    [
      'check("x", "number")',
      'error {code: "wrong kind", expected: "number", got: "text", value: "x"}',
    ],
    [
      'check([1, "x", true], {list: "number"})',
      'error {code: "wrong kind", expected: "number", got: "text", value: "x", path: [2]}',
    ],
    [
      'check([given x: x], "any")',
      'error {code: "not encodable", kind: "function", path: [1]}',
    ],
    [
      'check(given x: x, "any")',
      'error {code: "not encodable", kind: "function", path: []}',
    ],
    [
      'check(3, {optional: "text"})',
      'error {code: "wrong kind", expected: "text or nothing", got: "number", value: 3}',
    ],
    [
      'check([3], {list: {optional: "text"}})',
      'error {code: "wrong kind", expected: "text or nothing", got: "number", value: 3, path: [1]}',
    ],
    [
      'check(true, {optional: {oneOf: ["text", "number"]}})',
      'error {code: "wrong kind", expected: "text or number or nothing", got: "boolean", value: true}',
    ],
    [
      'check(3, {optional: {optional: "text"}})',
      'error {code: "wrong kind", expected: "text or nothing or nothing", got: "number", value: 3}',
    ],
    [
      'check(true, {oneOf: ["text", "number"]})',
      'error {code: "wrong kind", expected: "text or number", got: "boolean", value: true}',
    ],
    // Definition errors precede value checking, unused alternatives too.
    [
      'conforms(3, {oneOf: ["number", "bogus"]})',
      'error {code: "invalid shape", reason: "unknown kind", path: ["oneOf", 2], value: "bogus"}',
    ],
    [
      'conforms(3, 42)',
      'error {code: "invalid shape", reason: "not a shape", path: [], value: 42}',
    ],
    [
      'conforms(3, {list: "number", optional: "text"})',
      'error {code: "invalid shape", reason: "ambiguous shape", path: [], value: {list: "number", optional: "text"}}',
    ],
    [
      'conforms(3, {oneOf: []})',
      'error {code: "invalid shape", reason: "empty union", path: ["oneOf"], value: []}',
    ],
    [
      'conforms(3, {quantity: "furlongs"})',
      'error {code: "invalid shape", reason: "invalid unit", path: ["quantity"], value: "furlongs"}',
    ],
    [
      'conforms(3, {unitKind: "weightiness"})',
      'error {code: "invalid shape", reason: "unknown unit kind", path: ["unitKind"], value: "weightiness"}',
    ],
    [
      'conforms(3, {map: [{key: "a", shape: "number"}, {key: "a", shape: "text"}]})',
      'error {code: "invalid shape", reason: "duplicate field", path: ["map", 2, "key"], value: "a"}',
    ],
    ['conforms(3, {map: [], opne: true})', 'false'],
  ])('%s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test('a successful check returns the identical value', () => {
    const v = map([['a', num(1)]]);
    const decoded = decodeShape(
      map([
        [
          'map',
          list(
            map([
              ['key', text('a')],
              ['shape', text('number')],
            ]),
          ),
        ],
      ]),
    );
    expect(decoded.error).toBeUndefined();
    const { diags } = shapeDiagnostics(
      v,
      decoded.shape!,
      true,
      decoded.scanned,
    );
    expect(diags).toEqual([]);
  });

  test('a disposed Host Object still fits its Object Shape, without Host access', () => {
    const door = defineObjectKind<null>({
      name: 'shape-check-door',
      props: {},
    });
    const g = newGroup({ name: 'g' });
    const handle = g.object(door, 'd1', null);
    g.dispose(handle);
    g.pump(0n);
    const decoded = decodeShape(map([['object', text('shape-check-door')]]));
    expect(decoded.error).toBeUndefined();
    const { diags } = shapeDiagnostics(
      handle.value,
      decoded.shape!,
      true,
      decoded.scanned,
    );
    expect(diags).toEqual([]);
  });

  test('exhaustion is a Limit Fault, never a truncated report', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'script variable out\non go\n  put explain([1, "x", true, "y"], {list: "number"}) into out\nend go',
      limits: { fuelPerRun: 20 },
    });
    s.deliver({ name: 'go' });
    g.pump(parseInstant('2026-09-30T09:00:00Z'));
    expect(s.counters()).toMatchObject({ faults: 1 });
    expect(g.inspect().scripts[0]!.vars[0]![1].toString()).toBe('nothing');
  });

  test('deeply nested definitions and data do not overflow the stack', () => {
    let data = text('number');
    let v = num(1);
    for (let i = 0; i < 5000; i++) {
      data = map([['list', data]]);
      v = list(v);
    }
    const decoded = decodeShape(data);
    expect(decoded.error).toBeUndefined();
    const deep = shapeDiagnostics(v, decoded.shape!, false, decoded.scanned);
    expect(deep.diags).toEqual([]);
    const bad = shapeDiagnostics(
      text('x'),
      decoded.shape!,
      true,
      decoded.scanned,
    );
    expect(bad.diags).toHaveLength(1);
    expect(bad.diags[0]).toMatchObject({ expected: 'list', path: [] });
  });
});
