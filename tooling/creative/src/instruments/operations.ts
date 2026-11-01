// The Operations most Instrument kinds share, as Host Manifest declarations.
import { shape } from '@northtalk/ts';
import type { OperationDeclaration } from '../grants/grant';

const note = shape.oneOf(shape.number, shape.text);
/** When a sound plays, after the `beat` that started the Run, or else now. */
export const AT = shape.optional(shape.quantityKind('exact duration'));
const AT_PROSE =
  ' An optional exact duration delays it: from the beat a `beat` Handler runs for, or else from now.';

export const NOTE_OPERATIONS = {
  play: {
    mode: 'fire-and-forget',
    args: [note, shape.optional(shape.number), AT],
    cost: { fuel: 1 },
    description: `Starts a note, a MIDI number or a name such as "c3" or "f#4", at an optional velocity from 0 to 1.${AT_PROSE}`,
    examples: [
      'tell bass to play "c3"',
      'tell bass to play 60, 0.5',
      'tell bass to play "e3", 1, 250 ms',
    ],
  },
  release: {
    mode: 'fire-and-forget',
    args: [note, AT],
    cost: { fuel: 1 },
    description: `Releases a note the Instrument is playing.${AT_PROSE}`,
    examples: [
      'tell bass to release "c3"',
      'tell bass to release "c3", 400 ms',
    ],
  },
  stop: {
    mode: 'fire-and-forget',
    cost: { fuel: 1 },
    description: 'Releases every note the Instrument is playing.',
    examples: ['tell bass to stop'],
  },
} as const satisfies Record<string, OperationDeclaration>;

export const SAMPLER_OPERATIONS = {
  play: {
    mode: 'fire-and-forget',
    args: [
      shape.text,
      shape.optional(shape.oneOf(shape.number, shape.text)),
      shape.optional(shape.number),
    ],
    cost: { fuel: 1 },
    description:
      'Plays a sound by name, at an optional note (middle C, "c4", plays it as recorded) and velocity from 0 to 1.',
    examples: [
      'tell drums to play "kick"',
      'tell drums to play "bell", "g4", 0.6',
    ],
  },
  release: NOTE_OPERATIONS.release,
  stop: NOTE_OPERATIONS.stop,
} as const satisfies Record<string, OperationDeclaration>;
