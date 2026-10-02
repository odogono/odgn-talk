import { describe, expect, test } from 'bun:test';
import { libraryExports } from '../src/generated/syntax';
import { newGroup, parseInstant } from '../src/index';

// Every stdlib export, imported by name; stdlib names are unique.
const byLibrary = new Map<string, string[]>();
for (const e of libraryExports) {
  byLibrary.set(e.library, [...(byLibrary.get(e.library) ?? []), e.name]);
}
const uses = [...byLibrary]
  .map(([library, names]) => `use ${names.join(', ')} from ${library}`)
  .join('\n');

// A Script's Trace for `go` putting `expr` into `out`.
const trace = (expr: string): string[] => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  group
    .load({
      name: 's',
      source: `${uses}\nscript variable out\non go\n  put ${expr} into out\nend go`,
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
const symbols = (decimal: string, group: string, secondary: number) =>
  `{decimal: "${decimal}", group: "${group}", minus: "-", digits: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], primaryGroup: 3, secondaryGroup: ${secondary}, minGrouping: 1}`;
const de = symbols(',', '.', 3);

describe('the stdlib Libraries', () => {
  test.each([
    // text
    ['pad("id", 5, ".")', '"id..."'],
    ['padLeft("7", 3, "0")', '"007"'],
    [
      'pad("x", -1)',
      'error {code: "out of domain", function: "pad", value: -1}',
    ],
    [
      '[trim("  hi  "), trimStart("  hi "), trimEnd(" hi  ")]',
      '["hi", "hi ", " hi"]',
    ],
    ['split("a,,b,", ",")', '["a", "", "b", ""]'],
    ['split("", ",")', '[""]'],
    ['join([1, 2, 3], "-")', '"1-2-3"'],
    ['repeated("ab", 3)', '"ababab"'],
    ['lastOffset("aa", "aaa")', '1'],
    [
      'format("{name} owes {amount}", {name: "Ann", amount: 2.50 GBP})',
      '"Ann owes 2.50 GBP"',
    ],
    [
      'format("{x", {x: 1})',
      'error {code: "out of domain", function: "format", value: "{x"}',
    ],
    [`formatNumber(1234567.5, ${de}, 2)`, '"1.234.567,50"'],
    [`formatNumber(-1234.5, ${de})`, '"-1.234,5"'],
    [`formatNumber(1234567, ${symbols('.', ',', 2)})`, '"12,34,567"'],
    [`parseNumber("2,50", ${de})`, '2.50'],
    [`parseNumber("1.234,50", ${de})`, '1234.50'],
    [
      `parseNumber("12a", ${de})`,
      `error {code: "can't convert", value: "12a", to: "number", offset: 3}`,
    ],
    // list
    [
      '[sum([1, 2, 3]), sum([]), sum([1 m, 50 cm]), average([1, 2])]',
      '[6, 0, 1.50 m, 1.5]',
    ],
    [
      'average([])',
      'error {code: "out of domain", function: "average", value: []}',
    ],
    ['zip([1, 2, 3], ["a", "b"])', '[[1, "a"], [2, "b"]]'],
    [
      '[unique([1, 2, 1, 3, 2]), reverse([1, 2, 3]), flatten([1, [2, [3]], 4])]',
      '[[1, 2, 3], [3, 2, 1], [1, 2, [3], 4]]',
    ],
    [
      '[sort([3, 1, 2]), sort([3, 1, 2], "descending"), sortWith([3, 1, 2], given a, b: a - b)]',
      '[[1, 2, 3], [3, 2, 1], [1, 2, 3]]',
    ],
    [
      'sortBy([{n: 2}, {n: 1}, {n: 2, k: 1}], given r: the n of r)',
      '[{n: 1}, {n: 2}, {n: 2, k: 1}]',
    ],
    ['sort([1, "a"])', `error {code: "can't compare", left: "a", right: 1}`],
    [
      'sort([1], "up")',
      'error {code: "out of domain", function: "sort", value: "up"}',
    ],
    [
      '[filter([1, 2, 3, 4], given x: x > 2), map([1, 2], given x: x * 10)]',
      '[[3, 4], [10, 20]]',
    ],
    ['reduce([1, 2, 3], given a, x: a + x, 0)', '6'],
    [
      'group(["ab", "ac", "b"], given s: character 1 of s)',
      '{a: ["ab", "ac"], b: ["b"]}',
    ],
    ['partition([1, 2, 3], given x: x > 1)', '[[2, 3], [1]]'],
    [
      '[any([], given x: true), all([], given x: false), find([1, 2, 3], given x: x > 1), find([1], given x: x > 5), indexOf([1, 2, 3], 3)]',
      '[false, true, 2, nothing, 3]',
    ],
    [
      'filter([1], given x: 1)',
      'error {code: "wrong kind", expected: "boolean", got: "number", value: 1}',
    ],
    ['map([1], given a, b: a)', 'error {code: "wrong arity"}'],
    // map
    ['merge({a: 1, b: 2}, {b: 3, c: 4})', '{a: 1, b: 3, c: 4}'],
    [
      '[without({a: 1, b: 2}, ["a", "z"]), pick({a: 1, b: 2, c: 3}, ["c", "a"])]',
      '[{b: 2}, {a: 1, c: 3}]',
    ],
    [
      '[entries({a: 1}), fromEntries([["a", 1], ["b", 2], ["a", 3]])]',
      '[[["a", 1]], {a: 3, b: 2}]',
    ],
    ['mapValues({a: 1, b: 2}, given v: v + 1)', '{a: 2, b: 3}'],
    // bytes
    ['[toHex(<<0xDE, 0xAD>>), fromHex("DEad")]', '["dead", <<0xDE, 0xAD>>]'],
    [
      'fromHex("abc")',
      `error {code: "can't convert", value: "abc", to: "bytes", format: "hex", offset: 3}`,
    ],
    [
      '[toBase64(<<1, 2, 3, 4>>), toBase64Url(<<0xFB, 0xFF>>), fromBase64Url("-_8")]',
      '["AQIDBA==", "-_8", <<0xFB, 0xFF>>]',
    ],
    [
      'fromBase64("AQIDBB==")',
      `error {code: "can't convert", value: "AQIDBB==", to: "bytes", format: "base64", offset: 6}`,
    ],
    [
      '[decodeText(<<0xEF, 0xBB, 0xBF, 0x68, 0x69>>), decodeText(<<0x68, 0>>, "utf-16le"), decodeText(<<0x80>>, "windows-1252")]',
      '["hi", "h", "€"]',
    ],
    [
      'decodeText(<<0xFF>>)',
      `error {code: "can't convert", value: <<0xFF>>, to: "text", format: "utf-8"}`,
    ],
    [
      '[encodeText("hé"), encodeText("hé", "utf-16be"), encodeText("€", "windows-1252")]',
      '[<<0x68, 0xC3, 0xA9>>, <<0x00, 0x68, 0x00, 0xE9>>, <<0x80>>]',
    ],
    [
      'encodeText("€", "latin-1")',
      `error {code: "can't convert", value: "€", to: "bytes", format: "latin-1"}`,
    ],
    // json
    [
      'encodeJson({name: "Ann", scores: [2.50, nothing]}) = "{" & quote & "name" & quote & ":" & quote & "Ann" & quote & "," & quote & "scores" & quote & ":[2.50,null]}"',
      'true',
    ],
    [
      '[decodeJson("1e5"), decodeJson("2.50e1"), decodeJson("-0"), decodeJson(" true ")]',
      '[100000, 25.0, 0, true]',
    ],
    [
      'decodeJson("[1,")',
      `error {code: "can't decode", format: "json", offset: 4}`,
    ],
    [
      'encodeJson({total: 5 kg})',
      'error {code: "not encodable", kind: "quantity", path: ["total"]}',
    ],
    // date
    [
      '[makeDate(2026, 9, 27), makeDateTime(2026, 9, 27, 14, 5), atTime(makeDate(2026, 1, 1), 9, 30, 15, 500)]',
      '[2026-09-27, 2026-09-27T14:05:00, 2026-01-01T09:30:15.0000005]',
    ],
    [
      'makeDate(2026, 2, 30)',
      'error {code: "out of range", field: "day", value: 30}',
    ],
    [
      '[dateOnly(makeDateTime(2026, 9, 27, 14, 5)), daysInMonth(makeDate(2024, 2, 1))]',
      '[2026-09-27, 29]',
    ],
    [
      '[isLeapYear(1900), isLeapYear(2000), isLeapYear(2024), isLeapYear(-4)]',
      '[false, true, true, true]',
    ],
    [
      'formatDate(makeDateTime(2026, 9, 27, 14, 5), "{day:2}/{month:2}/{year} {hour:2}:{minute:2}")',
      '"27/09/2026 14:05"',
    ],
    [
      'formatDate(makeDateTime(2026, 1, 1, 1, 2, 3, 123456789), "{year}{month}{day}{hour}{minute}{second}.{fraction:3} {weekday}")',
      '"202611123.123 4"',
    ],
    [
      '[parseDate("2026-09-27", "{year}-{month}-{day}"), parseDate("2026-9-27 7:05:09", "{year}-{month}-{day} {hour}:{minute:2}:{second}")]',
      '[2026-09-27, 2026-09-27T07:05:09]',
    ],
    [
      'parseDate("2026/09/27", "{year}-{month}-{day}")',
      `error {code: "can't convert", value: "2026/09/27", to: "civil date", format: "{year}-{month}-{day}", offset: 5}`,
    ],
    [
      'formatDate(makeDate(2026, 1, 1), "{year}")',
      'error {code: "out of domain", function: "formatDate", value: "{year}"}',
    ],
    [
      '[splitDuration(90061.5 s), splitDuration(-2 hr)]',
      '[{days: 1, hours: 1, minutes: 1, seconds: 1.5}, {days: 0, hours: -2, minutes: 0, seconds: 0}]',
    ],
    [
      '[monthsBetween(makeDate(2026, 1, 31), makeDate(2026, 2, 28)), monthsBetween(makeDate(2026, 3, 1), makeDate(2026, 1, 31))]',
      '[1, -1]',
    ],
    [
      '[epoch, epoch + 1700000000 s]',
      '[1970-01-01T00:00:00Z, 2023-11-14T22:13:20Z]',
    ],
    // units
    [
      '[celsiusToFahrenheit(100), fahrenheitToCelsius(212), kelvinToFahrenheit(0)]',
      '[212, 100, -459.67]',
    ],
    [
      'celsiusToKelvin(1 m)',
      'error {code: "wrong kind", expected: "number", got: "quantity", value: 1 m}',
    ],
  ])('%s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });
});

describe('errors in stdlib code (ADR 0037)', () => {
  test('`at` names the Script’s call, and the Trace keeps the stdlib position', () => {
    const lines = trace('pad("x", -1)');
    expect(lines.find(line => line.startsWith('raise '))).toMatch(
      /^raise s\/r1 code="out of domain" at=text:\d+ pos=\d+:\d+$/,
    );
    expect(lines.find(line => line.startsWith('run '))).toContain(
      'error={code: "out of domain", function: "pad", value: -1, at: {unit: "s", handler: "go", line: 10, column: 7}}',
    );
  });

  test('an error in a Function Value the stdlib calls points into it', () => {
    expect(
      trace('map([1, 0], given x: 1 / x)').find(line =>
        line.startsWith('run '),
      ),
    ).toContain(
      'error={code: "division by zero", at: {unit: "s", handler: "go", line: 10, column: 30}}',
    );
  });
});
