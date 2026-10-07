import { describe, expect, test } from 'bun:test';
import { memoryStores, webStorageStores } from '../src/store/index';
import {
  fakeStorage,
  runStoreKitSequence,
  storeKitSequences,
} from '../tools/store-kit';

const sequences = storeKitSequences();
const stores = {
  memory: memoryStores,
  'Web Storage': (quotas: Parameters<typeof memoryStores>[0]) =>
    webStorageStores(fakeStorage(), quotas),
};

test('the kit has sequences', () => {
  expect(sequences.length).toBeGreaterThan(20);
});

for (const [name, make] of Object.entries(stores)) {
  describe(`the ${name} Store follows the store test kit`, () => {
    for (const sequence of sequences) {
      test(`${sequence.file}: ${sequence.name}`, () => {
        expect(runStoreKitSequence(make, sequence)).toBeUndefined();
      });
    }
  });
}
