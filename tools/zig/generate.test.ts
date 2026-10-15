import { expect, test } from 'bun:test';
import costs from '../../spec/data/costs.toml';
import { compileCostModel } from '../costs/compile';
import { emitCatalogue, emitCostTerms, emitOpcodes } from './generate';
import { zigField, zigString } from './output';
import { emitZigUnicode } from '../unicode/generate-zig';

test('Zig catalogues keep optional fields and mixed counts', () => {
  const result = emitCatalogue('example', {
    instruction: [
      { name: 'const', pops: 0, operands: [] },
      { name: 'call', pops: 'count', operands: ['body'], jumps: 1 },
    ],
  });
  expect(result).toContain('jumps: ?i64 = null,');
  expect(result).toContain('pops: Scalar,');
  expect(result).toContain('.pops = .{ .text = "count" },');
  expect(result).toContain('.pops = .{ .int = 0 },');
  expect(result).toContain('.operands = &.{},');
  expect(result).toContain('pub const Scalar = union(enum)');
});

test('Zig names quote keywords, and strings escape what Zig must', () => {
  expect(zigField('error')).toBe('@"error"');
  expect(zigField('fuel-per')).toBe('fuel_per');
  expect(zigField('2nd')).toBe('@"2nd"');
  expect(zigString('a"b\\c\nd\u0001')).toBe(String.raw`"a\"b\\c\nd\x01"`);
  expect(zigString('é')).toBe('"é"');
});

test('Zig opcodes follow the machine table order', () => {
  expect(
    emitOpcodes([{ name: 'const' }, { name: 'call-value-wait' }]),
  ).toContain(
    'pub const Opcode = enum(u8) {\n    @"const",\n    call_value_wait,\n};',
  );
  expect(() =>
    emitOpcodes(Array.from({ length: 257 }, (_, i) => ({ name: `op${i}` }))),
  ).toThrow('u8');
});

test('Zig Unicode tables sort mappings and enumerate property values', () => {
  const result = emitZigUnicode({
    unicodeVersion: '1.0.0',
    sourceHashes: { 'A.txt': 'ab' },
    category: [[0x41, 0x5a, 'Lu']],
    combining: [[0x3_00, 0x3_14, 230]],
    decomposition: { 0xc5: [0x41, 0x3_0a], 0xc0: [0x41, 0x3_00] },
    composition: { [0x41 * 0x11_00_00 + 0x3_0a]: 0xc5 },
    folding: { 0x41: 0x61 },
    uppercase: {},
    lowercase: {},
    finalSigma: {},
    grapheme: [[0xd, 0xd, 'CR']],
    indic: [],
    pictographic: [[0x1_f6_00, 0x1_f6_4f, 1]],
    whitespace: [],
    cased: [],
    caseIgnorable: [],
  } as never);
  expect(result).toContain('pub const unicode_version = "1.0.0";');
  expect(result.indexOf('.from = 0x00C0')).toBeLessThan(
    result.indexOf('.from = 0x00C5'),
  );
  expect(result).toContain(
    '.{ .first = 0x0041, .second = 0x030A, .composed = 0x00C5 },',
  );
  expect(result).toContain('pub const Grapheme = enum {\n    CR,\n};');
  expect(result).toContain('pub const combining = [_]Range(u8){');
  expect(result).toContain('pub const pictographic = [_]Span{');
});

test('Zig charge specialization follows source formulas and keeps dynamic fallback', () => {
  const source = {
    ...costs,
    rate: [
      { key: 'one', fuel: '3 + scanned / 8', alloc: 'size(result)' },
      { key: 'same', fuel: '3 + scanned / 8', alloc: 'size(result)' },
      { key: 'factor', fuel: '2 * count / 3 + count / 3' },
      {
        key: 'builtin.example',
        fuel: '3 + scanned / 8',
        alloc: 'size(result)',
      },
      { key: 'unknown', fuel: 'frames' },
      { key: 'argument', fuel: 'size(x1)' },
    ],
  };
  const generated = emitCostTerms(compileCostModel(source));
  const rows = generated.split('pub const Charge')[0]!;
  expect(rows.match(/\.formula = \.f1/g)).toHaveLength(2);
  for (const key of ['builtin.example', 'unknown', 'argument']) {
    expect(
      rows.split('\n').find(line => line.includes(`.key = "${key}"`)),
    ).toContain('.formula = null');
  }
  expect(generated).toContain(
    '(((@as(u64, 2) * m.count) + 3 - 1) / 3) + ((m.count + 3 - 1) / 3)',
  );
  expect(generated).toContain('measureValue(measure_size, v)');
  const changed = emitCostTerms(
    compileCostModel({
      ...source,
      rate: [{ key: 'one', fuel: '7 + scanned / 16' }],
    }),
  );
  expect(changed).toContain('@as(u64, 7)');
  expect(changed).toContain('(m.scanned + 16 - 1) / 16');
});
