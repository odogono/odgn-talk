import { defineCapability, shape, type ReleaseHook } from '@northtalk/ts';
import type { SoundBoard } from '../sounds';
import { grantAll, type GrantDefinition } from './grant';

export type SoundState = {
  /** Plays a Project sound for a Script, which owns the voice. */
  play(owner: string, name: string, loop: boolean): void;
  readonly sounds: SoundBoard;
};

const operations = {
  play: { mode: 'fire-and-forget', args: [shape.text], cost: { fuel: 1 } },
  loop: { mode: 'fire-and-forget', args: [shape.text], cost: { fuel: 1 } },
  stop: {
    mode: 'fire-and-forget',
    args: [shape.optional(shape.text)],
    cost: { fuel: 1 },
  },
} as const;

// Releasing a Script's sound Grant stops the sounds it started whenever the
// Core stops, reloads or revokes it, so no lifecycle path can leak a voice
// (#735). The board travels as the Grant's binding.
const releaseSounds: ReleaseHook<SoundBoard> = context =>
  context.binding.stopOwner(context.scriptName);

export const soundGrant: GrantDefinition<SoundState> = {
  name: 'sound',
  operations,
  grant: state =>
    grantAll(
      defineCapability<SoundBoard>()(
        'sound',
        {
          play: {
            ...operations.play,
            fire: (call, name) => state.play(call.scriptName, name, false),
          },
          loop: {
            ...operations.loop,
            fire: (call, name) => state.play(call.scriptName, name, true),
          },
          stop: {
            ...operations.stop,
            fire: (call, name) =>
              state.sounds.stop(call.scriptName, name ?? undefined),
          },
        },
        undefined,
        releaseSounds,
      ),
      state.sounds,
    ),
};
