// Copied from odogono/wime web/src/audio/sonix/synth.ts at
// 86110d6517e9ff323b5e520db5f44dba2d81af25 (#1889), changed only by this repo's formatter.

// Ported from nuade's Sonix player (players/sonix in
// https://github.com/emoon/nuade), itself a port of the Aegis Sonix Music
// Driver's 68000 code, under nuade's licence:
//
// MIT License
//
// Copyright (c) 2026 Daniel Collin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

// The Synthesis technique's waveform work: the 64-band filter bank built at
// load, and the per-tick copy, blend or ring modulation of the waveform into
// the buffer Paula plays (nuade's snx_one_filter and snx_synth_render_tick).
import { i8, i16, u16 } from './tables';

// The filter bank's 64 coefficients, 0x8000 (brightest) down to 0x100
// (asm lbW01F0FE).
const FILTER_COEFFICIENTS: readonly number[] = [
  0x80_00, 0x76_83, 0x6d_ba, 0x65_97, 0x5e_10, 0x57_17, 0x50_a2, 0x4a_a8,
  0x45_1f, 0x40_00, 0x3b_41, 0x36_dd, 0x32_cb, 0x2f_08, 0x2b_8b, 0x28_51,
  0x25_54, 0x22_8f, 0x20_00, 0x1d_a0, 0x1b_6e, 0x19_65, 0x17_84, 0x15_c5,
  0x14_28, 0x12_aa, 0x11_47, 0x10_00, 0x0e_d0, 0x0d_b7, 0x0c_b2, 0x0b_c2,
  0x0a_e2, 0x0a_14, 0x09_55, 0x08_a3, 0x08_00, 0x07_68, 0x06_db, 0x06_59,
  0x05_e1, 0x05_71, 0x05_0a, 0x04_aa, 0x04_51, 0x04_00, 0x03_b4, 0x03_6d,
  0x03_2c, 0x02_f0, 0x02_b8, 0x02_85, 0x02_55, 0x02_28, 0x02_00, 0x01_da,
  0x01_b6, 0x01_96, 0x01_78, 0x01_5c, 0x01_42, 0x01_2a, 0x01_14, 0x01_00,
];

export const FILTER_BANDS = 64;
export const WAVE_LENGTH = 128;

// 64 low-pass filtered copies of a 128-byte waveform, run through one IIR
// filter that carries its state from band to band (asm OneFilter 2866-2901).
export const buildFilterBank = (wave: Int8Array): Int8Array => {
  const bank = new Int8Array(FILTER_BANDS * WAVE_LENGTH);
  let feedback = 0;
  let output = i16(wave[127]! * 128);
  for (let band = 0; band < FILTER_BANDS; band++) {
    const coefficient = FILTER_COEFFICIENTS[band]!;
    const damping = i16(((0x80_00 - coefficient) * 0xe6_66) >>> 16);
    const cutoff = coefficient >> 1;
    for (let index = 0; index < WAVE_LENGTH; index++) {
      let difference = i16(i16(wave[index]! * 128) - output);
      // ASL.L #2 wraps at 32 bits, then SWAP.
      difference = i16((Math.imul(difference, cutoff) << 2) >> 16);
      feedback = i16(feedback + difference);
      output = i16(output + feedback);
      bank[band * WAVE_LENGTH + index] = i8(output >> 7);
      feedback = i16(Math.imul(Math.imul(feedback, damping), 2) >> 16);
    }
  }
  return bank;
};

// Halve a period into Paula's range: the shift is 5 less the halvings, and
// the buffer Paula loops is 128 >> shift bytes (asm 2607-2622).
export const decimationShift = (period: number): number => {
  let shift = 5;
  for (let value = period; value > 0x1_ac && shift > 0; value >>= 1) {
    shift--;
  }
  return shift;
};

export type RenderState = {
  // The blend or ring accumulator ($16(A2)), a signed 16-bit value.
  accumulator: number;
  // The ring modulation's direction, 1 or -1.
  direction: number;
};

// Write one tick's waveform into `output` from the source band `wave`
// (nuade's snx_synth_render_tick, SMUS asm lbC00119E-lbC001220): a straight
// decimated copy without a blend rate, a blend with itself shifted by the
// accumulator without a ring rate, else ring modulation, each half of the
// wave resampled to more or fewer bytes as the accumulator swings.
export const renderWave = (
  output: Int8Array,
  wave: Int8Array,
  byteAfterWave: number,
  shift: number,
  blendRate: number,
  ringRate: number,
  ticksPerBeat: number,
  state: RenderState,
): void => {
  const step = 1 << shift;
  const count = WAVE_LENGTH >> shift;
  if (blendRate === 0) {
    for (let index = 0, source = 0; index < count; index++, source += step) {
      output[index] = wave[source & 127]!;
    }
    return;
  }
  if (ringRate === 0) {
    const delta = u16(Math.imul(blendRate, ticksPerBeat) >>> 13);
    const accumulator = u16(state.accumulator + delta);
    state.accumulator = i16(accumulator);
    const offset = accumulator >> 9;
    for (let index = 0, source = 0; index < count; index++, source += step) {
      output[index] = i8(
        (wave[source & 127]! + wave[(source + offset) & 127]!) >> 1,
      );
    }
    return;
  }
  const rate = u16(Math.imul(blendRate, ticksPerBeat) >>> 11);
  let direction = state.direction;
  const sum = state.accumulator + i16(rate * direction);
  let wrapped = i16(sum);
  if (sum !== wrapped) {
    if (wrapped === -0x80_00) {
      wrapped = i16(wrapped + direction);
    }
    direction = -direction;
    wrapped = i16(-wrapped);
    state.direction = direction;
  }
  state.accumulator = wrapped;
  const modulation = (wrapped * i16(ringRate)) >> (17 + shift);
  const halfWords = 64 >> shift;
  const halves = [halfWords + modulation, halfWords - modulation];
  // The resampler's ADDX takes the 68000's X flag, which only the ADDs set
  // (nuade's note on the UADE CPU core).
  let extend = u16(halfWords) + u16(modulation) > 0xff_ff;
  let position = 0;
  for (let half = 0; half < 2; half++) {
    const length = u16(halves[half]!);
    if (length === 0) {
      continue;
    }
    const quotient = Math.floor(0x40 / length);
    const remainder = 0x40 % length;
    let source = half * 0x40;
    let error = 0;
    for (let index = 0; index < length && position < WAVE_LENGTH; index++) {
      output[position++] = source === 128 ? byteAfterWave : wave[source & 127]!;
      const borrow = error < remainder;
      error = u16(error - remainder);
      if (borrow) {
        extend = error + length > 0xff_ff;
        error = u16(error + length);
      }
      const next = (source & 0xff_ff) + quotient + (extend ? 1 : 0);
      extend = next > 0xff_ff;
      source = next & 0xff_ff;
    }
  }
  output.fill(0, position);
};
