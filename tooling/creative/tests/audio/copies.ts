// The copied engines, as scenarios.ts takes them.
import { ChipHost } from '../../src/audio/engine';
import { createMixer } from '../../src/audio/sonix/mixer';
import { buildFilterBank, renderWave } from '../../src/audio/sonix/synth';
import { Ym2149 } from '../../src/audio/ym2149';
import type { Modules } from './scenarios';

export const copies: Modules = {
  buildFilterBank,
  createMixer,
  host: (chip, sampleRate, tick) =>
    new ChipHost(
      {
        apply: command => {
          if (command.kind === 'write') {
            chip.write(command.register, command.value);
          }
        },
        channels: 1,
        render: count => chip.render(count),
        reset: () => chip.reset(),
        tick,
      },
      sampleRate,
      'golden',
    ),
  renderWave,
  Ym2149,
};
