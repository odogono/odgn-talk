// Host Promise lifetimes outlive the Core's Waits when a call is abandoned.
// Both Cores fill it (ADR 0121); it stays outside saves, Traces and Script accounting.
import type { Group } from './embedding';

const pending = new WeakMap<Group, Set<Promise<void>>>();

/** Tracks forwarding too, so the final answer/failure is queued before completion. */
export const trackOperation = (group: Group, result: Promise<void>): void => {
  let operations = pending.get(group);
  if (!operations) {
    operations = new Set();
    pending.set(group, operations);
  }
  const done = () => {
    operations.delete(completed);
  };
  const completed = result.then(done, done);
  operations.add(completed);
};

/** Includes abandoned calls whose Host work is still finishing. */
export const waitForOperations = async (group: Group): Promise<void> => {
  const operations = pending.get(group);
  while (operations?.size) {
    await Promise.all(operations);
  }
};
