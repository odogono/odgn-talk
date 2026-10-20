import { expect, test } from 'bun:test';
import {
  Decimal,
  HostError,
  bytes,
  civilDate,
  dec,
  fromValue,
  instant,
  list,
  map,
  nothing,
  num,
  record,
  text,
  toValue,
} from '../src/index';

const invalid = (f: () => unknown) => {
  try {
    f();
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('invalid value');
  }
};

test('toValue builds Values from plain data', () => {
  const v = toValue({
    name: 'é',
    count: 3n,
    ok: true,
    none: null,
    missing: undefined,
    tags: ['a', null],
    price: dec('2.50').asDecimal(),
    raw: new Uint8Array([1, 2]),
    when: civilDate('2026-10-20'),
  });
  expect(
    v.equals(
      record({
        name: text('é'),
        count: num(3n),
        ok: toValue(true),
        none: nothing,
        missing: nothing,
        tags: list(text('a'), nothing),
        price: dec('2.50'),
        raw: bytes(new Uint8Array([1, 2])),
        when: civilDate('2026-10-20'),
      }),
    ),
  ).toBe(true);
  // eslint-disable-next-line no-sparse-arrays -- a hole reads as Nothing.
  expect(toValue([, 1n]).equals(list(nothing, num(1)))).toBe(true);
  expect(toValue([undefined, 1n]).equals(list(nothing, num(1)))).toBe(true);
  const keyed = toValue(
    new Map([
      ['2', 'b'],
      ['1', 'a'],
    ]),
  );
  expect(keyed.entries().map(([k]) => k)).toEqual(['2', '1']);
});

test('toValue refuses JS numbers unless asked', () => {
  invalid(() => toValue(0.1));
  invalid(() => toValue({ a: [1] }));
  expect(toValue(0.1, { numbers: 'decimal' }).equals(dec('0.1'))).toBe(true);
  invalid(() => toValue(Number.NaN, { numbers: 'decimal' }));
});

test('toValue refuses anything the table does not name', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  for (const bad of [
    new Date(0),
    () => 1,
    Symbol('s'),
    new (class Point {})(),
    new Uint16Array(1),
    cyclic,
    { 1: 'integer-like' },
    new Map([[1, 'a']]),
    '\ud800',
  ]) {
    invalid(() => toValue(bad));
  }
  const shared = ['x'];
  expect(toValue([shared, shared]).length).toBe(2);
});

test('fromValue writes plain data', () => {
  const v = map([
    ['n', dec('2.50')],
    ['t', text('hi')],
    ['l', list(nothing, toValue(false))],
    ['__proto__', text('kept')],
    ['at', instant(0n)],
  ]);
  const plain = fromValue(v) as Record<string, unknown>;
  expect(plain.n).toBeInstanceOf(Decimal);
  expect(String(plain.n)).toBe('2.50');
  expect(plain.t).toBe('hi');
  expect(plain.l).toEqual([null, false]);
  expect(Object.getOwnPropertyDescriptor(plain, '__proto__')?.value).toBe(
    'kept',
  );
  expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
  expect((plain.at as typeof v).equals(instant(0n))).toBe(true);
  expect(fromValue(dec('2.50'), { numbers: 'string' })).toBe('2.50');
  expect(
    fromValue(
      map([
        ['2', nothing],
        ['1', nothing],
      ]),
      { maps: 'map' },
    ),
  ).toEqual(
    new Map([
      ['2', null],
      ['1', null],
    ]),
  );
  const out = fromValue(bytes(new Uint8Array([7]))) as Uint8Array;
  out[0] = 9;
  expect(out).toEqual(new Uint8Array([9]));
});

test('toValue reverses fromValue', () => {
  const v = map([
    ['a', list(dec('1.0'), text('x'), nothing)],
    ['b', bytes(new Uint8Array([3]))],
    ['c', civilDate('2026-01-02')],
    ['3', toValue(true)],
  ]);
  expect(toValue(fromValue(v, { maps: 'map' })).equals(v)).toBe(true);
  invalid(() => toValue(fromValue(v)));
});
