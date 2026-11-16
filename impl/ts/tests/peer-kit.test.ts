import { describe, expect, test } from 'bun:test';
import { peerKitSequences, runPeerKitSequence } from '../tools/peer-kit';

const sequences = await peerKitSequences();

test('the kit has sequences', () => {
  expect(sequences.length).toBeGreaterThan(10);
});

describe('the Peer Router follows the peer kit', () => {
  for (const sequence of sequences) {
    test(`${sequence.file}: ${sequence.name}`, () => {
      expect(runPeerKitSequence(sequence)).toBeUndefined();
    });
  }
});
