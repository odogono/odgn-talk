// Test helper: a save's records, with each value kept as its bytes, and
// those records written back as a save, so a test can change one field.
import { TextTable } from '../src/save-format';
import { readRecords, writeRecords } from '../src/save-file';
import { type SaveRecords, type ValueIO } from '../src/save-records';
import { skipValue } from '../src/save-values';

/** A value as its encoded bytes. */
export type RawValue = { bytes: Uint8Array };
export const raw: ValueIO<RawValue> = {
  read: r => {
    const start = r.pos;
    skipValue(r);
    return { bytes: r.input.slice(start, r.pos) };
  },
  write: (w, v) => {
    w.raw(v.bytes);
  },
};
export const rawValue = (bytes: number[]): RawValue => ({
  bytes: Uint8Array.from(bytes),
});

export const recordsOf = (bytes: Uint8Array) => {
  const { header, texts, ...records } = readRecords(bytes, raw);
  return {
    save: header,
    records: records as SaveRecords<RawValue>,
    names: texts,
  };
};

/** A save with its records changed by `edit`, framed and digested again. */
export const editSave = (
  bytes: Uint8Array,
  edit: (records: SaveRecords<RawValue>) => void,
  header: (h: { language: string }) => void = () => {},
): Uint8Array => {
  const { save, records, names } = recordsOf(bytes);
  edit(records);
  const h = { ...save };
  header(h);
  // A raw value keeps its texts' positions, so the table keeps its order.
  return writeRecords(h, records, raw, new TextTable(names));
};
