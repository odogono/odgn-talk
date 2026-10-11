import { resolve } from 'node:path';
import type { generateUnicodeData } from './generate';
import { writeOutput } from '../go/output';
import { header, zigString } from '../zig/output';

type Data = ReturnType<typeof generateUnicodeData>;
type Range = readonly [number, number, string | number];

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
// zig fmt pads a positional list with spaces only when it holds several items.
const scalars = (list: readonly number[]) =>
  list.length === 1
    ? `&.{${hex(list[0]!)}}`
    : `&.{ ${list.map(hex).join(', ')} }`;
const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);

// Property values become enum tags, sorted, so a lookup compares integers.
const enumeration = (name: string, ranges: readonly Range[]) =>
  `pub const ${name} = enum {\n${[...new Set(ranges.map(r => r[2] as string))]
    .sort()
    .map(tag => `    ${tag},\n`)
    .join('')}};\n\n`;

const sortedMapping = (mapping: Record<number, number[]>) =>
  Object.entries(mapping)
    .map(([key, value]) => [Number(key), value] as const)
    .sort((a, b) => a[0] - b[0]);

export const emitZigUnicode = (data: Data): string => {
  let source =
    header('tools/unicode/generate.ts from pinned Unicode Data Files') +
    '// Unicode data © Unicode, Inc.; see UNICODE-LICENSE.txt.\n\n' +
    '/// A run of scalars sharing one property value. Runs are sorted and never\n' +
    '/// overlap, so a scalar is found by binary search.\n' +
    'pub fn Range(comptime T: type) type {\n' +
    '    return struct { start: u21, end: u21, value: T };\n' +
    '}\n\n' +
    '/// A run of scalars that have a binary property.\n' +
    'pub const Span = struct { start: u21, end: u21 };\n\n' +
    '/// A scalar and the scalars it maps to, sorted by `from`.\n' +
    'pub const Mapping = struct { from: u21, to: []const u21 };\n\n' +
    '/// A simple case folding, sorted by `from`.\n' +
    'pub const Folding = struct { from: u21, to: u21 };\n\n' +
    '/// A canonical primary composite, sorted by `first` then `second`.\n' +
    'pub const Composition = struct { first: u21, second: u21, composed: u21 };\n\n' +
    'pub const SourceHash = struct { path: []const u8, sha256: []const u8 };\n\n';
  for (const [name, value] of Object.entries(data)) {
    const constant = snake(name);
    if (typeof value === 'string') {
      source += `pub const ${constant} = ${zigString(value)};\n\n`;
    } else if (name === 'sourceHashes') {
      source += `pub const ${constant} = [_]SourceHash{\n${Object.entries(
        value as Record<string, string>,
      )
        .map(
          ([path, sha]) =>
            `    .{ .path = ${zigString(path)}, .sha256 = ${zigString(sha)} },\n`,
        )
        .join('')}};\n\n`;
    } else if (Array.isArray(value)) {
      const ranges = value as Range[];
      if (typeof ranges[0]?.[2] === 'string') {
        const type = pascal(name);
        source += enumeration(type, ranges);
        source += `pub const ${constant} = [_]Range(${type}){\n${ranges
          .map(
            ([start, end, tag]) =>
              `    .{ .start = ${hex(start)}, .end = ${hex(end)}, .value = .${tag} },\n`,
          )
          .join('')}};\n\n`;
      } else if (
        ranges.every(range => range[2] === 1) &&
        name !== 'combining'
      ) {
        source += `pub const ${constant} = [_]Span{\n${ranges
          .map(
            ([start, end]) =>
              `    .{ .start = ${hex(start)}, .end = ${hex(end)} },\n`,
          )
          .join('')}};\n\n`;
      } else {
        source += `pub const ${constant} = [_]Range(u8){\n${ranges
          .map(
            ([start, end, n]) =>
              `    .{ .start = ${hex(start)}, .end = ${hex(end)}, .value = ${n} },\n`,
          )
          .join('')}};\n\n`;
      }
    } else if (name === 'composition') {
      source += `pub const ${constant} = [_]Composition{\n${Object.entries(
        value as Record<number, number>,
      )
        .map(([key, composed]) => {
          const pair = Number(key);
          return [Math.floor(pair / 0x11_00_00), pair % 0x11_00_00, composed];
        })
        .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
        .map(
          ([first, second, composed]) =>
            `    .{ .first = ${hex(first!)}, .second = ${hex(second!)}, .composed = ${hex(composed!)} },\n`,
        )
        .join('')}};\n\n`;
    } else if (name === 'folding') {
      source += `pub const ${constant} = [_]Folding{\n${Object.entries(
        value as Record<number, number>,
      )
        .map(([key, to]) => [Number(key), to] as const)
        .sort((a, b) => a[0] - b[0])
        .map(
          ([from, to]) => `    .{ .from = ${hex(from)}, .to = ${hex(to)} },\n`,
        )
        .join('')}};\n\n`;
    } else {
      source += `pub const ${constant} = [_]Mapping{\n${sortedMapping(
        value as Record<number, number[]>,
      )
        .map(
          ([from, to]) =>
            `    .{ .from = ${hex(from)}, .to = ${scalars(to)} },\n`,
        )
        .join('')}};\n\n`;
    }
  }
  return `${source.trimEnd()}\n`;
};

export const generateZigUnicode = async (
  data: Data,
  check: boolean,
): Promise<void> => {
  await writeOutput(
    resolve(import.meta.dir, '../../impl/zig/src/generated/unicode.zig'),
    emitZigUnicode(data),
    check,
    'bun run unicode:generate',
  );
};
