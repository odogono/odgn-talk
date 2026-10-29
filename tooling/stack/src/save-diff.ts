// Shows where two saves differ (#1713). It decodes a save by interpreting the
// save format's schema (spec/data/save-format.toml, ADR 0144), so it reads a
// save from any Core and needs no change when the format does, and it names
// each part by a path in domain terms. Tooling only: it is outside parity and
// the Embedding API, and it never restores a save.
import { saveSchema as generated } from './generated/save-format';

type Field = { name: string; type: string; unless?: string };

/** A decoded part of a save. */
export type SaveNode =
  | { kind: 'leaf'; text: string }
  | {
      fields: [string, SaveNode][];
      kind: 'fields';
      /** Its record or union. */
      type: string;
      variant?: string;
    }
  | { items: [string, SaveNode][]; kind: 'list' };

/** A decoded save: its header fields, then each section by name. */
export type DecodedSave = {
  header: [string, SaveNode][];
  sections: [string, SaveNode][];
  stateFingerprint: string;
};

/** One differing part: its path, and what each save holds there. */
export type SaveDifference = { a: string; b: string; path: string };

export type SaveDiff = {
  /** Parts of the saved state that differ, each by path. */
  differences: SaveDifference[];
  /**
   * Differences outside the state: the Trace save id counter and optional
   * sections. Saves that differ only here are in the same state.
   */
  notes: SaveDifference[];
  /** Whether the State Fingerprints are equal. */
  sameState: boolean;
};

type Schema = {
  header: readonly Field[];
  magic: string;
  records: readonly { fields: readonly Field[]; name: string }[];
  sections: readonly {
    fields: readonly Field[];
    name: string;
    required: boolean;
    tag: number;
  }[];
  unions: readonly {
    name: string;
    variants: readonly {
      fields: readonly Field[];
      name: string;
      tag: number;
    }[];
  }[];
  version: number;
};
const saveSchema: Schema = generated;

const records = new Map(saveSchema.records.map(r => [r.name, r]));
const unions = new Map(saveSchema.unions.map(u => [u.name, u]));
const sectionsByTag = new Map(saveSchema.sections.map(s => [s.tag, s]));

const fail = (why: string): never => {
  throw new Error(`invalid save: ${why}`);
};

const hex = (bytes: Uint8Array) =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.bytes.length) {
      fail('it ends early');
    }
    return this.bytes[this.pos++]!;
  }

  raw(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) {
      fail('it ends early');
    }
    return this.bytes.subarray(this.pos, (this.pos += n));
  }

  uint(): bigint {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = this.byte();
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return value;
      }
    }
  }

  sint(): bigint {
    let value = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.byte();
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return b & 0x40 ? value - (1n << shift) : value;
  }

  count(): number {
    const n = Number(this.uint());
    if (n > this.bytes.length - this.pos) {
      fail(`a count of ${n} is longer than the save`);
    }
    return n;
  }

  text(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      this.raw(this.count()),
    );
  }
}

const leaf = (text: string): SaveNode => ({ kind: 'leaf', text });

/** The singular of a list field's name, for its items' labels. */
const singular = (name: string) =>
  name.endsWith('ies')
    ? `${name.slice(0, -3)}y`
    : name.endsWith('s')
      ? name.slice(0, -1)
      : name;

const fieldOf = (node: SaveNode, name: string): SaveNode | undefined =>
  node.kind === 'fields'
    ? node.fields.find(([field]) => field === name)?.[1]
    : undefined;

class Decoder {
  constructor(
    readonly r: Reader,
    readonly texts: readonly string[],
  ) {}

