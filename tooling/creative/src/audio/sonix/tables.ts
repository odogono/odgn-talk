// Copied from odogono/wime web/src/audio/sonix/tables.ts at
// 86110d6517e9ff323b5e520db5f44dba2d81af25 (#1889), trimmed to what the
// waveform synth and wave-synth.ts use; the score engine's tables are left out.

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

// The driver's clock and semitone table, and the 68000 integer widths its maths
// wraps at. The tables are in the game's code byte for byte
// (finding:sound-game-carries-the-sonix-driver).

// 68000 register widths: the driver's arithmetic wraps at these.
export const u16 = (value: number): number => value & 0xff_ff;
export const i16 = (value: number): number => (value << 16) >> 16;
export const i8 = (value: number): number => (value << 24) >> 24;

// The PAL Paula colour clock in Hz: a period register counts its ticks
// (nuade's NUADE_PAULA_CLOCK_PAL).
export const PAULA_CLOCK_PAL = 3_546_895;

// The 12 semitone ratios, unison 0x8000 down to 0x43ce (code+0x19a4a).
export const SEMITONE_RATIOS: readonly number[] = [
  0x80_00, 0x78_d1, 0x72_09, 0x6b_a2, 0x65_98, 0x5f_e4, 0x5a_82, 0x55_6e,
  0x50_a3, 0x4c_1c, 0x47_d6, 0x43_ce,
];

export const semitoneRatio = (semitone: number): number =>
  SEMITONE_RATIOS[semitone] ?? 0x80_00;

// A synthesised note's period before it is halved into Paula's range: note
// 36 to 107, 0xd5c8 x ratio >> (octave + 17) (asm lbC01EC82).
export const synthPeriod = (note: number): number => {
  const relative = Math.max(0, Math.min(71, note - 36));
  return (
    (0xd5_c8 * semitoneRatio(relative % 12)) >>>
    (Math.floor(relative / 12) + 17)
  );
};
