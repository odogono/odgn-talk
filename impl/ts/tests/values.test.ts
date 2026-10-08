import { expect, test } from 'bun:test';
import {
  HostError,
  Value,
  text,
  nothing,
  bool,
  num,
  dec,
  list,
  map,
  record,
  encodeValue,
  decodeValue,
  readDisplay,
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

test('public text values are scalar NFC and immutable', () => {
  const value = text('e\u0301');
  expect(value.kind).toBe('text');
  expect(value.asText()).toBe('é');
  expect(value.asBool()).toBeUndefined();
  expect(value.length).toBe(0); // The Host accessor is list length, not text length.
  expect(value.equals(text('é'))).toBe(true);
  expect(value.equals(text('É'))).toBe(false);
  expect(Object.isFrozen(value)).toBe(true);
  for (const s of ['\ud800', 'a\udfff', null, undefined, 1]) {
    invalid(() => text(s as string));
  }
  invalid(() => Reflect.construct(Value, ['text', 'not a constructor']));
});

test('display text splits hidden scalar values and keeps literal backslashes', () => {
  const input =
    'say "hi"\n\t\r\u0000\u007f\u061c\u200e\u2028\u2066\ufeff😀C:\\new';
  // Bun escapes astral scalars in tagged template raw text; keep this fixture literal.
  const expected =
    // eslint-disable-next-line unicorn/prefer-string-raw
    '"say " & quote & "hi" & quote & newline & tab & fromCodePoint(13) & fromCodePoint(0) & fromCodePoint(127) & fromCodePoint(1564) & fromCodePoint(8206) & fromCodePoint(8232) & fromCodePoint(8294) & fromCodePoint(65279) & "😀C:\\new"';
  expect(text(input).toString()).toBe(expected);
  expect(readDisplay(expected).asText()).toBe(input);
  expect(text('').toString()).toBe('""');
  expect(readDisplay('"e" & fromCodePoint(769)').asText()).toBe('é');
  for (const cp of [
    0, 9, 10, 13, 31, 127, 159, 1564, 8206, 8232, 8238, 8294, 8297, 65_279,
    0x10_ff_ff,
  ]) {
    const value = text(String.fromCodePoint(cp));
    expect(readDisplay(value.toString()).equals(value)).toBe(true);
  }
});

test('display quotes an offer map key, which source reserves', () => {
  const value = record({ offer: num(1), if: bool(true) });
  expect(value.toString()).toBe('{"offer": 1, if: true}');
  const decoded = readDisplay(value.toString());
  expect(decoded.equals(value)).toBe(true);
  expect(decoded.toString()).toBe(value.toString());
});

test('Value Encoding uses only the specified string escapes', () => {
  expect(encodeValue(text('"\\\n\t\r\b\f\u0000\u001f/é\u2028'))).toBe(
    '"\\"\\\\\\u000a\\u0009\\u000d\\u0008\\u000c\\u0000\\u001f/é\u2028"',
  );
  const value = text('😀\u0000é');
  expect(decodeValue(encodeValue(value), () => undefined).equals(value)).toBe(
    true,
  );
  expect(decodeValue(String.raw`"e\u0301"`, () => undefined).asText()).toBe(
    'é',
  );
  invalid(() => decodeValue(String.raw`"\ud800"`, () => undefined));
});

test('lists and maps snapshot inputs, normalize keys and preserve insertion order', () => {
  const entries: [string, Value][] = [
    ['2', text('two')],
    ['1', text('one')],
    ['e\u0301', text('accent')],
  ];
  const value = map(entries);
  entries[0]![1] = nothing;
  expect(value.entries().map(([k]) => k)).toEqual(['2', '1', 'é']);
  expect(value.get('2').asText()).toBe('two');
  expect(value.get('e\u0301').asText()).toBe('accent');
  value.entries()[0]![1] = nothing;
  expect(value.get('2').asText()).toBe('two');
  expect(value.equals(map([...value.entries()].reverse()))).toBe(true);
  expect(value.get('absent')).toBe(nothing);
  const xs = list(text('a'), value);
  expect(xs.length).toBe(2);
  expect(xs.index(1).asText()).toBe('a');
  expect(xs.index(0)).toBe(nothing);
  expect(xs.index(3)).toBe(nothing);
  invalid(() =>
    map([
      ['é', nothing],
      ['e\u0301', nothing],
    ]),
  );
  invalid(() => map([['\ud800', nothing]]));
  invalid(() => record({ 1: nothing }));
  invalid(() => list(null as unknown as Value));
  invalid(() => map([['a', {} as Value]]));
});

test('container display and encoding round-trip without prototype or numeric-key reordering', () => {
  const value = map([
    ['2', num(2)],
    ['1', num(1)],
    ['__proto__', bool(true)],
    ['$dec', text('literal tag')],
    ['"', nothing],
    ['', list()],
  ]);
  expect(encodeValue(value)).toBe(
    String.raw`{"$map":[["2",2],["1",1],["__proto__",true],["$dec","literal tag"],["\"",null],["",[]]]}`,
  );
  expect(value.toString()).toBe(
    '{"2": 2, "1": 1, __proto__: true, "$dec": "literal tag", "" & quote: nothing, "": []}',
  );
  for (const original of [
    value,
    nothing,
    bool(false),
    list(value, text('é')),
    record({ if: nothing }),
  ]) {
    const fromDisplay = readDisplay(original.toString());
    expect(fromDisplay.equals(original)).toBe(true);
    expect(fromDisplay.toString()).toBe(original.toString());
    const decoded = decodeValue(encodeValue(original), () => undefined);
    expect(decoded.equals(original)).toBe(true);
    expect(encodeValue(decoded)).toBe(encodeValue(original));
  }
  const ordered = decodeValue(
    '{"2":2,"1":1,"__proto__":true}',
    () => undefined,
  );
  expect(ordered.entries().map(([k]) => k)).toEqual(['2', '1', '__proto__']);
});

test('decimal constructors preserve digits and refuse values that need rounding', () => {
  for (const [source, canonical] of [
    ['007', '7'],
    ['2.50', '2.50'],
    ['-0.00', '0.00'],
    ['-0x0D', '-13'],
    ['\u2003 1.20\u2003', '1.20'],
  ]) {
    expect(dec(source!).toString()).toBe(canonical!);
  }
  expect(dec('1.00').equals(num(1))).toBe(true);
  expect(num(-0).toString()).toBe('0');
  expect(num(0.1).toString()).toBe('0.1');
  expect(num(1e21).toString()).toBe('1000000000000000000000');
  expect(num(1e-7).toString()).toBe('0.0000001');
  expect(num(9_007_199_254_740_993n).asDecimal()!.toBigInt()).toBe(
    9_007_199_254_740_993n,
  );
  expect(dec('3.0').asDecimal()!.toBigInt()).toBe(3n);
  invalid(() => dec('3.1').asDecimal()!.toBigInt());
  expect(dec('0.1').asDecimal()!.toNumberLossy()).toBe(0.1);
  for (const source of [
    '+1',
    '1e3',
    '.1',
    '1.',
    '',
    '0x',
    '1'.repeat(35),
    '0.' + '0'.repeat(6176) + '1',
  ]) {
    invalid(() => dec(source));
  }
  for (const n of [Number.NaN, Infinity, -Infinity, 1e34, 10n ** 34n]) {
    invalid(() => num(n));
  }
  expect(dec('0.' + '0'.repeat(6175) + '1').toString()).toHaveLength(6178);
  expect(encodeValue(dec('3.0'))).toBe('{"$dec":"3.0"}');
  expect(encodeValue(num(9_007_199_254_740_991n))).toBe('9007199254740991');
  expect(encodeValue(num(9_007_199_254_740_992n))).toBe(
    '{"$dec":"9007199254740992"}',
  );
  expect(
    decodeValue('{"$dec":"9007199254740993"}', () => undefined)
      .asDecimal()!
      .toBigInt(),
  ).toBe(9_007_199_254_740_993n);
});

test('readers reject malformed, duplicate and unsupported values', () => {
  for (const s of [
    '"a" trailing',
    'fromCodePoint(55296)',
    'fromCodePoint(1114112)',
    '[1,]',
    '{a: 1, a: 2}',
    '01',
    '"\n"',
    '<function s:f>',
  ]) {
    invalid(() => readDisplay(s));
  }
  for (const s of [
    '{"a":1,"a":2}',
    String.raw`{"é":1,"e\u0301":2}`,
    '{"$map":[["a",1],["a",2]]}',
    '{"$dec":"bad"}',
    '{"$unknown":1}',
    '{"$dec":"1","a":2}',
    '{"$map":{}}',
    '[1,]',
    '1e400',
    'true false',
  ]) {
    invalid(() => decodeValue(s, () => undefined));
  }
});

test('valid deeply nested values round-trip without a reader-only depth limit', () => {
  let value = nothing;
  for (let depth = 0; depth < 3000; depth++) {
    value = depth % 2 ? list(value) : map([['$deep', value]]);
  }
  const display = value.toString();
  const encoding = encodeValue(value);
  expect(readDisplay(display).equals(value)).toBe(true);
  expect(decodeValue(encoding, () => undefined).equals(value)).toBe(true);
});
