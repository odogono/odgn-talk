#!/usr/bin/env bun
// This emitter reads Spec Data Files only, never another Core.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import machine from '../../spec/data/machine.toml';
import costs from '../../spec/data/costs.toml';
import errors from '../../spec/data/errors.toml';
import diagnostics from '../../spec/data/diagnostics.toml';
import grammar from '../../spec/data/grammar.toml';
import limits from '../../spec/data/limits.toml';
import stdlib from '../../spec/data/stdlib.toml';
import { functionContract } from '../grammar/function-contract';
import units from '../../spec/data/units.toml';
import version from '../../spec/data/version.toml';
import corpus from '../../spec/data/corpus.toml';
import { compileCostModel, type CompiledCostModel } from '../costs/compile';
import { writeOutput } from '../go/output';
import { header, zigField, zigString, zigType } from './output';

const generated = resolve(import.meta.dir, '../../impl/zig/src/generated');
const stdlibSources = resolve(import.meta.dir, '../../spec/stdlib');

/** The stdlib Libraries' sources, which every Group holds, in stdlib.toml's order. */
const emitStdlibSources = async (): Promise<string> => {
  let out = `${header('tools/zig/generate.ts from spec/stdlib')}\n`;
  out +=
    'pub const Source = struct { name: []const u8, source: []const u8 };\n\n';
  out += 'pub const sources = [_]Source{\n';
  for (const name of stdlib.libraries as string[]) {
    const source = await readFile(
      resolve(stdlibSources, `${name}.talk`),
      'utf8',
    );
    out += `    .{ .name = ${zigString(name)}, .source = ${zigString(source)} },\n`;
  }
  return `${out}};\n`;
};

type Shape =
  | { kind: 'scalar'; type: 'bool' | 'i64' | 'Scalar' | 'text' }
  | { item: Shape; kind: 'array' }
  | {
      fields: [string, Shape, boolean][];
      kind: 'struct';
      name: string;
    };

const infer = (values: unknown[], name: string): Shape => {
  const kinds = new Set(
    values.map(value => (Array.isArray(value) ? 'array' : typeof value)),
  );
  if (kinds.size > 1) {
    // Instruction pops/pushes are an integer or a normative formula.
    if (kinds.has('array') || kinds.has('object')) {
      throw new Error(`${name} mixes tables or arrays with other values`);
    }
    return { kind: 'scalar', type: 'Scalar' };
  }
  if (kinds.has('array')) {
    return { kind: 'array', item: infer(values.flat(), `${name}Entry`) };
  }
  if (kinds.has('object')) {
    const objects = values as Record<string, unknown>[];
    const keys = [...new Set(objects.flatMap(Object.keys))];
    return {
      kind: 'struct',
      name,
      fields: keys.map(key => {
        const present = objects.filter(value => key in value);
        return [
          key,
          infer(
            present.map(value => value[key]),
            name + zigType(key),
          ),
          present.length < objects.length,
        ];
      }),
    };
  }
  if (kinds.has('number')) {
    if (values.some(value => !Number.isSafeInteger(value))) {
      throw new Error(`${name} holds a number that isn't a safe integer`);
    }
    return { kind: 'scalar', type: 'i64' };
  }
  return { kind: 'scalar', type: kinds.has('boolean') ? 'bool' : 'text' };
};

const typeName = (shape: Shape): string =>
  shape.kind === 'scalar'
    ? shape.type === 'text'
      ? '[]const u8'
      : shape.type
    : shape.kind === 'array'
      ? `[]const ${typeName(shape.item)}`
      : shape.name;

const indent = (depth: number) => '    '.repeat(depth);

const literal = (value: unknown, shape: Shape, depth: number): string => {
  if (shape.kind === 'scalar') {
    if (shape.type === 'Scalar') {
      return typeof value === 'number'
        ? `.{ .int = ${value} }`
        : typeof value === 'boolean'
          ? `.{ .boolean = ${value} }`
          : `.{ .text = ${zigString(value as string)} }`;
    }
    return typeof value === 'string' ? zigString(value) : String(value);
  }
  if (shape.kind === 'array') {
    const items = value as unknown[];
    return items.length === 0
      ? '&.{}'
      : `&.{\n${items
          .map(
            item =>
              `${indent(depth + 1)}${literal(item, shape.item, depth + 1)},\n`,
          )
          .join('')}${indent(depth)}}`;
  }
  const object = value as Record<string, unknown>;
  const fields = shape.fields.filter(([key]) => key in object);
  return fields.length === 0
    ? '.{}'
    : `.{\n${fields
        .map(
          ([key, field]) =>
            `${indent(depth + 1)}.${zigField(key)} = ${literal(object[key], field, depth + 1)},\n`,
        )
        .join('')}${indent(depth)}}`;
};

const scalarDeclaration =
  '/// A field whose Data File value is an integer in some entries and text in others.\n' +
  'pub const Scalar = union(enum) {\n' +
  '    int: i64,\n' +
  '    text: []const u8,\n' +
  '    boolean: bool,\n' +
  '};\n';

const usesScalar = (shape: Shape): boolean =>
  shape.kind === 'scalar'
    ? shape.type === 'Scalar'
    : shape.kind === 'array'
      ? usesScalar(shape.item)
      : shape.fields.some(([, field]) => usesScalar(field));

