import { describe, expect, test } from 'bun:test';
import { newGroup, parseInstant } from '../src/index';

const result = (expression: string, declarations = ''): string => {
  const lines: string[] = [];
  const group = newGroup({ name: 'mapping', trace: line => lines.push(line) });
  group
    .load({
      name: 's',
      source: `use transform from map\nscript variable out\n${declarations}\non go\n  put ${expression} into out\nend go`,
    })
    .deliver({ name: 'go' });
  group.pump(parseInstant('2026-09-30T09:00:00Z'));
  group.inspect();
  const run = lines.find(line => line.startsWith('run '))!;
  if (!run.includes('outcome=completed')) {
    return run;
  }
  return lines.at(-1)!.replace(/^vars s out=/, '');
};

describe('checked Mappings', () => {
  test.each([
    ['transform(3, {rules: []})', '{ok: true, value: {}}'],
    [
      'transform({a: 1, b: 2}, {rules: [{from: ["a"], to: ["x"]}]})',
      '{ok: true, value: {x: 1}}',
    ],
    [
      'transform([1, 2], {rules: [{from: [], to: ["whole"]}, {from: [-1], to: ["nested", "last"]}]})',
      '{ok: true, value: {whole: [1, 2], nested: {last: 2}}}',
    ],
    [
      'transform({a: nothing}, {rules: [{from: ["a"], to: ["x"], input: "nothing"}]})',
      '{ok: true, value: {x: nothing}}',
    ],
    [
      'transform({}, {rules: [{from: ["a"], to: ["x"], missing: "skip"}]})',
      '{ok: true, value: {}}',
    ],
    [
      'transform({}, {rules: [{from: ["a", "b"], to: ["x"], missing: "default", default: nothing}]})',
      '{ok: true, value: {x: nothing}}',
    ],
    [
      'transform({"*": 3}, {rules: [{from: ["*"], to: ["x"]}]})',
      '{ok: true, value: {x: 3}}',
    ],
    [
      'transform({b: [2, 3], a: [4]}, {rules: [{from: [{each: true}, {each: true}], to: ["x"]}]})',
      '{ok: true, value: {x: [2, 3, 4]}}',
    ],
    [
      'transform([], {rules: [{from: [{each: true}], to: ["x"]}]})',
      '{ok: true, value: {x: []}}',
    ],
    [
      'transform({}, {rules: [{from: [{each: true}], to: ["x"]}]})',
      '{ok: true, value: {x: []}}',
    ],
    [
      'transform([{}, {n: "4"}, {}], {rules: [{from: [{each: true}, "n"], to: ["x"], missing: "default", default: "2", input: "text", transform: given n: n as number, output: "number"}]})',
      '{ok: true, value: {x: [2, 4, 2]}}',
    ],
    [
      'transform([{}, {n: 4}, {}], {rules: [{from: [{each: true}, "n"], to: ["x"], missing: "skip"}]})',
      '{ok: true, value: {x: [4]}}',
    ],
    [
      'transform([{}, {}], {rules: [{from: [{each: true}, "n"], to: ["x"], missing: "skip"}]})',
      '{ok: true, value: {x: []}}',
    ],
    [
      'transform({}, {rules: [{from: ["absent", {each: true}], to: ["x"], missing: "default", default: 8}]})',
      '{ok: true, value: {x: [8]}}',
    ],
    [
      'transform({a: 1, b: 2}, {rules: [{from: ["a"], to: ["b"]}, {from: ["b"], to: ["a"]}]})',
      '{ok: true, value: {b: 1, a: 2}}',
    ],
    [
      'transform({a: 1, b: 2}, {rules: [{from: ["a"], to: ["x", "a"]}, {from: ["b"], to: ["x", "b"]}]})',
      '{ok: true, value: {x: {a: 1, b: 2}}}',
    ],
    [
      'transform([], {rules: [{from: [-2], to: ["x"]}]})',
      '{ok: false, errors: [{rule: 1, sourcePath: [], destinationPath: ["x"], failedStep: -2, stage: "source", error: {code: "missing selection", step: -2}}]}',
    ],
    [
      'transform(nothing, {rules: [{from: ["a"], to: ["x"], missing: "default", default: 3}]})',
      '{ok: false, errors: [{rule: 1, sourcePath: [], destinationPath: ["x"], failedStep: "a", stage: "source", error: {code: "wrong kind", expected: "map", got: "nothing", value: nothing}}]}',
    ],
    [
      'transform([{}, {n: "bad"}, {}], {rules: [{from: [{each: true}, "n"], to: ["x"], missing: "skip", input: "number"}]})',
      '{ok: false, errors: [{rule: 1, sourcePath: [2, "n"], destinationPath: ["x"], position: 2, stage: "input", error: {code: "wrong kind", expected: "number", got: "text", value: "bad"}}]}',
    ],
    [
      'transform([1, "bad", false], {rules: [{from: [], to: ["x"], input: {list: "number"}, transform: given n: n / 0}]})',
      '{ok: false, errors: [{rule: 1, sourcePath: [], destinationPath: ["x"], stage: "input", error: {code: "wrong kind", expected: "number", got: "text", value: "bad", path: [2]}}, {rule: 1, sourcePath: [], destinationPath: ["x"], stage: "input", error: {code: "wrong kind", expected: "number", got: "boolean", value: false, path: [3]}}]}',
    ],
    [
      'transform(2, {rules: [{from: [], to: ["x"], transform: given n: n + 1, output: "text"}]})',
      '{ok: false, errors: [{rule: 1, sourcePath: [], destinationPath: ["x"], stage: "output", error: {code: "wrong kind", expected: "text", got: "number", value: 3}}]}',
    ],
  ])('%s', (expression, expected) => {
    expect(result(expression)).toBe(expected);
  });
});

test.each([
  [
    '{rules: [{from: [0], to: [], output: "bogus"}]}',
    'invalid selection step',
    '["rules", 1, "from", 1]',
  ],
  [
    '{rules: [{from: [], to: ["x"], transform: given n: n / 0}, {from: [], to: ["y"], output: "bogus"}]}',
    'invalid shape',
    '["rules", 2, "output"]',
  ],
  [
    '{rules: [{from: ["missing"], to: ["x"], missing: "skip"}, {from: [], to: ["x", "y"]}]}',
    'overlapping destination',
    '["rules", 2, "to"]',
  ],
  [
    '{rules: [{from: [], to: ["x"], transform: given a, b: a}]}',
    'invalid transform arity',
    '["rules", 1, "transform"]',
  ],
])('definition validation: %s', (mapping, reason, path) => {
  const actual = result(`transform(1, ${mapping})`);
  expect(actual).toContain('outcome=errored');
  expect(actual).toContain(
    `code: "invalid mapping", reason: "${reason}", path: ${path}`,
  );
  expect(actual).not.toContain('code: "divide by zero"');
});
