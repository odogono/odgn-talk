// The `sound` Grant: Sound Patterns and Project sounds (ADR 0159, #1896).
// `play`, `loop` and `stop` are Host Commands, so `loop "bd hh"` needs no
// `tell sound to`, and they take `on <Instrument>` and `with {…}` as
// Argument Labels; either may be left out (ADR 0160).
import {
  defineCapability,
  shape,
  type ReleaseHook,
  type Value,
} from '@northtalk/ts';
import { grantAll, type GrantDefinition } from './grant';

/** The call a Sound Pattern is started from. */
export type SoundCall = {
  readonly delivery?: string;
  readonly now: bigint;
  readonly runId?: string;
  readonly scriptName: string;
};

type Argument = Value | null | undefined;

export type SoundState = {
  loop(call: SoundCall, text: string, on: Argument, options: Argument): void;
  play(call: SoundCall, text: string, on: Argument, options: Argument): void;
  /** Ends the Script's sounds and Sound Patterns, or those of one target. */
  stop(call: SoundCall, target: Argument): void;
  /** Ends everything a Script started, when its Grant is released. */
  stopOwner(owner: string): void;
};

/** The options `with` takes. */
export const PATTERN_OPTIONS = shape.map({
  gain: { optional: true, shape: shape.number },
  pan: { optional: true, shape: shape.number },
  speed: { optional: true, shape: shape.number },
  repeat: { optional: true, shape: shape.bool },
});

const target = shape.optional(shape.value);
const LABELS = ['on', 'with'] as const;
const ON_WITH =
  ' `on` names an Instrument, by itself or its name; without it the default sampler plays the Project’s sounds. `with` takes `gain` (0 to 1), `pan` (-1 to 1) and `speed` (a sampler’s, 2 is an octave up).';

const operations = {
  play: {
    mode: 'fire-and-forget',
    command: true,
    args: [shape.text, target, shape.optional(PATTERN_OPTIONS)],
    labels: LABELS,
    cost: { fuel: 1 },
    description: `Plays a Sound Pattern in Mini-Notation once, spread over one bar from now, or a whole Project sound by its name; \`with {repeat: true}\` repeats a Project sound end to end until it is stopped.${ON_WITH}`,
    examples: [
      'play "bd hh sd hh"',
      'play "c3 e3 g3" on bass',
      'play "rain" with {repeat: true}',
    ],
  },
  loop: {
    mode: 'fire-and-forget',
    command: true,
    args: [shape.text, target, shape.optional(PATTERN_OPTIONS)],
    labels: LABELS,
    cost: { fuel: 1 },
    description: `Loops a Sound Pattern in Mini-Notation from the next bar, one cycle each bar. A Script loops one pattern per Instrument, so a second \`loop\` on the same Instrument replaces the first on the next bar.${ON_WITH}`,
    examples: [
      'loop "bd [hh hh] sd hh"',
      'loop "hh*8, - cp" on drums with {gain: 0.8}',
      'loop "<c3 e3 g3>*4" on bass',
    ],
  },
  stop: {
    mode: 'fire-and-forget',
    command: true,
    args: [target],
    cost: { fuel: 1 },
    description:
      'Ends the sounds and Sound Patterns this Script started: all of them, those on one Instrument, or the Project sound with a name.',
    examples: ['stop', 'stop bass', 'stop "rain"'],
  },
} as const;

// Releasing a Script's sound Grant ends the sounds and Sound Patterns it
// started whenever the Core stops, reloads or revokes it, so no lifecycle
// path can leak a voice (#735). The state travels as the Grant's binding.
const releaseSounds: ReleaseHook<SoundState> = context =>
  context.binding.stopOwner(context.scriptName);

export const soundGrant: GrantDefinition<SoundState> = {
  name: 'sound',
  operations,
  grant: state =>
    grantAll(
      defineCapability<SoundState>()(
        'sound',
        {
          play: {
            ...operations.play,
            labels: [...LABELS],
            examples: [...operations.play.examples],
            fire: (call, text, on, options) =>
              state.play(call, text, on, options),
          },
          loop: {
            ...operations.loop,
            labels: [...LABELS],
            examples: [...operations.loop.examples],
            fire: (call, text, on, options) =>
              state.loop(call, text, on, options),
          },
          stop: {
            ...operations.stop,
            examples: [...operations.stop.examples],
            fire: (call, on) => state.stop(call, on),
          },
        },
        undefined,
        releaseSounds,
      ),
      state,
    ),
};
