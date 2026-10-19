import Ajv2020 from 'ajv/dist/2020';
import schema from '../../spec/data/schema/envelope.schema.json';

export type Field = { kind: string; name: string; required: boolean };
export type Entry = {
  direction: 'host-to-guest' | 'guest-to-host';
  fields: Field[];
  name: string;
  tag: number;
};
export type Catalogue = {
  features: string[];
  intentional_kinds: { kinds: string[]; name: string; reason: string }[];
  messages: Entry[];
  reports: Entry[];
  settlement: { fields: Field[] };
};
export type Vector = {
  direction: Entry['direction'];
  hex: string;
  name: string;
  tag: number;
  /** Ordered JSON text preserves u64 numbers and Value Map order. */
  tree: string;
};

const validate = new Ajv2020({ allErrors: true }).compile(schema);
const unique = (values: (string | number)[], label: string) => {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}`);
  }
};

export const validateCatalogue: (
  value: unknown,
) => asserts value is Catalogue = value => {
  if (!validate(value)) {
    throw new Error(
      `Invalid envelope catalogue: ${JSON.stringify(validate.errors)}`,
    );
  }
  const data = value as Catalogue;
  for (const [label, entries] of Object.entries({
    messages: data.messages,
    reports: data.reports,
  })) {
    unique(
      entries.map(e => e.tag),
      `${label} tag`,
    );
    unique(
      entries.map(e => e.name),
      `${label} name`,
    );
    for (const entry of entries) {
      const direction =
        label === 'reports' || entry.tag >= 0x80
          ? 'guest-to-host'
          : 'host-to-guest';
      if (
        entry.direction !== direction ||
        (label === 'reports' && entry.tag >= 0x80)
      ) {
        throw new Error(`Invalid ${label} tag/direction for ${entry.name}`);
      }
    }
  }
  const kinds = new Map<string, Set<string>>();
  for (const entry of [...data.messages, ...data.reports, data.settlement]) {
    unique(
      entry.fields.map(f => f.name),
      'field name',
    );
    for (const field of entry.fields) {
      const used = kinds.get(field.name) ?? new Set<string>();
      used.add(field.kind);
      kinds.set(field.name, used);
    }
  }
  unique(
    data.intentional_kinds.map(e => e.name),
    'intentional kind name',
  );
  for (const [name, used] of kinds) {
    const intentional = data.intentional_kinds.find(e => e.name === name);
    if (
      used.size > 1 &&
      (!intentional ||
        [...used].sort().join() !== [...intentional.kinds].sort().join())
    ) {
      throw new Error(
        `Unmarked kind conflict for ${name}: ${[...used].join(', ')}`,
      );
    }
  }
  for (const intentional of data.intentional_kinds) {
    const used = kinds.get(intentional.name);
    if (
      !used ||
      used.size < 2 ||
      [...used].sort().join() !== [...intentional.kinds].sort().join()
    ) {
      throw new Error(`Stale intentional kinds for ${intentional.name}`);
    }
  }
};

export const hexTag = (tag: number) => tag.toString(16).padStart(2, '0');
const table = (head: string[], rows: string[][]) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
const entriesTable = (entries: Entry[], label: string) =>
  table(
    ['Tag', label, 'Direction', 'Fields in order'],
    entries.map(e => [
      `\`${hexTag(e.tag)}\``,
      e.name,
      e.direction,
      e.fields.map(f => f.name).join(', '),
    ]),
  );

export const envelopeViews = (data: Catalogue): Record<string, string> => {
  const all = [
    ...data.messages,
    ...data.reports,
    { name: 'settlement', ...data.settlement },
  ];
  const names = [
    ...new Set(all.flatMap(e => e.fields.map(f => f.name))),
  ].sort();
  return {
    'envelope.messages': entriesTable(
      data.messages.filter(e => e.tag <= 5 || e.tag === 0x81 || e.tag === 0x82),
      'Message',
    ),
    'envelope.callbacks': entriesTable(
      data.messages.filter(e => (e.tag >= 6 && e.tag <= 9) || e.tag >= 0x83),
      'Message',
    ),
    'envelope.settle-pump': entriesTable(
      data.messages.filter(e => e.tag === 10),
      'Message',
    ),
    'envelope.reports': entriesTable(data.reports, 'Report'),
    'envelope.fields': table(
      ['Field', 'Kinds by use'],
      names.map(name => [
        `\`${name}\``,
        [
          ...new Set(
            all.flatMap(e =>
              e.fields.filter(f => f.name === name).map(f => f.kind),
            ),
          ),
        ]
          .map(kind => {
            const uses = all.filter(e =>
              e.fields.some(f => f.name === name && f.kind === kind),
            );
            const conflict = data.intentional_kinds.some(e => e.name === name);
            return `\`${kind}\`${conflict ? ` (${uses.map(e => e.name).join(', ')})` : ''}`;
          })
          .join('; '),
      ]),
    ),
    'envelope.features': table(
      ['Negotiated feature'],
      data.features.map(f => [`\`${f}\``]),
    ),
    'envelope.settlement': table(
      ['Field', 'Kind', 'Required'],
      data.settlement.fields.map(f => [
        f.name,
        `\`${f.kind}\``,
        String(f.required),
      ]),
    ),
  };
};
