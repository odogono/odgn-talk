// The `transport` Grant (ADR 0158, #1892): every Script sets the session's
// tempo and time signature, starts and stops its Transport, and turns beats
// into an exact duration for `wait`.
import {
  defineCapability,
  num,
  quantity,
  ScriptError,
  shape,
  type Value,
} from '@northtalk/ts';
import {
  BEAT_UNITS,
  MAX_BEATS_PER_BAR,
  MAX_TEMPO,
  MIN_TEMPO,
  type Transport,
} from '../transport';
import { grantAll, type GrantDefinition } from './grant';

export type TransportState = { readonly transport: Transport };

const operations = {
  setTempo: {
    mode: 'fire-and-forget',
    args: [shape.number],
    cost: { fuel: 1 },
    description: `Sets the tempo in beats a minute, from ${MIN_TEMPO} to ${MAX_TEMPO}, from the next beat. Durations already converted keep their length.`,
    examples: ['tell transport to setTempo 96'],
  },
  setTimeSignature: {
    mode: 'fire-and-forget',
    args: [shape.number, shape.number],
    cost: { fuel: 1 },
    description:
      'Sets the beats in a bar and the note that counts as one beat, such as 3, 4 for 3/4; bars count from the next beat.',
    examples: ['tell transport to setTimeSignature 3, 4'],
  },
  start: {
    mode: 'fire-and-forget',
    cost: { fuel: 1 },
    description:
      'Starts the Transport from bar 1, if it is stopped. It starts by itself when Play starts.',
    examples: ['tell transport to start'],
  },
  stop: {
    mode: 'fire-and-forget',
    cost: { fuel: 1 },
    description:
      'Stops the Transport: no more `beat` messages until it starts.',
    examples: ['tell transport to stop'],
  },
  beats: {
    mode: 'immediate',
    args: [shape.number],
    result: shape.quantityKind('exact duration'),
    cost: { fuel: 1 },
    description:
      'How long a number of beats lasts at the current tempo, as an exact duration for `wait`.',
    examples: ['ask transport to beats 2', 'wait it'],
  },
  tempo: {
    mode: 'immediate',
    result: shape.number,
    cost: { fuel: 1 },
    description: 'The tempo, in beats a minute.',
    examples: ['ask transport to tempo'],
  },
} as const;

const numberIn = (
  value: { toNumberLossy(): number },
  check: (n: number) => boolean,
  message: string,
): number => {
  const n = value.toNumberLossy();
  if (!check(n)) {
    throw new ScriptError('out of domain', message);
  }
  return n;
};

const microseconds = (us: bigint): Value =>
  quantity(num(Number(us) / 1000), 'ms');

export const transportGrant: GrantDefinition<TransportState> = {
  name: 'transport',
  operations,
  grant: ({ transport }) =>
    grantAll(
      defineCapability<null>()('transport', {
        setTempo: {
          ...operations.setTempo,
          args: [...operations.setTempo.args],
          examples: [...operations.setTempo.examples],
          fire: (call, bpm) =>
            transport.setTempo(
              numberIn(
                bpm,
                n => n >= MIN_TEMPO && n <= MAX_TEMPO,
                `A tempo is from ${MIN_TEMPO} to ${MAX_TEMPO} beats a minute`,
              ),
              call.now,
            ),
        },
        setTimeSignature: {
          ...operations.setTimeSignature,
          args: [...operations.setTimeSignature.args],
          examples: [...operations.setTimeSignature.examples],
          fire: (_call, beats, unit) =>
            transport.setTimeSignature(
              numberIn(
                beats,
                n => Number.isInteger(n) && n >= 1 && n <= MAX_BEATS_PER_BAR,
                `A bar has a whole number of beats from 1 to ${MAX_BEATS_PER_BAR}`,
              ),
              numberIn(
                unit,
                n => (BEAT_UNITS as readonly number[]).includes(n),
                `A beat is one of ${BEAT_UNITS.join(', ')}`,
              ),
            ),
        },
        start: {
          ...operations.start,
          examples: [...operations.start.examples],
          fire: call => transport.start(call.now),
        },
        stop: {
          ...operations.stop,
          examples: [...operations.stop.examples],
          fire: () => transport.stop(),
        },
        beats: {
          ...operations.beats,
          args: [...operations.beats.args],
          examples: [...operations.beats.examples],
          do: (_call, beats) =>
            microseconds(
              transport.duration(
                numberIn(
                  beats,
                  n => n >= 0 && n <= 1_000_000,
                  'A number of beats is from 0 to 1000000',
                ),
              ),
            ),
        },
        tempo: {
          ...operations.tempo,
          examples: [...operations.tempo.examples],
          do: () => num(transport.tempo),
        },
      }),
      null,
    ),
};
