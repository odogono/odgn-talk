import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import { costModel, languageVersion } from '../src/generated/machine';
import { unicodeVersion } from '../src/generated/unicode';
import {
  bool,
  bytes,
  civilDate,
  coreVersions,
  dec,
  decodeJson,
  defineObjectKind,
  encodeJson,
  HostError,
  instant,
  list,
  map,
  newGroup,
  nothing,
  num,
  parseInstant,
  quantity,
  range,
  readDisplay,
  ScriptError,
  text,
  type Value,
  type Versions,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
const libraryCodec = (
  name: string,
  input: Value,
  group = newGroup({ name: 'json' }),
): Value => {
  group
    .load({
      name: 's',
      source: `use ${name} from json\non go v\n  return ${name}(v)\nend go`,
      limits: { fuelPerRun: 100_000_000, allocPerRun: 100_000_000 },
    })
    .deliver({ name: 'go', args: [input] });
  for (;;) {
    const pumped = group.pump(now, {
      fuelCap: 10_000_000,
      fuelSlice: 10_000_000,
    });
    const report = operationalReports(pumped.reports).find(
      r => r.kind === 'run end',
    );
    if (report?.kind === 'run end') {
      if (report.error) {
        throw report.error;
      }
      expect(report.outcome).toBe('completed');
      return report.result!;
    }
    expect(pumped.state).toBe('sliced');
  }
};
const scriptError = (fn: () => unknown): ScriptError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptError);
    return error as ScriptError;
  }
  throw new Error('Expected a ScriptError');
};

describe('plain JSON: shared Host and Library cases', () => {
  test.each([
    ['null', 'nothing'],
    [' true \t\r\n', 'true'],
    ['false', 'false'],
    ['2.50', '2.50'],
    ['-0.00', '0.00'],
    ['1e5', '100000'],
    ['2.50e1', '25.0'],
    ['1E-3', '0.001'],
    ['0e999999999999', '0'],
    [
      '1234567890123456789012345678901234',
      '1234567890123456789012345678901234',
    ],
    [String.raw`"e\u0301"`, '"é"'],
    [String.raw`"\uD83D\uDE00"`, '"😀"'],
    [
      String.raw`"\"\\\/\b\f\n\r\t\u0000"`,
      String.raw`quote & "\/" & fromCodePoint(8) & fromCodePoint(12) & newline & fromCodePoint(13) & tab & fromCodePoint(0)`,
    ],
    ['[null,true,[2.50],{}]', '[nothing, true, [2.50], {}]'],
    ['{"2":2,"1":1,"$dec":"2.50"}', '{"2": 2, "1": 1, "$dec": "2.50"}'],
  ])('decode %s', (source, display) => {
    const expected = readDisplay(display).toString();
    expect(decodeJson(source).toString()).toBe(expected);
    expect(libraryCodec('decodeJson', text(source)).toString()).toBe(expected);
  });

  test.each([
    ['', 1],
    ['[1,', 4],
    ['[1,]', 4],
    ['{"a":1,}', 8],
    ['{"a" 1}', 6],
    ['[1 2]', 4],
    ['01', 2],
    ['-', 2],
    ['1.', 3],
    ['1.e2', 3],
    ['1e+', 4],
    ['+1', 1],
    ['.5', 1],
    ['truX', 4],
    ['nullx', 5],
    ['NaN', 1],
    ['\u00a0null', 1],
    ['"a\n"', 3],
    [String.raw`"\q"`, 3],
    [String.raw`"\u00x0"`, 6],
    [String.raw`"\uDC00"`, 2],
    [String.raw`"\uD800"`, 8],
    [String.raw`"\uD800\u0041"`, 8],
    ['{"a":1,"a":2}', 8],
    ['{"é":1,' + String.raw`"e\u0301":2}`, 8],
    ['["👨‍👩‍👧",x]', 6],
    ['"a"\u0301x', 3],
    ['12345678901234567890123456789012345', 1],
    ['1e34', 1],
    ['1e-6177', 1],
    ['0e-999999999999', 1],
  ])('reject %s at Character %i', (source, offset) => {
    for (const decode of [
      () => decodeJson(source),
      () => libraryCodec('decodeJson', text(source)),
    ]) {
      const error = scriptError(decode);
      expect(error.code).toBe("can't decode");
      expect(error.data.get('format').asText()).toBe('json');
      expect(error.data.get('offset').toString()).toBe(String(offset));
    }
  });

  test.each([
    [nothing, 'null'],
    [bool(false), 'false'],
    [dec('2.50'), '2.50'],
    [
      text('"\\/\b\t\n\f\r\u0000\u001f é😀'),
      String.raw`"\"\\/\b\t\n\f\r\u0000\u001f` + ' é😀"',
    ],
    [
      map([
        ['2', num(2)],
        ['1', num(1)],
        ['$dec', text('2.50')],
      ]),
      '{"2":2,"1":1,"$dec":"2.50"}',
    ],
    [
      map([
        ['name', text('Ann')],
        ['scores', list(dec('2.50'), nothing)],
      ]),
      '{"name":"Ann","scores":[2.50,null]}',
    ],
  ] as [Value, string][])('encode %s', (value, encoded) => {
    expect(encodeJson(value)).toBe(encoded);
    expect(libraryCodec('encodeJson', value).asText()).toBe(encoded);
  });

  test.each([
    quantity(dec('5'), 'kg'),
    range(num(1), num(2)),
    civilDate('2026-10-02'),
    instant(0n),
    bytes(new Uint8Array([1])),
  ])('refuse %s with its nested path', value => {
    const input = map([
      ['outer', list(nothing, map([['bad', value]]))],
      ['later', bytes(new Uint8Array())],
    ]);
    for (const encode of [
      () => encodeJson(input),
      () => libraryCodec('encodeJson', input),
    ]) {
      const error = scriptError(encode);
      expect(error.code).toBe('not encodable');
      expect(error.data.get('kind').asText()).toBe(value.kind);
      expect(error.data.get('path').toString()).toBe('["outer", 2, "bad"]');
    }
  });
});

