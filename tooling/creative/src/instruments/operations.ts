// The Operations most Instrument kinds share, as Host Manifest declarations.
import { shape } from '@northtalk/ts';
import type { OperationDeclaration } from '../grants/grant';

const note = shape.oneOf(shape.number, shape.text);

export const NOTE_OPERATIONS = {
  play: {
    mode: 'fire-and-forget',
    args: [note, shape.optional(shape.number)],
    cost: { fuel: 1 },
    description:
      'Starts a note, a MIDI number or a name such as "c3" or "f#4", at an optional velocity from 0 to 1.',
    examples: ['tell bass to play "c3"', 'tell bass to play 60, 0.5'],
  },
  release: {
    mode: 'fire-and-forget',
    args: [note],
    cost: { fuel: 1 },
    description: 'Releases a note the Instrument is playing.',
    examples: ['tell bass to release "c3"'],
  },
  stop: {
    mode: 'fire-and-forget',
    cost: { fuel: 1 },
    description: 'Releases every note the Instrument is playing.',
    examples: ['tell bass to stop'],
  },
} as const satisfies Record<string, OperationDeclaration>;
