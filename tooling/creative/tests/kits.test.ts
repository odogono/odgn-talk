import { expect, test } from 'bun:test';
import type { SampleBuffer } from '../src/instruments/kind';
import { KIT_SOUND_KEYS, KITS, renderKitSound } from '../src/kits/kits';
import { KIT_RATE } from '../src/kits/synth';

/** Reads the mono 16-bit WAV the kits are written as. */
const readWav = (bytes: Uint8Array): SampleBuffer => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) =>
    String.fromCharCode(...bytes.subarray(at, at + 4));
  expect(text(0)).toBe('RIFF');
  expect(text(8)).toBe('WAVE');
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint16(34, true)).toBe(16);
  const length = view.getUint32(40, true) / 2;
  expect(44 + length * 2).toBe(bytes.length);
  const channel = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    channel[i] = view.getInt16(44 + i * 2, true) / 32_768;
  }
  return { channels: [channel], sampleRate: view.getUint32(24, true) };
};

test('every kit records its source and a CC0 licence', () => {
  for (const kit of KITS) {
    expect(kit.source).not.toBe('');
    expect(kit.licence).toContain('CC0');
  }
});

test('sound names are unique across kits and are Mini-Notation words', () => {
  const all = KITS.flatMap(kit => kit.samples.map(s => s.name));
  expect(new Set(all).size).toBe(all.length);
  for (const name of all) {
    expect(name).toMatch(/^[a-z]+$/u);
  }
  // A sample's later variants are named `name:n`, as `bd:1` plays them.
  expect(KIT_SOUND_KEYS).toContain('bd:1');
  expect(new Set(KIT_SOUND_KEYS).size).toBe(KIT_SOUND_KEYS.length);
});

test('every kit sound is a short, audible, deterministic WAV', () => {
  for (const key of KIT_SOUND_KEYS) {
    const bytes = renderKitSound(key);
    const { channels, sampleRate } = readWav(bytes);
    expect(sampleRate).toBe(KIT_RATE);
    const samples = channels[0]!;
    const peak = Math.max(...samples.map(Math.abs));
    expect(peak, key).toBeGreaterThan(0.5);
    expect(samples.length / sampleRate, key).toBeLessThanOrEqual(1.5);
    // Each sound starts silent, so it never clicks in.
    expect(Math.abs(samples[0]!), key).toBeLessThan(0.05);
    expect(renderKitSound(key), key).toEqual(bytes);
  }
});