describe('Host JSON boundary', () => {
  test('refuses malformed Host arguments', () => {
    expect(() => decodeJson(42 as unknown as string)).toThrow(HostError);
    expect(() => encodeJson(null as unknown as Value)).toThrow(HostError);
    for (const source of ['"\ud800"', '"\udc00"']) {
      expect(scriptError(() => decodeJson(source)).code).toBe("can't decode");
    }
  });
  test('accepts the smallest exponent and keeps its scale', () => {
    expect(decodeJson('1e-6176').toString()).toBe(
      '0.' + '0'.repeat(6175) + '1',
    );
    expect(decodeJson('0e-6176').toString()).toBe('0.' + '0'.repeat(6176));
  });
  test('handles deep values without a codec nesting limit', () => {
    const source = '['.repeat(10_000) + 'null' + ']'.repeat(10_000);
    expect(encodeJson(decodeJson(source))).toBe(source);
  });
  test('refuses a Host Object at the root', () => {
    const group = newGroup({ name: 'objects' });
    const object = group.object(
      defineObjectKind({ name: 'json-item', props: {} }),
      'id',
      {},
    );
    const error = scriptError(() => encodeJson(object.value));
    expect(error.data.get('kind').asText()).toBe('object');
    expect(error.data.get('path').toString()).toBe('[]');
    const library = scriptError(() =>
      libraryCodec('encodeJson', object.value, group),
    );
    expect(library.code).toBe(error.code);
    expect(library.data.get('kind').asText()).toBe('object');
    expect(library.data.get('path').toString()).toBe('[]');
  });
  test('uses the same catalogue error messages as the Library', () => {
    for (const [name, value] of [
      ['decodeJson', text('[')],
      ['encodeJson', bytes(new Uint8Array())],
    ] as const) {
      const host = scriptError(() =>
        name === 'decodeJson' ? decodeJson(value.asText()!) : encodeJson(value),
      );
      const library = scriptError(() => libraryCodec(name, value));
      expect(host.message).toBe(library.message);
    }
  });
  test('refuses Script-created Patterns and Function Values in both codecs', () => {
    for (const [expression, kind] of [
      ['<"a">', 'pattern'],
      ['given x: x', 'function'],
    ]) {
      const group = newGroup({ name: 'values' });
      group
        .load({
          name: 'values',
          source: `on go\n  return ${expression}\nend go`,
        })
        .deliver({ name: 'go' });
      const report = operationalReports(group.pump(now).reports).find(
        r => r.kind === 'run end',
      );
      expect(report?.kind === 'run end' && report.outcome).toBe('completed');
      if (report?.kind !== 'run end') {
        throw new Error('Missing value');
      }
      const value = report.result!;
      for (const encode of [
        () => encodeJson(list(value)),
        () => libraryCodec('encodeJson', list(value), group),
      ]) {
        const error = scriptError(encode);
        expect(error.code).toBe('not encodable');
        expect(error.data.get('kind').asText()).toBe(kind);
        expect(error.data.get('path').toString()).toBe('[1]');
      }
    }
  });
});

test('coreVersions reports the generated pins and the actual save format', () => {
  const versions: Versions = coreVersions;
  expect(versions.language).toBe(languageVersion);
  expect(versions.costModel).toBe(String(costModel.version));
  expect(versions.unicode).toBe(unicodeVersion);
  expect(versions.core).toBe('ts/0.1.0');
  const save = newGroup({ name: 'versions' }).save();
  const outer = JSON.parse(new TextDecoder().decode(save));
  const saved = JSON.parse(outer.payload);
  expect(versions.saveFormat).toBe(String(saved.format));
});
