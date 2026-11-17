// Chapter 9's method table stays prose (ADR 0183); this keeps each row that
// names a catalogued message in step with the catalogue.
import type { Catalogue, Field } from './catalogue';

const cells = (row: string) =>
  row
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map(c => c.trim());
const ticked = (cell: string) =>
  [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]!);
const names = (cell: string) =>
  ticked(cell).filter(t => /^[a-z][A-Za-z-]*$/.test(t));

export const checkMethodTable = (data: Catalogue, chapter: string) => {
  const start = chapter.indexOf('| Message | Fields | Reply |');
  if (start < 0) {
    throw new Error('Chapter 9 method table not found');
  }
  const rows = chapter
    .slice(start)
    .split('\n')
    .slice(2)
    .filter((line, i, all) => all.slice(0, i + 1).every(l => l.startsWith('|')))
    .map(cells);
  const views = new Map(data.views.map(v => [v.name, v]));
  const viewFields = (name: string): Field[] =>
    views
      .get(name)!
      .fields.flatMap(f => [f, ...(f.view ? viewFields(f.view) : [])]);
  // Fields-only messages have their own generated tables; the method table
  // describes the JSON layout.
  const catalogued = [
    ...data.messages
      .filter(m => m.layouts.includes('json'))
      .map(m => ({ ...m, reply: undefined as string | undefined })),
    ...data.json_messages,
  ];
  const problems: string[] = [];
  for (const message of catalogued) {
    const row = rows.find(r => names(r[0]!).includes(message.name));
    if (!row) {
      problems.push(`${message.name}: no row`);
      continue;
    }
    const [, fields = '', reply = ''] = row;
    const tokens = ticked(fields);
    for (const f of message.fields) {
      if (
        f.host !== false &&
        !tokens.some(t => new RegExp(`^${f.name}(?![A-Za-z0-9])`).test(t))
      ) {
        problems.push(`${message.name}: row lacks \`${f.name}\``);
      }
    }
    const rowMessages = catalogued.filter(m => names(row[0]!).includes(m.name));
    for (const t of tokens) {
      const name = /^([A-Za-z]+)(?: \(V\))?$/.exec(t)?.[1];
      if (name && !rowMessages.some(m => m.fields.some(f => f.name === name))) {
        problems.push(
          `${message.name}: row names \`${name}\`, not in the catalogue`,
        );
      }
    }
    for (const f of message.reply ? viewFields(message.reply) : []) {
      if (!new RegExp(String.raw`\b${f.name}\b`).test(reply)) {
        problems.push(`${message.name}: reply lacks ${f.name}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Chapter 9 method table drifts from envelope.toml:\n${[...new Set(problems)].join('\n')}`,
    );
  }
};
