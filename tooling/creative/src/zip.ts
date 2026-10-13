// A small zip reader and writer (#739): stored (0) and deflate (8) only,
// through CompressionStream("deflate-raw"), with CRC-32, no encryption
// and no ZIP64. Framing follows PKWARE APPNOTE 6.3.9, section 4.3.

export class ZipError extends Error {}

export type ZipEntry = {
  data: Uint8Array;
  /** 0 stores the bytes as they are; 8 deflates them. Defaults to 0. */
  method?: 0 | 8;
  name: string;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const runStream = async (
  stream: CompressionStream | DecompressionStream,
  data: Uint8Array,
): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );

const deflate = (data: Uint8Array): Promise<Uint8Array> =>
  runStream(new CompressionStream('deflate-raw'), data);

const inflate = async (
  data: Uint8Array,
  entryName: string,
): Promise<Uint8Array> => {
  try {
    return await runStream(new DecompressionStream('deflate-raw'), data);
  } catch {
    throw new ZipError(`The entry "${entryName}" has damaged deflate data.`);
  }
};

// A fixed DOS date (1980-01-01) keeps written files byte-for-byte stable.
const DOS_TIME = 0;
const DOS_DATE = 0x21;
const UTF8_FLAG = 0x8_00;

/**
 * Writes the fields a local header and its central directory record share,
 * from "version needed" on; `at` is where that run starts in each.
 */
const writeCommon = (view: DataView, at: number, entry: Written): void => {
  view.setUint16(at, entry.method === 8 ? 20 : 10, true);
  view.setUint16(at + 2, UTF8_FLAG, true);
  view.setUint16(at + 4, entry.method, true);
  view.setUint16(at + 6, DOS_TIME, true);
  view.setUint16(at + 8, DOS_DATE, true);
  view.setUint32(at + 10, entry.crc, true);
  view.setUint32(at + 14, entry.compressed.length, true);
  view.setUint32(at + 18, entry.size, true);
  view.setUint16(at + 22, entry.nameBytes.length, true);
};

type Written = {
  compressed: Uint8Array;
  crc: number;
  method: 0 | 8;
  nameBytes: Uint8Array;
  offset: number;
  size: number;
};

/** Writes entries as one zip archive, in the order given. */
export const writeZip = async (
  entries: readonly ZipEntry[],
): Promise<Uint8Array> => {
  if (entries.length > 0xff_ff) {
    throw new ZipError('Too many entries for a zip without ZIP64.');
  }
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const written: Written[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };

  for (const entry of entries) {
    const method = entry.method ?? 0;
    const nameBytes = encoder.encode(entry.name);
    const compressed = method === 8 ? await deflate(entry.data) : entry.data;
    if (
      entry.data.length > 0xff_ff_ff_ff ||
      compressed.length > 0xff_ff_ff_ff
    ) {
      throw new ZipError(`The entry "${entry.name}" is too large.`);
    }
    const record: Written = {
      nameBytes,
      method,
      crc: crc32(entry.data),
      compressed,
      size: entry.data.length,
      offset,
    };
    written.push(record);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04_03_4b_50, true);
    writeCommon(header, 4, record);
    push(new Uint8Array(header.buffer));
    push(nameBytes);
    push(compressed);
  }

  const directoryAt = offset;
  for (const entry of written) {
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02_01_4b_50, true);
    record.setUint16(4, 20, true);
    writeCommon(record, 6, entry);
    record.setUint32(42, entry.offset, true);
    push(new Uint8Array(record.buffer));
    push(entry.nameBytes);
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06_05_4b_50, true);
  end.setUint16(8, written.length, true);
  end.setUint16(10, written.length, true);
  end.setUint32(12, offset - directoryAt, true);
  end.setUint32(16, directoryAt, true);
  push(new Uint8Array(end.buffer));

  return new Uint8Array(
    await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer(),
  );
};

const findEndRecord = (view: DataView): number => {
  // The end record is 22 bytes plus an optional comment of up to 64 KiB.
  const earliest = Math.max(0, view.byteLength - 22 - 0xff_ff);
  for (let at = view.byteLength - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === 0x06_05_4b_50) {
      const comment = view.getUint16(at + 20, true);
      if (at + 22 + comment === view.byteLength) {
        return at;
      }
    }
  }
  throw new ZipError('This is not a complete zip file.');
};

/**
 * Reads a whole zip archive into memory, through its central directory so
 * entries whose sizes follow their data (flag bit 3) read correctly.
 * Rejects encryption, ZIP64 and methods other than 0 and 8, and checks
 * every entry's size and CRC-32.
 */
export const readZip = async (
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = findEndRecord(view);
  const count = view.getUint16(endAt + 10, true);
  const directorySize = view.getUint32(endAt + 12, true);
  const directoryAt = view.getUint32(endAt + 16, true);
  if (
    count === 0xff_ff ||
    directorySize === 0xff_ff_ff_ff ||
    directoryAt === 0xff_ff_ff_ff
  ) {
    throw new ZipError('ZIP64 archives are not supported.');
  }
  if (directoryAt + directorySize > endAt) {
    throw new ZipError('The zip central directory is damaged.');
  }

  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  let at = directoryAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02_01_4b_50) {
      throw new ZipError('The zip central directory is damaged.');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (
      compressedSize === 0xff_ff_ff_ff ||
      size === 0xff_ff_ff_ff ||
      localAt === 0xff_ff_ff_ff
    ) {
      throw new ZipError('ZIP64 archives are not supported.');
    }
    if (flags & 1) {
      throw new ZipError(`The entry "${name}" is encrypted.`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(
        `The entry "${name}" uses unsupported compression method ${method}.`,
      );
    }
    if (
      localAt + 30 > bytes.length ||
      view.getUint32(localAt, true) !== 0x04_03_4b_50
    ) {
      throw new ZipError(`The entry "${name}" is damaged.`);
    }
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    const compressed = bytes.subarray(dataAt, dataAt + compressedSize);
    if (compressed.length !== compressedSize) {
      throw new ZipError(`The entry "${name}" is cut off.`);
    }
    const data =
      method === 8
        ? await inflate(compressed, name)
        : new Uint8Array(compressed);
    if (data.length !== size) {
      throw new ZipError(`The entry "${name}" has the wrong size.`);
    }
    if (crc32(data) !== crc) {
      throw new ZipError(`The entry "${name}" fails its CRC-32 check.`);
    }
    entries.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};
