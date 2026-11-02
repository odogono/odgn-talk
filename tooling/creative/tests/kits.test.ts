import { expect, test } from 'bun:test';
import { createInstrument } from '../src/instruments/registry';
import { InstrumentRack } from '../src/instruments/rack';
import type { SampleBuffer } from '../src/instruments/kind';
import {
  DEFAULT_KIT,
  DEFAULT_KIT_INSTRUMENT,
  KIT_BUDGET_BYTES,
  KIT_FILES,
  KIT_SAMPLE_NAMES,
  KITS,
  kitNotice,
  kitSampleKey,
  renderKitFiles,
} from '../src/kits/kits';
import { KIT_RATE } from '../src/kits/synth';
import { createProject } from '../src/model';
import { patternProblems, projectPatternNames } from '../src/pattern-checks';

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

test('every kit records its source and licence', () => {
  for (const kit of KITS) {
    expect(kit.source).not.toBe('');
    expect(kit.licence).toContain('CC0');
    expect(kitNotice()).toContain(`${kit.name}: ${kit.description}`);
  }
  expect(kitNotice()).toContain('Licence: CC0 1.0');
});

test('the default kit plays the first lesson’s names', () => {
  expect(DEFAULT_KIT.name).toBe('drums');
  const names = DEFAULT_KIT.samples.map(s => s.name);
  expect(names).toEqual(expect.arrayContaining(['bd', 'sd', 'hh', 'oh', 'cp']));
  // A new Project's patterns may name them before anything is imported.
  expect(
    patternProblems(
      'on click\n  loop "bd [hh hh] sd oh, - cp"\nend click',
      projectPatternNames(createProject('Empty')),
    ),
  ).toEqual([]);
});

test('sample names are unique across kits and Mini-Notation words', () => {
  const all = KITS.flatMap(kit => kit.samples.map(s => s.name));
  expect(new Set(all).size).toBe(all.length);
  expect(KIT_SAMPLE_NAMES.size).toBe(all.length);
  for (const name of all) {
    expect(name).toMatch(/^[a-z]+$/u);
  }
});

test('name:n picks a variant and wraps past the last one', () => {
  expect(kitSampleKey('bd')).toBe('bd');
  expect(kitSampleKey('bd', 1)).toBe('bd:1');
  expect(kitSampleKey('bd', 2)).toBe('bd');
  expect(kitSampleKey('hh', 3)).toBe('hh');
  const keys = KIT_FILES.map(file => file.key);
  expect(keys).toContain('bd:1');
  expect(new Set(keys).size).toBe(keys.length);
});

test('every kit sound is a short, audible, deterministic WAV within the budget', () => {
  const files = renderKitFiles();
  expect([...files.keys()]).toEqual(KIT_FILES.map(file => file.path));
  let total = 0;
  for (const [path, bytes] of files) {
    total += bytes.length;
    const { channels, sampleRate } = readWav(bytes);
    expect(sampleRate).toBe(KIT_RATE);
    const samples = channels[0]!;
    const peak = Math.max(...samples.map(Math.abs));
    expect(peak, path).toBeGreaterThan(0.5);
    expect(samples.length / sampleRate, path).toBeLessThanOrEqual(1.5);
    // Each sound starts silent, so it never clicks in.
    expect(Math.abs(samples[0]!), path).toBeLessThan(0.05);
  }
  expect(total).toBeLessThanOrEqual(KIT_BUDGET_BYTES);
  const again = renderKitFiles();
  for (const [path, bytes] of files) {
    expect(again.get(path), path).toEqual(bytes);
  }
});

test('the default kit sampler plays kit samples, and Project sounds win a name', () => {
  const files = renderKitFiles();
  const samples = KIT_FILES.map(
    file => [file.key, readWav(files.get(file.path)!)] as const,
  );
  const quiet: SampleBuffer = {
    channels: [new Float32Array(4000)],
    sampleRate: KIT_RATE,
  };
  const rack = new InstrumentRack(
    {
      instruments: [{ ...createInstrument('sampler', DEFAULT_KIT_INSTRUMENT) }],
      // As the page builds it: kits first, then the Project's sounds.
      samples: [...samples, ['sd', quiet]],
    },
    44_100,
  );
  const left = new Float32Array(2205);
  const right = new Float32Array(2205);
  const loudest = () => Math.max(...left.map(Math.abs));
  rack.receive({
    instrument: DEFAULT_KIT_INSTRUMENT,
    commands: [{ kind: 'note', note: 60, sound: 'bd', velocity: 1 }],
  });
  rack.process(left, right, 0);
  expect(loudest()).toBeGreaterThan(0.1);

  rack.receive({
    instrument: DEFAULT_KIT_INSTRUMENT,
    commands: [{ kind: 'stop' }],
  });
  rack.process(left, right, 0.05);
  rack.receive({
    instrument: DEFAULT_KIT_INSTRUMENT,
    commands: [{ kind: 'note', note: 60, sound: 'sd', velocity: 1 }],
  });
  rack.process(left, right, 0.1);
  expect(loudest()).toBe(0);
});
