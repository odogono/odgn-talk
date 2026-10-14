// Folio's install icons, drawn by the build so no binary artwork is
// committed: two offset white Pages with ruled lines on the app's accent
// colour, in the page's own palette (static/style.css). The PNG encoder
// is chunk framing over node's deflate; the same drawing is written as
// SVG for the favicon. Maskable icons keep the Pages inside the safe
// zone the platform never crops.
import { deflateSync } from 'node:zlib';

const ACCENT = '#2f5d8a';
const PAGE = '#ffffff';
const LINE = '#111111';
const MUTED = '#6d675d';

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/** The favicon: the icon drawing as SVG. */
export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${ACCENT}"/>
  <rect x="30" y="14" width="48" height="64" fill="${PAGE}" stroke="${LINE}" stroke-width="2"/>
  <rect x="22" y="22" width="48" height="64" fill="${PAGE}" stroke="${LINE}" stroke-width="2"/>
  <path d="M30 38h32M30 48h32M30 58h22" stroke="${MUTED}" stroke-width="3"/>
</svg>
`;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** A square RGB PNG of `size` px; `pixel` returns 0..1 coordinates' RGB. */
const png = (
  size: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array => {
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      const offset = y * (1 + size * 3) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const inRect = (
  x: number,
  y: number,
  [x0, y0, x1, y1]: [number, number, number, number],
  shrink = 0,
): boolean =>
  x >= x0 + shrink && x < x1 - shrink && y >= y0 + shrink && y < y1 - shrink;

/**
 * The icon at `size` px. With `maskable`, the Pages shrink into the
 * central safe zone, as platforms crop maskable icons to their shape.
 */
export const iconPng = (
  size: number,
  { maskable = false } = {},
): Uint8Array => {
  const accent = rgb(ACCENT);
  const page = rgb(PAGE);
  const line = rgb(LINE);
  const muted = rgb(MUTED);
  // Page rectangles in the SVG's 100-unit space; maskable insets them.
  const inset = maskable ? 12 : 0;
  const back: [number, number, number, number] = [
    30 + inset / 2,
    14 + inset / 2,
    78 - inset / 2,
    78 - inset / 2,
  ];
  const front: [number, number, number, number] = [
    22 + inset / 2,
    22 + inset / 2,
    70 - inset / 2,
    86 - inset / 2,
  ];
  const border = 2;
  return png(size, (ux, uy) => {
    const x = ux * 100;
    const y = uy * 100;
    for (const rect of [front, back]) {
      if (inRect(x, y, rect, border)) {
        break;
      }
      if (inRect(x, y, rect)) {
        return line;
      }
      if (rect === back) {
        return accent;
      }
    }
    // Inside the front Page: three ruled lines, the last one short.
    const rows: [number, number][] = [
      [38 + inset / 2, 62 - inset / 2],
      [48 + inset / 2, 62 - inset / 2],
      [58 + inset / 2, 52 - inset / 2],
    ];
    for (const [row, end] of rows) {
      if (Math.abs(y - row) < 1.5 && x >= 30 + inset / 2 && x < end) {
        return muted;
      }
    }
    return page;
  });
};
