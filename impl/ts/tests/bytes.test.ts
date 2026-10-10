import { describe, expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import {
  bytes,
  decodeValue,
  encodeValue,
  HostError,
  readDisplay,
  text,
} from '../src/index';
import { charge, rateOf } from '../src/costs';
import { search } from '../src/operations';
import { fromBase64, toBase64 } from '../src/base64';

// A `go` Handler's result, or its error map without `message` and `at`. A
// one-line body is returned.
const value = (body: string): string => {
  const source = body.includes('\n') ? body : `  return ${body}`;
  const compiled = compileSource(`on go\n${source}\nend go`, { name: 't' });
  if (!compiled.unit) {
    return `load ${compiled.error?.code ?? compiled.diagnostics.map(d => d.code).join(', ')}`;
  }
  const outcome = deliver(loadScript(compiled.unit, {}), 'go', [], {}).finish();
  if (outcome.kind === 'completed') {
    return outcome.result.toString();
  }
  if (outcome.kind === 'errored') {
    const entries = outcome.error
      .entries()
      .filter(([k]) => k !== 'message' && k !== 'at');
    return `error ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`;
  }
  return outcome.kind;
};

const bytesOf = (...xs: number[]) => bytes(Uint8Array.from(xs));

describe('Host values', () => {
  test('Bytes are copied in and out', () => {
    const source = Uint8Array.of(1, 2);
    const b = bytes(source);
    source[0] = 9;
    expect(b.toString()).toBe('<<0x01, 0x02>>');
    const out = b.asBytes()!;
    out[1] = 9;
    expect(b.asBytes()).toEqual(Uint8Array.of(1, 2));
    expect(() => bytes([1, 2] as unknown as Uint8Array)).toThrow(HostError);
    expect(bytes(Uint8Array.of(1)).equals(bytes(Uint8Array.of(1)))).toBe(true);
    expect(bytes(Uint8Array.of(1)).equals(text('\u0001'))).toBe(false);
  });

  test('the display form and Value Encoding round-trip', () => {
    for (const [display, encoding] of [
      ['<<>>', '{"$bytes":""}'],
      ['<<0x0D, 0x0A>>', '{"$bytes":"DQo="}'],
      ['<<0xFB, 0xFF, 0x00>>', '{"$bytes":"+/8A"}'],
      ['[<<0x01>>, 2]', '[{"$bytes":"AQ=="},2]'],
    ] as const) {
      const v = readDisplay(display);
      expect(v.toString()).toBe(display);
      expect(encodeValue(v)).toBe(encoding);
      expect(decodeValue(encoding, () => null).toString()).toBe(display);
    }
  });

  test('readers refuse Bytes not written as the display form or canonical Base64', () => {
    for (const display of [
      '<<0x0d>>',
      '<<1>>',
      '<<0x01,0x02>>',
      '<<0x01, >>',
      '<< >>',
    ]) {
      expect(() => readDisplay(display)).toThrow(HostError);
    }
    for (const data of ['AQ', 'AR==', 'A===', 'AQ==AQ==', 'A-8=', ' AQ==']) {
      expect(fromBase64(data)).toBeUndefined();
      expect(() => decodeValue(`{"$bytes":"${data}"}`, () => null)).toThrow(
        HostError,
      );
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
  });
});

describe('building', () => {
  test.each([
    ['<<0x0D, 0x0A>>', '<<0x0D, 0x0A>>'],
    [
      '<< 0x02, 7 as uint32, -3 as int16 little >>',
      '<<0x02, 0x00, 0x00, 0x00, 0x07, 0xFD, 0xFF>>',
    ],
    [
      '<< 258 as uint16 big, 258 as uint16 little >>',
      '<<0x01, 0x02, 0x02, 0x01>>',
    ],
    ['<< -1 as int64 >>', '<<0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF>>'],
    [
      '<< 18446744073709551615 as uint64 >>',
      '<<0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF>>',
    ],
    ['<< "hé", <<1, 2>> >>', '<<0x68, 0xC3, 0xA9, 0x01, 0x02>>'],
    ['<< <<1, 2>> >>', '<<0x01, 0x02>>'],
    ['<< 1 as 4 bits, 15 as 4 bits >>', '<<0x1F>>'],
    ['<< 1 as 1 bit, 0 as 7 bits, 513 as 16 bits >>', '<<0x80, 0x02, 0x01>>'],
    ['<< <<1, 2>> as 2 bytes >>', '<<0x01, 0x02>>'],
    ['<< "é" as 2 bytes as text >>', '<<0xC3, 0xA9>>'],
    ['<< >>', '<<>>'],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test('a size is evaluated after its value, from a pinned name or an expression', () => {
    expect(
      value(
        '  put 2 into n\n  return << <<1, 2>> as ^n bytes, <<3>> as (n - 1) bytes >>',
      ),
    ).toBe('<<0x01, 0x02, 0x03>>');
  });

  test.each([
    ['<< 256 >>', 'error code: "out of range", field: "byte", value: 256'],
    ['<< -1 >>', 'error code: "out of range", field: "byte", value: -1'],
    [
      '<< 1.5 >>',
      'error code: "wrong kind", expected: "integer", got: "number", value: 1.5',
    ],
    [
      '<< 3 kg >>',
      'error code: "wrong kind", expected: "bytes", got: "quantity", value: 3 kg',
    ],
    [
      '<< [1] >>',
      'error code: "wrong kind", expected: "bytes", got: "list", value: [1]',
    ],
    [
      '<< 70000 as uint16 >>',
      'error code: "out of range", field: "uint16", value: 70000',
    ],
    [
      '<< -129 as int8 >>',
      'error code: "out of range", field: "int8", value: -129',
    ],
    [
      '<< "1" as uint8 >>',
      'error code: "wrong kind", expected: "number", got: "text", value: "1"',
    ],
    [
      '<< 2.5 as uint8 >>',
      'error code: "wrong kind", expected: "integer", got: "number", value: 2.5',
    ],
    [
      '<< 16 as 4 bits, 0 as 4 bits >>',
      'error code: "out of range", field: "4 bits", value: 16',
    ],
    [
      '<< <<1, 2>> as 3 bytes >>',
      'error code: "out of range", field: "bytes", value: <<0x01, 0x02>>',
    ],
    [
      '<< "é" as 1 bytes as text >>',
      'error code: "out of range", field: "bytes as text", value: "é"',
    ],
    [
      '<< "ab" as 2 bytes >>',
      'error code: "wrong kind", expected: "bytes", got: "text", value: "ab"',
    ],
    [
      '<< <<1>> as (0.5) bytes >>',
      'error code: "wrong kind", expected: "integer", got: "number", value: 0.5',
    ],
  ])('%s raises', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });
});

const pick = (subject: string) =>
  value(
    [
      `  match ${subject}`,
      '    when << 0x02, id: uint32, x: int16 little >> then return [id, x]',
      '    when << "GET", hi: 4 bits, lo: 4 bits, n: uint8, b: n bytes as text, ...r >> then return [hi, lo, b, r]',
      '    when << 1, ...t as text >> then return t',
      '    when << n: uint8, b: (n + 1) bytes >> then return b',
      '    when << 1, ... >> then return "rest"',
      '    when << ... >> then return "any"',
      '    else return "none"',
      '  end match',
    ].join('\n'),
  );

describe('matching', () => {
  test.each([
    ['<<0x02, 0, 0, 0, 7, 0xFD, 0xFF>>', '[7, -3]'],
    ['<<"GET", 0x12, 3, "abc", 0xFF>>', '[1, 2, "abc", <<0xFF>>]'],
    ['<<1, 0x68, 0xC3, 0xA9>>', '"hé"'],
    ['<<1, 0xFF, 2>>', '<<0xFF, 0x02>>'],
    ['<<1, 0xFF>>', '"rest"'],
    ['<<9>>', '"any"'],
    ['"text"', '"none"'],
    ['<<"GET", 0x12, 9, "abc">>', '"any"'],
  ])('%s', (subject, expected) => {
    expect(pick(subject)).toBe(expected);
  });

  test('a literal outside a byte never matches, and a negative size fails', () => {
    expect(
      value(
        '  match <<44>>\n    when << 300 >> then return 1\n    else return 2\n  end match',
      ),
    ).toBe('2');
    expect(
      value(
        '  match <<0>>\n    when << n: uint8, b: (n - 1) bytes >> then return b\n    else return "no"\n  end match',
      ),
    ).toBe('"no"');
  });

  test('a pinned size reads the variable', () => {
    expect(
      value(
        '  put 2 into k\n  match <<7, 8>>\n    when << b: ^k bytes >> then return b\n  end match',
      ),
    ).toBe('<<0x07, 0x08>>');
  });
});

describe('Bytes operations', () => {
  test.each([
    ['byte 2 of <<1, 2, 3>>', '2'],
    ['byte -1 of <<1, 2, 3>>', '3'],
    ['bytes 2..3 of <<1, 2, 3>>', '<<0x02, 0x03>>'],
    ['bytes 2..9 of <<1, 2, 3>>', '<<0x02, 0x03>>'],
    ['byte 5 of <<1, 2, 3>>', 'nothing'],
    ['bytes 3..2 of <<1, 2, 3>>', '<<>>'],
    ['the length of <<1, 2, 3>>', '3'],
    ['the bytes of <<1, 2>>', '[1, 2]'],
    ['<<1, 2>> = <<1, 2>>', 'true'],
    ['<<1, 2>> < <<1, 3>>', 'true'],
    ['<<1>> < <<1, 0>>', 'true'],
    ['<<0xFF>> > <<0x01>>', 'true'],
    ['<<>> is empty', 'true'],
    ['<<0>> is empty', 'false'],
    ['<<1>> is a bytes', 'true'],
    ['<<1, 2, 3>> contains <<2, 3>>', 'true'],
    ['<<1, 2, 3>> begins with <<2>>', 'false'],
    ['<<1, 2, 3>> ends with <<3>>', 'true'],
    ['<<1>> & "x"', '"<<0x01>>x"'],
    ['"hé" as bytes', '<<0x68, 0xC3, 0xA9>>'],
    ['<<1>> as bytes', '<<0x01>>'],
    ['<<0x65, 0xCC, 0x81>> as text', '"é"'],
    ['<<0xEF, 0xBB, 0xBF, 0x61>> as text', 'fromCodePoint(65279) & "a"'],
    ['<<0xFF>> can be text', 'false'],
    ['"x" can be bytes', 'true'],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test('`as text` decodes strict UTF-8', () => {
    for (const bad of [
      '0xC0, 0x80',
      '0xED, 0xA0, 0x80',
      '0xE2, 0x82',
      '0xF4, 0x90, 0x80, 0x80',
    ]) {
      expect(value(`<<${bad}>> as text`)).toStartWith(
        'error code: "can\'t convert"',
      );
    }
    expect(value('5 as bytes')).toBe(
      'error code: "can\'t convert", value: 5, to: "bytes"',
    );
  });

  test.each([
    [
      '  put <<1, 2, 3>> into b\n  put 9 into byte 2 of b\n  return b',
      '<<0x01, 0x09, 0x03>>',
    ],
    [
      '  put <<1, 2, 3>> into b\n  put <<7, 8, 9>> into bytes 1..2 of b\n  return b',
      '<<0x07, 0x08, 0x09, 0x03>>',
    ],
    [
      '  put <<1, 2, 3>> into b\n  delete byte 2 of b\n  return b',
      '<<0x01, 0x03>>',
    ],
    [
      '  put <<1, 2, 3>> into b\n  delete byte 7 of b\n  return b',
      '<<0x01, 0x02, 0x03>>',
    ],
    [
      '  put <<1, 2, 3>> into b\n  put 9 into byte 4 of b\n  return b',
      'error code: "out of range", field: "byte", value: 4',
    ],
    [
      '  put <<1, 2, 3>> into b\n  put 256 into byte 1 of b\n  return b',
      'error code: "out of range", field: "byte", value: 256',
    ],
    [
      '  put <<1, 2, 3>> into b\n  put "x" into byte 1 of b\n  return b',
      'error code: "wrong kind", expected: "number", got: "text", value: "x"',
    ],
    [
      '  put <<1, 2, 3>> into b\n  put [1] into bytes 1..2 of b\n  return b',
      'error code: "wrong kind", expected: "bytes", got: "list", value: [1]',
    ],
  ])('a write: %s', (body, expected) => {
    expect(value(body)).toBe(expected);
  });

  test('`contains` with a Bytes needle needs Bytes on the left too', () => {
    expect(value('<<1>> contains "a"')).toBe(
      'error code: "wrong kind", expected: "bytes", got: "text", value: "a"',
    );
    expect(value('"a" contains <<1>>')).toStartWith('error code: "wrong kind"');
  });

  test('a Bytes search counts the steps a text literal search does', () => {
    for (const op of ['contains', 'begins-with', 'ends-with']) {
      expect(
        search(op, bytesOf(1, 2, 1, 2, 3), bytesOf(1, 2, 3), false).steps,
      ).toBe(search(op, text('ababc'), text('abc'), false).steps);
    }
  });

  test('a build field and a read field charge Cost Model 0', () => {
    const b = bytes(Uint8Array.from({ length: 17 }));
    expect(charge(rateOf('bytes-field'), { input: b, result: b })).toEqual({
      fuel: 6,
      alloc: 33,
    });
    expect(charge(rateOf('bin-field'), { result: text('abcdefghi') })).toEqual({
      fuel: 4,
      alloc: 25,
    });
    expect(charge(rateOf('bin-field'), {})).toEqual({ fuel: 2, alloc: 0 });
  });
});