  type(type: string, item = ''): SaveNode {
    if (type.startsWith('list of ')) {
      const of = type.slice(8);
      const n = this.r.count();
      const items: [string, SaveNode][] = [];
      for (let i = 0; i < n; i++) {
        const node = this.type(of);
        items.push([labelOf(item || of, i, node), node]);
      }
      return { kind: 'list', items };
    }
    if (type.startsWith('optional ')) {
      return this.r.byte() ? this.type(type.slice(9), item) : leaf('none');
    }
    const record = records.get(type);
    if (record) {
      return { kind: 'fields', type, fields: this.fields(record.fields) };
    }
    const union = unions.get(type);
    if (union) {
      const tag = this.r.byte();
      const variant =
        union.variants.find(v => v.tag === tag) ??
        fail(`${type} has no variant ${tag}`);
      return {
        kind: 'fields',
        type,
        variant: variant.name,
        fields: this.fields(variant.fields),
      };
    }
    return this.primitive(type);
  }

  fields(fields: readonly Field[]): [string, SaveNode][] {
    const out: [string, SaveNode][] = [];
    for (const { name, type, unless } of fields) {
      if (unless !== undefined) {
        const other = out.find(([field]) => field === unless)?.[1];
        if (other?.kind !== 'leaf' || other.text !== 'none') {
          continue;
        }
      }
      out.push([
        name,
        this.type(type, type.startsWith('list of ') ? singular(name) : ''),
      ]);
    }
    // A list whose names a sibling `<item> names` list holds, like a Script's
    // variables, labels each item by its name.
    for (const [name, node] of out) {
      const names = out.find(
        ([field]) => field === `${singular(name)} names`,
      )?.[1];
      if (node.kind === 'list' && names?.kind === 'list') {
        node.items = node.items.map(([label, item], i) => {
          const named = names.items[i]?.[1];
          return [
            named?.kind === 'leaf'
              ? `${singular(name)} ${named.text.replace(/^"(.*)"$/su, '$1')} (#${i})`
              : label,
            item,
          ];
        });
      }
    }
    return out;
  }

  primitive(type: string): SaveNode {
    const r = this.r;
    switch (type) {
      case 'byte':
        return leaf(String(r.byte()));
      case 'bool': {
        const b = r.byte();
        return b > 1 ? fail(`bool ${b}`) : leaf(b ? 'true' : 'false');
      }
      case 'uint':
      case 'index':
        return leaf(String(r.uint()));
      case 'sint':
        return leaf(String(r.sint()));
      case 'ref': {
        const ref = r.uint();
        return leaf(ref === 0n ? 'none' : `#${ref - 1n}`);
      }
      case 'name': {
        const i = Number(r.uint());
        const text = this.texts[i] ?? fail(`no text ${i}`);
        return leaf(JSON.stringify(text));
      }
      case 'text':
        return leaf(JSON.stringify(r.text()));
      case 'bytes':
        return leaf(hex(r.raw(r.count())));
      case 'digest':
        return leaf(hex(r.raw(32)));
      case 'magic':
        return leaf(new TextDecoder().decode(r.raw(4)));
      default:
        return fail(`the schema has no type ${type}`);
    }
  }
}

/** A list item's label: its name or id when it has one, else its position. */
const labelOf = (item: string, i: number, node: SaveNode) => {
  const named = fieldOf(node, 'name');
  if (named?.kind === 'leaf' && named.text.startsWith('"')) {
    return `${item} ${named.text}`;
  }
  const id = fieldOf(node, 'id');
  if (id?.kind === 'leaf') {
    return `${item} ${id.text.replace(/^"(.*)"$/su, '$1')}`;
  }
  return `${item} ${i}`;
};

