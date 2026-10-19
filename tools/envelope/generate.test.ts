import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import data from '../../spec/data/envelope.toml';
import frames from '../../impl/testdata/envelope-frames.json';
import { validateCatalogue, type Catalogue, type Vector } from './catalogue';
import { checkVectors } from './vectors';
import { emitElixir, emitGo, emitTypeScript, emitZig } from './generate';

const catalogue = (): Catalogue => {
  const copy: unknown = structuredClone(data);
  validateCatalogue(copy);
  return copy;
};

test('the catalogue and TS codec agree with every shared frame', () => {
  checkVectors(catalogue(), frames as Vector[]);
});

test('schema and semantic checks reject catalogue drift', () => {
  const invalid = catalogue();
  invalid.messages[0]!.fields[0]!.kind = 'integer';
  expect(() => validateCatalogue(invalid)).toThrow(
    'Invalid envelope catalogue',
  );
  const duplicate = catalogue();
  duplicate.messages[1]!.tag = duplicate.messages[0]!.tag;
  expect(() => validateCatalogue(duplicate)).toThrow('Duplicate messages tag');
  const conflict = catalogue();
  conflict.messages[0]!.fields.find(f => f.name === 'group')!.kind = 'value';
  expect(() => validateCatalogue(conflict)).toThrow(
    'Unmarked kind conflict for group',
  );
  const stale = catalogue();
  stale.intentional_kinds[0]!.kinds.push('bool');
  expect(() => validateCatalogue(stale)).toThrow('Unmarked kind conflict');
  const repeated = catalogue();
  repeated.messages[0]!.fields.push(repeated.messages[0]!.fields[0]!);
  expect(() => validateCatalogue(repeated)).toThrow('Duplicate field name');
  const direction = catalogue();
  direction.reports[0]!.direction = 'host-to-guest';
  expect(() => validateCatalogue(direction)).toThrow(
    'Invalid reports tag/direction',
  );
});

test('coverage checks actual message and Report tags and their decoded trees', () => {
  const d = catalogue();
  expect(() =>
    checkVectors(
      d,
      (frames as Vector[]).filter(v => v.tag !== 0x86),
    ),
  ).toThrow('No vector for message 86');
  expect(() =>
    checkVectors(
      d,
      (frames as Vector[]).filter(v => v.tag !== 0x82),
    ),
  ).toThrow('No vector for message 82');
  const report = catalogue();
  report.reports.push({
    tag: 13,
    name: 'new report',
    direction: 'guest-to-host',
    fields: [],
  });
  expect(() => checkVectors(report, frames as Vector[])).toThrow(
    'No vector for Report 0d',
  );
  const wrongDirection = structuredClone(frames) as Vector[];
  wrongDirection[0]!.direction = 'guest-to-host';
  expect(() => checkVectors(d, wrongDirection)).toThrow(
    'Wrong tag or direction',
  );
  const wrongTree = structuredClone(frames) as Vector[];
  wrongTree[0]!.tree = '{}';
  expect(() => checkVectors(d, wrongTree)).toThrow('Decoded tree differs');
  const wrongOrder = catalogue();
  wrongOrder.messages[0]!.fields.reverse();
  expect(() => checkVectors(wrongOrder, frames as Vector[])).toThrow(
    'Wrong message item',
  );
});

test('all four generated catalogues are reproducible', async () => {
  const d = catalogue();
  const root = new URL('../../', import.meta.url);
  for (const [path, output] of [
    ['impl/ts/src/generated/envelope.ts', await emitTypeScript(d)],
    ['impl/go/internal/generated/envelope.go', emitGo(d)],
    ['impl/zig/src/generated/envelope.zig', emitZig(d)],
    ['impl/elixir/lib/north_talk/generated/envelope.ex', emitElixir(d)],
  ]) {
    expect(readFileSync(new URL(path!, root), 'utf8')).toBe(output!);
  }
});