export const emitCatalogue = (
  name: string,
  data: unknown,
  sourceName = name,
): string => {
  const shape = infer([data], `${zigType(name)}Table`);
  const declarations: string[] = [];
  const declare = (item: Shape) => {
    if (item.kind === 'array') {
      declare(item.item);
    } else if (item.kind === 'struct') {
      declarations.push(
        `pub const ${item.name} = struct {\n${item.fields
          .map(
            ([key, field, optional]) =>
              `    ${zigField(key)}: ${optional ? `?${typeName(field)} = null` : typeName(field)},\n`,
          )
          .join('')}};\n`,
      );
      item.fields.forEach(([, field]) => declare(field));
    }
  };
  declare(shape);
  if (usesScalar(shape)) {
    declarations.push(scalarDeclaration);
  }
  return (
    header(`tools/zig/generate.ts from spec/data/${sourceName}.toml`) +
    `\n${declarations.join('\n')}\n` +
    `pub const ${zigField(name)}: ${typeName(shape)} = ${literal(data, shape, 0)};\n`
  );
};

// An Opcode is an instruction's index in the machine table. Interpreter loops
// dispatch on it; disassembly and Traces keep the instruction's name.
export const emitOpcodes = (instructions: { name: string }[]): string => {
  if (instructions.length > 256) {
    throw new Error('Opcode is a u8, but there are more instructions');
  }
  return (
    header('tools/zig/generate.ts from spec/data/machine.toml') +
    '\n' +
    "/// An instruction's index in `machine.instruction`.\n" +
    'pub const Opcode = enum(u8) {\n' +
    instructions.map(({ name }) => `    ${zigField(name)},\n`).join('') +
    '};\n'
  );
};

// The Cost Model's formulas as compiled terms, with named measure and subject
// codes, so the Zig Core evaluates a charge without parsing or lookups.
const term = ([measure, subject, factor, divisor]: readonly number[]) =>
  `.{ .measure = ${measure}, .subject = ${subject}, .factor = ${factor}, .divisor = ${divisor} }`;
// zig fmt pads a positional list with spaces only when it holds several items.
const terms = (list: readonly (readonly number[])[]) =>
  list.length === 0
    ? '&.{}'
    : list.length === 1
      ? `&.{${term(list[0]!)}}`
      : `&.{ ${list.map(term).join(', ')} }`;
export const emitCostTerms = (model: CompiledCostModel): string =>
  header('tools/zig/generate.ts from spec/data/costs.toml') +
  '\n' +
  '/// One compiled Cost Model term: factor * measure(subject) / divisor,\n' +
  '/// rounded up on its own. `measure_constant` is worth 1.\n' +
  'pub const CostTerm = struct {\n' +
  '    measure: u8,\n' +
  '    subject: u8,\n' +
  '    factor: i64,\n' +
  '    divisor: i64,\n' +
  '};\n\n' +
  'pub const CostRate = struct {\n' +
  '    key: []const u8,\n' +
  '    fuel: []const CostTerm,\n' +
  '    alloc: []const CostTerm,\n' +
  '};\n\n' +
  'pub const CostSize = struct {\n' +
  '    of: []const u8,\n' +
  '    terms: []const CostTerm,\n' +
  '};\n\n' +
  model.measures
    .map(
      (name, i) =>
        `pub const measure_${zigField(name).toLowerCase()} = ${i};\n`,
    )
    .join('') +
  '\n' +
  "/// `subject_x1` is a Built-in's first argument; `subject_x1 + n - 1` is its nth.\n" +
  model.subjects
    .map(
      (name, i) =>
        `pub const subject_${zigField(name).toLowerCase()} = ${i};\n`,
    )
    .join('') +
  '\n' +
  '/// Sorted by key, so a key is found by binary search.\n' +
  `pub const cost_rates = [_]CostRate{\n${[...model.rates]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(
      r =>
        `    .{ .key = ${zigString(r.key)}, .fuel = ${terms(r.fuel)}, .alloc = ${terms(r.alloc)} },\n`,
    )
    .join('')}};\n\n` +
  `pub const cost_sizes = [_]CostSize{\n${model.sizes
    .map(
      s => `    .{ .of = ${zigString(s.of)}, .terms = ${terms(s.terms)} },\n`,
    )
    .join('')}};\n`;

export const generateZigCatalogues = async (check: boolean): Promise<void> => {
  const write = (name: string, content: string) =>
    writeOutput(
      resolve(generated, `${name}.zig`),
      content,
      check,
      'bun run zig:generate',
    );
  await write('rates', emitCostTerms(compileCostModel(costs)));
  await write('opcodes', emitOpcodes(machine.instruction));
  await write('stdlib_sources', await emitStdlibSources());
  for (const [name, data] of Object.entries({
    machine,
    costs,
    errors,
    diagnostics,
    grammar,
    limits,
    stdlib: {
      ...stdlib,
      builtin: (stdlib.builtin as { call: string }[]).map(builtin => ({
        ...builtin,
        ...functionContract(builtin.call),
      })),
    },
    units,
    version,
    corpus,
  })) {
    await write(name, emitCatalogue(name, data));
  }
};

if (import.meta.main) {
  if (Bun.argv.slice(2).some(arg => arg !== '--check')) {
    throw new Error('Usage: bun tools/zig/generate.ts [--check]');
  }
  await generateZigCatalogues(Bun.argv.includes('--check'));
}