/** Decodes a save from any Core, by the save format's schema. */
export const decodeSave = (bytes: Uint8Array): DecodedSave => {
  const r = new Reader(bytes);
  const header: [string, SaveNode][] = [];
  const frames: { body: Uint8Array; tag: number }[] = [];
  for (const { name, type } of saveSchema.header) {
    if (name === 'sections') {
      const n = r.count();
      for (let i = 0; i < n; i++) {
        const tag = r.byte();
        r.byte();
        const length = r.count();
        r.raw(32);
        frames.push({ tag, body: r.raw(length) });
      }
      continue;
    }
    const node = new Decoder(r, []).primitive(type);
    if (
      name === 'magic' &&
      node.kind === 'leaf' &&
      node.text !== saveSchema.magic
    ) {
      fail(`magic ${node.text}`);
    }
    if (
      name === 'format' &&
      node.kind === 'leaf' &&
      node.text !== String(saveSchema.version)
    ) {
      fail(`format ${node.text}; this tool reads ${saveSchema.version}`);
    }
    header.push([name, node]);
  }
  if (r.pos !== bytes.length) {
    fail('bytes follow the last section');
  }
  // Every `name` points into `texts`, so it is read first.
  const texts: string[] = [];
  const textsFrame = frames.find(
    f => sectionsByTag.get(f.tag)?.name === 'texts',
  );
  if (textsFrame) {
    const tr = new Reader(textsFrame.body);
    for (let n = tr.count(), i = 0; i < n; i++) {
      texts.push(tr.text());
    }
  }
  const sections: [string, SaveNode][] = frames.map(({ tag, body }) => {
    const section = sectionsByTag.get(tag);
    if (!section) {
      return [`section ${tag}`, leaf(hex(body))];
    }
    const br = new Reader(body);
    const node: SaveNode = {
      kind: 'fields',
      type: section.name,
      fields: new Decoder(br, texts).fields(section.fields),
    };
    if (br.pos !== body.length) {
      fail(`bytes follow the ${section.name} section's last field`);
    }
    return [section.name, node];
  });
  const fingerprint = header.find(
    ([name]) => name === 'state fingerprint',
  )?.[1];
  return {
    header,
    sections,
    stateFingerprint: fingerprint?.kind === 'leaf' ? fingerprint.text : '',
  };
};

/** A Decimal as its digits, like `-1.25`. */
const decimalText = (n: SaveNode) => {
  const part = (name: string) => {
    const f = fieldOf(n, name);
    return f?.kind === 'leaf' ? f.text : '';
  };
  const digits = part('coefficient');
  const exponent = Number(part('exponent'));
  const sign = part('negative') === 'true' ? '-' : '';
  if (exponent >= 0) {
    return `${sign}${digits}${'0'.repeat(exponent)}`;
  }
  const padded = digits.padStart(1 - exponent, '0');
  return `${sign}${padded.slice(0, exponent)}.${padded.slice(exponent)}`;
};

