import { expect, test } from 'bun:test';
import vectors from '../../testdata/request-pump-binary.json';
import {
  decodeBinaryValue,
  encodeBinaryValue,
  type BinaryValueOptions,
} from '../src/binary-value';
import { encodeValue, quoteJSON } from '../src/encoding';
import { decodeValue } from '../src/readers';
import {
  bytes,
  functionValue,
  listValues,
  map,
  nothing,
  num,
  objectValue,
  patternValue,
  text,
} from '../src/values';

const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString('hex');
test('Go/Zig/TS canonical vectors, including observable decimal scale and ordered Maps', () => {
  for (const { json, hex: wire } of vectors) {
    expect(hex(encodeBinaryValue(decodeValue(json)))).toBe(wire);
    expect(
      encodeValue(decodeBinaryValue(Uint8Array.fromHex(wire).buffer)),
    ).toBe(json);
  }
});

test('20,000 nested Values use heap traversal in both directions', () => {
  let v = nothing;
  for (let i = 0; i < 20_000; i++) {
    v = listValues([v]);
  }
  const wire = encodeBinaryValue(v);
  expect(hex(encodeBinaryValue(decodeBinaryValue(wire)))).toBe(hex(wire));
});

test('Objects resolve through their owner, Functions validate negotiated metadata before resolution', () => {
  const obj = objectValue({ kind: 'thing', id: 'one', handle: {} });
  const fn = functionValue({
    home: 's',
    identity: 'f1',
    place: 'go',
    code: null,
    captures: [],
    maySuspend: false,
  });
  const payload = [
    text('s'),
    text('<function s:go>'),
    text('f1'),
    nothing,
    num(1),
    num(2),
    bytes(new Uint8Array(32)),
  ];
  const options: BinaryValueOptions = {
    functionMetadata: true,
    encodeFunction: () => payload,
    decodeFunction: xs => {
      expect(xs.map(v => v.kind)).toEqual(payload.map(v => v.kind));
      return fn;
    },
    object: (kind, id) => (kind === 'thing' && id === 'one' ? obj : undefined),
  };
  const root = map([
    ['fn', fn],
    ['object', obj],
  ]);
  const buffer = encodeBinaryValue(root, options);
  const decoded = decodeBinaryValue(buffer, options);
  expect(decoded.get('fn')).toBe(fn);
  expect(decoded.get('object')).toBe(obj);
  expect(() => decodeBinaryValue(buffer)).toThrow();
  expect(() =>
    encodeBinaryValue(fn, { encodeFunction: () => payload }),
  ).toThrow();
  for (const bad of [
    [...payload.slice(0, 4), num(3), num(2)],
    [...payload.slice(0, 6), bytes(new Uint8Array(31))],
    [num(1), text('s'), text('token')],
  ]) {
    expect(() =>
      encodeBinaryValue(fn, { ...options, encodeFunction: () => bad }),
    ).toThrow();
  }
});

test('Patterns and negotiated Core error markers retain canonical bytes', () => {
  const pattern = patternValue({ source: '<digit>', program: 0, data: null });
  expect(
    hex(encodeBinaryValue(decodeBinaryValue(encodeBinaryValue(pattern)))),
  ).toBe(hex(encodeBinaryValue(pattern)));
  const error = new Uint8Array(
    encodeBinaryValue(map([['message', text('bad')]])),
  );
  error[0] = 17;
  expect(() => decodeBinaryValue(error.buffer)).toThrow();
  const v = decodeBinaryValue(error.buffer, { coreErrors: true });
  expect(hex(encodeBinaryValue(v, { coreErrors: true }))).toBe(
    hex(error.buffer),
  );
});

test('noncanonical, truncated and overlong items are refused', () => {
  const invalid = [
    '',
    '038000',
    '1000',
    '040131',
    '050365cc81',
    '0501ff',
    '07020501610005016100',
    '0000',
    'ff',
    '06ffffff',
    '1303000000',
    '0c03626164',
    '120161',
    '03ffffffffffffffffff02',
    '1081808080808080808002',
    '0d03626164',
  ];
  for (const wire of invalid) {
    expect(() => decodeBinaryValue(Uint8Array.fromHex(wire).buffer)).toThrow();
  }
  const buffer = encodeBinaryValue(
    decodeValue('[{"$quantity":["2","ms"]},{"$bytes":"AQID"}]'),
  );
  for (let i = 0; i < buffer.byteLength; i++) {
    expect(() => decodeBinaryValue(buffer.slice(0, i))).toThrow();
  }
});

test('binary Functions use the same three-item tokens as JSON adapters', () => {
  const fn = functionValue({
    home: 's',
    identity: 't',
    place: 'go',
    captures: [],
    code: null,
    maySuspend: false,
  });
  const payload = [text('s'), text('<function s:go>'), text('t')];
  const options = { encodeFunction: () => payload, decodeFunction: () => fn };
  expect(decodeBinaryValue(encodeBinaryValue(fn, options), options)).toBe(fn);
  expect(
    encodeValue(
      fn,
      () =>
        `{"$function":[${payload.map(v => quoteJSON(v.asText()!)).join(',')}]`,
    ),
  ).toContain('$function');
});
