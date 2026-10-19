import { isDeepStrictEqual } from 'node:util';
import {
  BinaryReader,
  children,
  itemInteger,
  type BinaryItem,
} from '../../impl/ts/src/binary-value';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
} from '../../impl/ts/src/request-pump-binary';
import {
  isJsonNumber,
  isJsonObject,
  readOrderedJSON,
  type Json,
} from '../../impl/ts/src/readers';
import { type Catalogue, type Field, type Vector, hexTag } from './catalogue';

// Protocol object order is immaterial; numeric source text must stay exact.
// Re-encoding separately checks ordered Value Maps and canonical bytes.
const tree = (j: Json): unknown =>
  isJsonNumber(j)
    ? { number: j.source }
    : isJsonObject(j)
      ? {
          object: j.pairs
            .map(([k, v]) => [k, tree(v)])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        }
      : Array.isArray(j)
        ? j.map(tree)
        : j;

const checkItem = (item: BinaryItem, field: Field) => {
  if (item.tag === 0) {
    if (field.required) {
      throw new Error(`Missing required field ${field.name}`);
    }
    return;
  }
  const valid = (() => {
    switch (field.kind) {
      case 'uint':
        return [3, 16].includes(item.tag) && itemInteger(item) >= 0n;
      case 'int':
        return [3, 16].includes(item.tag);
      case 'text':
        return item.tag === 18;
      case 'instant':
        return item.tag === 11;
      case 'bool':
        return item.tag === 1 || item.tag === 2;
      case 'texts':
        return item.tag === 6 && children(item).every(i => i.tag === 18);
      case 'values':
      case 'settlements':
        return item.tag === 6;
      case 'target':
      case 'message':
      case 'limits':
      case 'err':
        return item.tag === 7;
      // Nested protocol records keep their hand-written reshaping, including
      // sentinel items refused later by ordinary admission rules.
      case 'record':
      case 'value':
        return true;
      default:
        return false;
    }
  })();
  if (!valid) {
    throw new Error(`Wrong ${field.kind} item for ${field.name}`);
  }
};

export const checkVectors = (data: Catalogue, vectors: Vector[]) => {
  const covered = new Set<number>();
  const reports = new Set<number>();
  const names = new Set<string>();
  for (const vector of vectors) {
    if (!vector.name || names.has(vector.name)) {
      throw new Error(`Missing or duplicate vector name: ${vector.name}`);
    }
    names.add(vector.name);
    if (
      !/^(?:[\da-f]{2})+$/.test(vector.hex) ||
      typeof vector.tree !== 'string'
    ) {
      throw new Error(`Invalid vector ${vector.name}`);
    }
    const bytes = Uint8Array.from(Buffer.from(vector.hex, 'hex'));
    const r = new BinaryReader(bytes);
    for (const b of [0x4e, 0x54, 0x42, 1, 1]) {
      if (r.byte() !== b) {
        throw new Error(`Invalid fields prefix in ${vector.name}`);
      }
    }
    const tag = r.byte();
    const entry = data.messages.find(e => e.tag === tag);
    if (!entry || vector.tag !== tag || vector.direction !== entry.direction) {
      throw new Error(`Wrong tag or direction in ${vector.name}`);
    }
    if (r.byte() !== 6 || r.uint() !== BigInt(entry.fields.length)) {
      throw new Error(`Wrong field count in ${vector.name}`);
    }
    covered.add(tag);
    for (const field of entry.fields) {
      if (field.kind !== 'reports' || r.data[r.at] === 0) {
        checkItem(r.item(), field);
        continue;
      }
      if (r.byte() !== 6) {
        throw new Error(`Wrong reports item in ${vector.name}`);
      }
      const count = r.count();
      for (let i = 0; i < count; i++) {
        const reportTag = r.byte();
        const report = data.reports.find(e => e.tag === reportTag);
        if (
          !report ||
          r.byte() !== 6 ||
          r.uint() !== BigInt(report.fields.length)
        ) {
          throw new Error(`Wrong Report tag/count in ${vector.name}`);
        }
        reports.add(reportTag);
        for (const field of report.fields) {
          checkItem(r.item(), field);
        }
      }
    }
    r.done();
    const expected = readOrderedJSON(vector.tree);
    const decoded = decodeBinaryFrame(bytes.buffer);
    if (!isDeepStrictEqual(tree(expected), tree(decoded))) {
      throw new Error(`Decoded tree differs in ${vector.name}`);
    }
    for (const node of [expected, decoded]) {
      if (Buffer.from(encodeBinaryFrame(node)).toString('hex') !== vector.hex) {
        throw new Error(`Re-encoded bytes differ in ${vector.name}`);
      }
    }
  }
  for (const [entries, tags, family] of [
    [data.messages, covered, 'message'],
    [data.reports, reports, 'Report'],
  ] as const) {
    for (const entry of entries) {
      if (!tags.has(entry.tag)) {
        throw new Error(
          `No vector for ${family} ${hexTag(entry.tag)} (${entry.name})`,
        );
      }
    }
  }
};
