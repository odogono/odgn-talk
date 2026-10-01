// Base64 with padding (RFC 4648, section 4), for the Value Encoding's `$bytes`.
// Decoding accepts only the canonical form, so every value has one encoding.
const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const index = new Map(Array.from(alphabet, (ch, i) => [ch, i]));

export const toBase64 = (b: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out +=
      alphabet[(n >> 18) & 63]! +
      alphabet[(n >> 12) & 63]! +
      (i + 1 < b.length ? alphabet[(n >> 6) & 63]! : '=') +
      (i + 2 < b.length ? alphabet[n & 63]! : '=');
  }
  return out;
};

/** The bytes a canonical padded Base64 text spells, or undefined. */
export const fromBase64 = (s: string): Uint8Array | undefined => {
  if (s.length % 4 || !/^[\d+/A-Za-z]*={0,2}$/.test(s)) {
    return undefined;
  }
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  for (let i = 0, o = 0; i < s.length; i += 4) {
    const n =
      (index.get(s[i]!)! << 18) |
      (index.get(s[i + 1]!)! << 12) |
      ((index.get(s[i + 2]!) ?? 0) << 6) |
      (index.get(s[i + 3]!) ?? 0);
    for (const shift of [16, 8, 0]) {
      if (o < out.length) {
        out[o++] = (n >> shift) & 255;
      }
    }
  }
  // Bits the padding leaves over must be zero, as the encoder writes them.
  return toBase64(out) === s ? out : undefined;
};
