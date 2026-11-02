// A rack's samplers take sounds after setup, as the page decodes them in
// the background (#1958).
import { expect, test } from 'bun:test';
import type { SampleBuffer } from '../../src/instruments/kind';
import { InstrumentRack } from '../../src/instruments/rack';
import { createInstrument } from '../../src/instruments/registry';

const RATE = 44_100;
const tone: SampleBuffer = {
  channels: [Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 5))],
  sampleRate: RATE,
};

test('a sound added after setup plays for a later note; one not loaded is silent', () => {
  const rack = new InstrumentRack(
    { instruments: [createInstrument('sampler', 'drums')], samples: [] },
    RATE,
  );
  const left = new Float32Array(2205);
  const right = new Float32Array(2205);
  const loudest = () => Math.max(...left.map(Math.abs));
  const note = (sound: string) =>
    rack.receive({
      instrument: 'drums',
      commands: [{ kind: 'note', note: 60, sound, velocity: 1 }],
    });
  note('oh');
  expect(() => rack.process(left, right, 0)).not.toThrow();
  expect(loudest()).toBe(0);
  rack.addSample('oh', tone);
  note('oh');
  rack.process(left, right, 0.05);
  expect(loudest()).toBeGreaterThan(0.1);
});
