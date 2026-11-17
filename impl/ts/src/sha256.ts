// SHA-256 (FIPS 180-4), synchronous and browser-safe, for code identities
// (chapter 9) and the save format's digests (chapter 10). `Sha256` hashes
// bytes incrementally; `sha256` hashes UTF-8 text or bytes to lowercase
// hexadecimal.
const K = new Uint32Array([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b,
  0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01,
  0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7,
  0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc,
  0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52,
  0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc,
  0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
  0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19,
  0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16, 0x1e_37_6c_08,
  0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f,
  0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

const initial = [
  0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f,
  0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19,
];

// Shared by every hash: compress never re-enters, and `w` is scratch.
const w = new Uint32Array(64);

/** One 64-byte block of `view` at `block`, folded into `h`. */
const compress = (h: Uint32Array, view: DataView, block: number): void => {
  for (let i = 0; i < 16; i++) {
    w[i] = view.getUint32(block + i * 4);
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
    const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  // Indexed reads: destructuring iterates the array, once per block.
  let a = h[0]!,
    b = h[1]!,
    c = h[2]!,
    d = h[3]!,
    e = h[4]!,
    f = h[5]!,
    g = h[6]!,
    hh = h[7]!;
  for (let i = 0; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
};

/** An incremental SHA-256: `update` with bytes, then `final` once. */
export class Sha256 {
  private readonly h = new Uint32Array(initial);
  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  private filled = 0;
  private length = 0;
  private done = false;

  update(bytes: Uint8Array): this {
    if (this.done) {
      throw new Error('Sha256.update after final');
    }
    this.length += bytes.length;
    let at = 0;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      at = take;
      if (this.filled < 64) {
        return this;
      }
      compress(this.h, this.blockView, 0);
      this.filled = 0;
    }
    const whole = at + Math.floor((bytes.length - at) / 64) * 64;
    if (whole > at) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      for (; at < whole; at += 64) {
        compress(this.h, view, at);
      }
    }
    this.block.set(bytes.subarray(at));
    this.filled = bytes.length - at;
    return this;
  }

  /** The 32-byte digest; the hash takes no more input after it. */
  final(): Uint8Array {
    if (this.done) {
      throw new Error('Sha256.final twice');
    }
    this.done = true;
    return wordBytes(finish(this.h, this.block, this.filled, this.length));
  }
}

/**
 * Pads the last `filled` bytes of `tail`, of `length` bytes hashed in all,
 * and compresses them into `h`, which it returns.
 */
const finish = (
  h: Uint32Array,
  tail: Uint8Array,
  filled: number,
  length: number,
): Uint32Array => {
  const padded = new Uint8Array(filled < 56 ? 64 : 128);
  padded.set(tail.subarray(0, filled));
  padded[filled] = 0x80;
  const view = new DataView(padded.buffer);
  // The bit length's high word: length * 8 / 2^32.
  view.setUint32(padded.length - 8, Math.floor(length / 0x20_00_00_00));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  for (let at = 0; at < padded.length; at += 64) {
    compress(h, view, at);
  }
  return h;
};

/**
 * All of `bytes` hashed at once, as the eight state words. Every Load hashes
 * a code identity, so this skips `Sha256`'s block buffering (#2230).
 */
const digest = (bytes: Uint8Array): Uint32Array => {
  const h = new Uint32Array(initial);
  const whole = bytes.length - (bytes.length % 64);
  if (whole > 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let at = 0; at < whole; at += 64) {
      compress(h, view, at);
    }
  }
  return finish(h, bytes.subarray(whole), bytes.length - whole, bytes.length);
};

const wordBytes = (h: Uint32Array): Uint8Array => {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4, h[i]!);
  }
  return out;
};

const encoder = new TextEncoder();
const hex = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

/** The SHA-256 of `bytes`, as 32 bytes. */
export const sha256Bytes = (bytes: Uint8Array): Uint8Array =>
  wordBytes(digest(bytes));

export const sha256 = (input: string | Uint8Array): string => {
  const h = digest(typeof input === 'string' ? encoder.encode(input) : input);
  let out = '';
  for (let i = 0; i < 8; i++) {
    const x = h[i]!;
    out +=
      hex[x >>> 24]! +
      hex[(x >>> 16) & 0xff]! +
      hex[(x >>> 8) & 0xff]! +
      hex[x & 0xff]!;
  }
  return out;
};
