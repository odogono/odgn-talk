import { describe, expect, test } from 'bun:test';
import { notifyKitSequences, runNotifyKitSequence } from '../tools/notify-kit';

const sequences = await notifyKitSequences();

test('the kit has sequences', () => {
  expect(sequences.length).toBeGreaterThan(40);
});

describe('the router follows the router kit', () => {
  for (const sequence of sequences) {
    test(`${sequence.file}: ${sequence.name}`, () => {
      expect(runNotifyKitSequence(sequence)).toBeUndefined();
    });
  }
});
