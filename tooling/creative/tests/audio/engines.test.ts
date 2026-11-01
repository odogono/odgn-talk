import { describe, expect, test } from 'bun:test';

import { renderOffline } from '../../src/audio/chip-host';
import { waveSynthChip } from '../../src/audio/sonix/wave-synth';
import { ym2149Chip } from '../../src/audio/ym2149';
import { copies } from './copies';
import goldens from './goldens.json';
import { scenarios, sha256 } from './scenarios';

const RATE = 44_100;

const peak = (samples: Float32Array): number =>
  samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

// Zero crossings a second of one channel, about twice its frequency.
const crossings = (samples: Float32Array, stride: number): number => {
  let count = 0;
  for (let index = stride; index < samples.length; index += stride) {
    if (samples[index - stride]! < 0 !== samples[index]! < 0) {
      count++;
    }
  }
  return count;
};

describe('golden renders match the original engines', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    test(name, () => {
      expect(sha256(scenario(copies))).toBe(
        (goldens as Record<string, string>)[name]!,
      );
    });
  }
});

describe('the YM2149 engine', () => {
  test('a timed write sounds from its own sample', () => {
    const output = renderOffline(ym2149Chip(RATE), RATE, 0.5, [
      {
        at: 0.25,
        commands: [
          { kind: 'write', register: 0, value: 0x1c },
          { kind: 'write', register: 1, value: 0x01 },
          { kind: 'write', register: 7, value: 0b11_1110 },
          { kind: 'write', register: 8, value: 15 },
        ],
      },
    ]);
    expect(peak(output.subarray(0, RATE / 4))).toBe(0);
    expect(output[RATE / 4]).not.toBe(0);
    // Period 284 at 2 MHz / 16 is 440 Hz.
    const hertz = crossings(output.subarray(RATE / 4 + 2000), 1) / 2 / 0.2;
    expect(Math.abs(hertz - 440)).toBeLessThan(15);
  });
});

describe('the wave synth engine', () => {
  const sine = Int8Array.from({ length: 128 }, (_, index) =>
    Math.round(Math.sin((index / 128) * 2 * Math.PI) * 120),
  );

  test('a note plays at its pitch on its side', () => {
    const output = renderOffline(waveSynthChip(RATE), RATE, 0.5, [
      {
        at: 0,
        commands: [
          { kind: 'wave', voice: 0, wave: sine },
          { kind: 'note', note: 69, voice: 0 },
        ],
      },
    ]);
    const left = output.filter((_, index) => index % 2 === 0);
    const right = output.filter((_, index) => index % 2 === 1);
    expect(peak(left)).toBeGreaterThan(0.1);
    expect(peak(right)).toBe(0);
    const hertz = crossings(left, 1) / 2 / 0.5;
    expect(Math.abs(hertz - 440)).toBeLessThan(15);
  });

  test('stop and reset silence it', () => {
    const output = renderOffline(waveSynthChip(RATE), RATE, 0.5, [
      {
        at: 0,
        commands: [
          { kind: 'wave', voice: 1, wave: sine },
          { kind: 'note', note: 60, voice: 1 },
        ],
      },
      { at: 0.25, commands: [{ kind: 'stop', voice: 1 }] },
    ]);
    expect(peak(output.subarray(0, RATE / 2))).toBeGreaterThan(0.1);
    expect(peak(output.subarray(RATE))).toBe(0);
  });

  test('a note before any wave stays silent', () => {
    const output = renderOffline(waveSynthChip(RATE), RATE, 0.1, [
      { at: 0, commands: [{ kind: 'note', note: 60, voice: 2 }] },
    ]);
    expect(peak(output)).toBe(0);
  });
});
