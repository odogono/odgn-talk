import { describe, expect, test } from 'bun:test';
import {
  conforms,
  encodeValue,
  explain,
  list,
  map,
  num,
  quantity,
  shape,
  text,
} from '../src/index';
import {
  conforms as wasmConforms,
  explain as wasmExplain,
} from '../src/wasm/index';

// Host checks (ADR 0176): a Host-built Shape, the Built-in's acceptance and report.
describe('conforms and explain for Hosts', () => {
  const line = shape.map({ sku: shape.text, qty: shape.number });
  const invoice = shape.map({
    amount: shape.quantityOf('GBP'),
    lines: shape.listOf(line),
    ref: { optional: true, shape: shape.text },
  });

  test('a fitting value conforms and explains as an empty list', () => {
    const v = map([
      ['amount', quantity(num(3), 'GBP')],
      [
        'lines',
        list(
          map([
            ['sku', text('a')],
            ['qty', num(2)],
          ]),
        ),
      ],
    ]);
    expect(conforms(v, invoice)).toBe(true);
    expect(encodeValue(explain(v, invoice))).toBe('[]');
    expect(conforms(v, shape.map({}))).toBe(false);
  });

  test('explain gives every mismatch record, paths relative to the value', () => {
    const v = map([
      [
        'lines',
        list(
          map([
            ['sku', num(1)],
            ['qty', num(2)],
          ]),
          text('x'),
        ),
      ],
    ]);
    expect(encodeValue(explain(v, invoice))).toBe(
      JSON.stringify([
        {
          code: 'wrong kind',
          expected: 'GBP',
          got: 'nothing',
          value: null,
          path: ['amount'],
        },
        {
          code: 'wrong kind',
          expected: 'text',
          got: 'number',
          value: 1,
          path: ['lines', 1, 'sku'],
        },
        {
          code: 'wrong kind',
          expected: 'map',
          got: 'text',
          value: 'x',
          path: ['lines', 2],
        },
      ]),
    );
  });

  test('a failed union carries its alternatives; Optional adds "or nothing"', () => {
    const r = explain(
      num(3),
      shape.optional(shape.oneOf(shape.text, shape.bool)),
    );
    expect(encodeValue(r)).toBe(
      JSON.stringify([
        {
          code: 'wrong kind',
          expected: 'text or boolean or nothing',
          got: 'number',
          value: 3,
          alternatives: [
            [{ code: 'wrong kind', expected: 'text', got: 'number', value: 3 }],
            [
              {
                code: 'wrong kind',
                expected: 'boolean',
                got: 'number',
                value: 3,
              },
            ],
          ],
        },
      ]),
    );
  });

  test('the WASM entry point exports the same functions', () => {
    expect(wasmConforms).toBe(conforms);
    expect(wasmExplain).toBe(explain);
  });
});