/** A part in one line, cut short if it is long. */
export const renderSaveNode = (node: SaveNode, max = 120): string => {
  const full = (n: SaveNode): string => {
    if (n.kind === 'leaf') {
      return n.text;
    }
    if (n.kind === 'list') {
      return `[${n.items.map(([, item]) => full(item)).join(', ')}]`;
    }
    if (n.type === 'decimal') {
      return decimalText(n);
    }
    if (n.variant !== undefined && n.fields.length <= 1) {
      return [n.variant, ...n.fields.map(([, v]) => full(v))].join(' ');
    }
    const fields = n.fields.map(([f, v]) => `${f}: ${full(v)}`).join(', ');
    return `${n.variant ?? ''}{${fields}}`;
  };
  const text = full(node);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A part as an indented tree, one line per leaf. */
export const dumpSaveNode = (
  name: string,
  node: SaveNode,
  indent = '',
): string[] => {
  if (node.kind === 'leaf') {
    return [`${indent}${name}: ${node.text}`];
  }
  const head =
    node.kind === 'fields' && node.variant ? `${name}: ${node.variant}` : name;
  const children = node.kind === 'list' ? node.items : node.fields;
  return [
    node.kind === 'list' ? `${head} (${children.length})` : head,
    ...children.flatMap(([child, n]) => dumpSaveNode(child, n, `${indent}  `)),
  ].map((line, i) => (i === 0 ? `${indent}${line.trimStart()}` : line));
};

/** A decoded save as an indented tree. */
export const dumpSave = (save: DecodedSave): string =>
  [
    ...save.header.flatMap(([name, node]) => dumpSaveNode(name, node)),
    ...save.sections.flatMap(([name, node]) => dumpSaveNode(name, node)),
  ].join('\n');

const sameNode = (a: SaveNode, b: SaveNode) =>
  renderSaveNode(a, Infinity) === renderSaveNode(b, Infinity);

const diffNode = (
  path: string[],
  a: SaveNode,
  b: SaveNode,
  out: SaveDifference[],
) => {
  const report = () =>
    out.push({
      path: path.join(' / '),
      a: renderSaveNode(a),
      b: renderSaveNode(b),
    });
  if (a.kind === 'leaf' || b.kind === 'leaf' || a.kind !== b.kind) {
    if (!sameNode(a, b)) {
      report();
    }
    return;
  }
  if (a.kind === 'fields' && b.kind === 'fields') {
    // A Script value differs as a whole.
    if (a.variant !== b.variant || a.type === 'value') {
      if (!sameNode(a, b)) {
        report();
      }
      return;
    }
    for (const [name, an] of a.fields) {
      const bn = fieldOf(b, name);
      if (!bn) {
        report();
        return;
      }
      // A list's items name themselves, and a part with one field, like most
      // values, needs no segment for it.
      const skip = an.kind === 'list' || a.fields.length === 1;
      diffNode(skip ? path : [...path, name], an, bn, out);
    }
    return;
  }
  if (a.kind === 'list' && b.kind === 'list') {
    const n = Math.max(a.items.length, b.items.length);
    const parent = path;
    for (let i = 0; i < n; i++) {
      const ai = a.items[i];
      const bi = b.items[i];
      if (ai && bi) {
        diffNode([...parent, ai[0]], ai[1], bi[1], out);
      } else {
        out.push({
          path: [...parent, (ai ?? bi)![0]].join(' / '),
          a: ai ? renderSaveNode(ai[1]) : '(absent)',
          b: bi ? renderSaveNode(bi[1]) : '(absent)',
        });
      }
    }
  }
};

const optionalSections = new Set(
  saveSchema.sections.filter(s => !s.required).map(s => s.name),
);

/**
 * Where two saves differ, by path. The State Fingerprint says whether they
 * are in the same state; the Trace save id counter and optional sections are
 * reported as notes, outside the state. Texts are compared by content, not by
 * their position in the `texts` table.
 */
export const diffSaves = (a: Uint8Array, b: Uint8Array): SaveDiff => {
  const da = decodeSave(a);
  const db = decodeSave(b);
  const differences: SaveDifference[] = [];
  const notes: SaveDifference[] = [];
  for (const [name, an] of da.header) {
    const bn = db.header.find(([n]) => n === name)?.[1];
    if (!bn || name === 'state fingerprint' || name === 'body digest') {
      continue;
    }
    diffNode([name], an, bn, name === 'save id counter' ? notes : differences);
  }
  const names = new Set([...da.sections, ...db.sections].map(([name]) => name));
  for (const name of names) {
    if (name === 'texts') {
      continue;
    }
    const an = da.sections.find(([n]) => n === name)?.[1];
    const bn = db.sections.find(([n]) => n === name)?.[1];
    const into =
      optionalSections.has(name) || name.startsWith('section ')
        ? notes
        : differences;
    if (!an || !bn) {
      into.push({
        path: name,
        a: an ? 'present' : '(absent)',
        b: bn ? 'present' : '(absent)',
      });
      continue;
    }
    // A section's field named like the section takes no extra segment.
    const node =
      an.kind === 'fields' && bn.kind === 'fields' ? { an, bn } : undefined;
    if (!node) {
      diffNode([name], an, bn, into);
      continue;
    }
    for (const [field, af] of node.an.fields) {
      const bf = fieldOf(node.bn, field);
      if (bf) {
        const at =
          field === name ? [] : af.kind === 'list' ? [name] : [name, field];
        diffNode(at, af, bf, into);
      }
    }
  }
  return {
    sameState: da.stateFingerprint === db.stateFingerprint,
    differences,
    notes,
  };
};
