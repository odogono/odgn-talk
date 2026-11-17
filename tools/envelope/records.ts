// Typed records for every catalogued message, Report, settlement and view
// (ADR 0183). Field descriptors stay the tables; a record names its fields'
// types so a Host maps public options to typed fields, not string keys.
// Kinds whose shape a codec still reshapes (Values, targets, nested records)
// stay opaque here.
import type { Catalogue, Field } from './catalogue';

export type RecordSpec = {
  family: 'message' | 'json message' | 'Report' | 'settlement' | 'view';
  fields: Field[];
  /** Catalogue name, as the wire and the tables spell it. */
  name: string;
  /** Language-neutral type name, PascalCase. */
  type: string;
};

const parts = (name: string) => name.split(/[\s-]+/);
const upper = (w: string) => w[0]!.toUpperCase() + w.slice(1);
export const typeName = (name: string) => parts(name).map(upper).join('');
const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, c => `_${c.toLowerCase()}`);

export const records = (data: Catalogue): RecordSpec[] => {
  const all: RecordSpec[] = [
    ...data.messages.map(e => ({
      name: e.name,
      type: typeName(e.name),
      family: 'message' as const,
      fields: e.fields,
    })),
    ...data.json_messages.map(e => ({
      name: e.name,
      type: typeName(e.name),
      family: 'json message' as const,
      fields: e.fields,
    })),
    ...data.reports.map(e => ({
      name: e.name,
      type: `${typeName(e.name)}Report`,
      family: 'Report' as const,
      fields: e.fields,
    })),
    {
      name: 'settlement',
      type: 'SettlementRecord',
      family: 'settlement',
      fields: data.settlement.fields,
    },
    ...data.views.map(e => ({
      name: e.name,
      type: typeName(e.name),
      family: 'view' as const,
      fields: e.fields,
    })),
  ];
  const seen = new Set<string>();
  for (const r of all) {
    if (seen.has(r.type)) {
      throw new Error(`Record type ${r.type} is generated twice`);
    }
    seen.add(r.type);
  }
  return all;
};

const viewType = (data: Catalogue, f: Field) =>
  typeName(data.views.find(v => v.name === f.view)!.name);

// TypeScript: opaque kinds are ordered Json, as the codecs read them.
const tsType = (data: Catalogue, f: Field): string => {
  switch (f.kind) {
    case 'int':
      return 'number';
    case 'uint':
      return 'bigint';
    case 'bool':
      return 'boolean';
    case 'text':
    case 'instant':
      return 'string';
    case 'texts':
      return 'readonly string[]';
    case 'views':
      return `readonly Envelope${viewType(data, f)}[]`;
    case 'pairs':
      return 'readonly (readonly [string, Json])[]';
    default:
      return 'Json';
  }
};

export const emitTypeScriptRecords = (data: Catalogue): string =>
  records(data)
    .map(
      r =>
        `/** The ${r.family} \`${r.name}\`. */\nexport type Envelope${r.type} = {\n${r.fields
          .map(
            f =>
              `  readonly ${f.name}${f.required ? '' : '?'}: ${tsType(data, f)};`,
          )
          .join('\n')}\n};`,
    )
    .join('\n');

// Go: encoding/json reads and writes the JSON layout through the tags.
const goScalar = (data: Catalogue, f: Field): [string, boolean] => {
  switch (f.kind) {
    case 'int':
      return ['int64', true];
    case 'uint':
      return ['uint64', true];
    case 'bool':
      return ['bool', true];
    case 'text':
    case 'instant':
      return ['string', true];
    case 'texts':
      return ['[]string', false];
    case 'views':
      return [`[]Envelope${viewType(data, f)}`, false];
    case 'pairs':
      return ['[][2]any', false];
    default:
      return ['any', false];
  }
};

