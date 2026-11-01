// Regenerates tests/audio/goldens.json from the original engines (#1889).
//
//   bun tooling/creative/tools/audio-goldens.ts <mercenary checkout> <wime checkout>
//
// Runs every scenario in tests/audio/scenarios.ts on the originals and on the
// copies, fails if any render differs, and records the originals' hashes.
// Check out mercenary at a04a7a9f and wime at 86110d65, the commits the
// copies came from.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { copies } from '../tests/audio/copies';
import { scenarios, sha256, type Modules } from '../tests/audio/scenarios';

const [mercenary, wime] = process.argv.slice(2).map(path => resolve(path));
if (mercenary === undefined || wime === undefined) {
  throw new Error('usage: audio-goldens.ts <mercenary> <wime>');
}
const sound = join(mercenary, 'web/src/sound');
const sonix = join(wime, 'web/src/audio/sonix');
const { ChipHost } = await import(join(sound, 'workletHost.ts'));
const { Ym2149 } = await import(join(sound, 'ym2149.ts'));
const { createMixer } = await import(join(sonix, 'mixer.ts'));
const { buildFilterBank, renderWave } = await import(join(sonix, 'synth.ts'));

const originals: Modules = {
  buildFilterBank,
  createMixer,
  host: (chip, sampleRate, tick) =>
    new ChipHost(
      {
        apply: (command: { kind: string; register: number; value: number }) =>
          chip.write(command.register, command.value),
        chip,
        reset: () => chip.reset(),
        tick,
      },
      sampleRate,
      'golden',
    ),
  renderWave,
  Ym2149,
};

const goldens: Record<string, string> = {};
for (const [name, scenario] of Object.entries(scenarios)) {
  const original = sha256(scenario(originals));
  const copy = sha256(scenario(copies));
  if (original !== copy) {
    throw new Error(`${name}: the copy renders differently from the original`);
  }
  goldens[name] = original;
}
const target = join(import.meta.dir, '../tests/audio/goldens.json');
writeFileSync(target, `${JSON.stringify(goldens, null, 2)}\n`);
console.log(`wrote ${Object.keys(goldens).length} goldens to ${target}`);