export const emitGoRecords = (data: Catalogue): string =>
  [
    ...records(data).map(
      r =>
        `// Envelope${r.type} is the ${r.family} ${quoteGo(r.name)}.\ntype Envelope${r.type} struct {\n${r.fields
          .map(f => {
            const [type, scalar] = goScalar(data, f);
            const optional = !f.required;
            return `${upper(f.name)} ${optional && scalar ? '*' : ''}${type} \`json:"${f.name}${optional ? ',omitempty' : ''}"\``;
          })
          .join('\n')}\n}`,
    ),
    `// EnvelopeRecords makes an empty record for each catalogued name, keyed by\n// family and name as the vectors spell them.\nvar EnvelopeRecords = map[string]func() any{\n${records(
      data,
    )
      .map(
        r =>
          `${quoteGo(`${r.family}:${r.name}`)}: func() any { return &Envelope${r.type}{} },`,
      )
      .join('\n')}\n}`,
  ].join('\n');
const quoteGo = (s: string) => JSON.stringify(s);

// Zig: std.json parses the JSON layout into these; a comptime walk over the
// same declarations serves the fields layout.
const zigType = (data: Catalogue, f: Field): string => {
  switch (f.kind) {
    case 'int':
      return 'i64';
    case 'uint':
      return 'u64';
    case 'bool':
      return 'bool';
    case 'text':
    case 'instant':
      return '[]const u8';
    case 'texts':
      return '[]const []const u8';
    case 'views':
      return `[]const ${viewType(data, f)}`;
    case 'pairs':
      return '[]const Pair';
    default:
      return 'std.json.Value';
  }
};

export const emitZigRecords = (data: Catalogue): string =>
  [
    '/// A `pairs` item: a name and its Value Encoding.',
    'pub const Pair = struct { []const u8, std.json.Value };',
    ...records(data).map(
      r =>
        `/// The ${r.family} \`${r.name}\`.\npub const ${r.type} = struct {\n${r.fields
          .map(
            f =>
              `    ${zigField(f.name)}: ${f.required ? '' : '?'}${zigType(data, f)}${f.required ? '' : ' = null'},`,
          )
          .join('\n')}\n};`,
    ),
    '/// Each record by family and catalogue name.',
    `pub const records = .{\n${records(data)
      .map(
        r =>
          `    .{ ${JSON.stringify(r.family)}, ${JSON.stringify(r.name)}, ${r.type} },`,
      )
      .join('\n')}\n};`,
  ].join('\n');
const zigKeywords = new Set(['fn', 'error', 'type', 'test', 'and', 'or']);
const zigField = (name: string) =>
  zigKeywords.has(name) ? `@"${name}"` : name;

// Elixir: one struct per record, keyed by snake_case atoms, with each field's
// wire name in `fields/0`.
const exType = (data: Catalogue, f: Field): string => {
  switch (f.kind) {
    case 'int':
      return 'integer()';
    case 'uint':
      return 'non_neg_integer()';
    case 'bool':
      return 'boolean()';
    case 'text':
    case 'instant':
      return 'String.t()';
    case 'texts':
      return '[String.t()]';
    case 'views':
      return `[NorthTalk.Generated.Envelope.${viewType(data, f)}.t()]`;
    case 'pairs':
      return '[[term()]]';
    default:
      return 'term()';
  }
};

export const emitElixirRecords = (data: Catalogue): string =>
  [
    ...records(data).map(r => {
      const rows = r.fields.map(
        f =>
          `%{key: :${snake(f.name)}, name: ${JSON.stringify(f.name)}, kind: :${f.kind}, required: ${f.required}, host: ${f.host !== false}${f.view ? `, view: ${JSON.stringify(f.view)}` : ''}}`,
      );
      return `defmodule NorthTalk.Generated.Envelope.${r.type} do
  @moduledoc false
  # The ${r.family} ${JSON.stringify(r.name)}.
  defstruct [
${r.fields.map(f => `    :${snake(f.name)}`).join(',\n')}
  ]

  @type t :: %__MODULE__{
${r.fields.map(f => `          ${snake(f.name)}: ${exType(data, f)}${f.required ? '' : ' | nil'}`).join(',\n')}
        }

  @fields [
${rows.map(row => `    ${row}`).join(',\n')}
  ]
  def fields, do: @fields
end`;
    }),
    `defmodule NorthTalk.Generated.Envelope.Records do
  @moduledoc false
  @records %{
${records(data)
  .map(
    r =>
      `    {${JSON.stringify(r.family)}, ${JSON.stringify(r.name)}} => NorthTalk.Generated.Envelope.${r.type}`,
  )
  .join(',\n')}
  }
  def records, do: @records
end`,
  ].join('\n\n');
