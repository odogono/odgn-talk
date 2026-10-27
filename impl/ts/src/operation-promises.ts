// Host Promise lifetimes outlive the Core's Waits when a call is abandoned.
// Both Cores fill it (ADR 0121); it stays outside saves, Traces and Script accounting.
import type { Group } from './embedding';

/** A suspending call whose Host `run` Promise has not settled. */
export type PendingOperation = {
  readonly callId: string;
  readonly grantName: string;
  readonly scriptName: string;
};

const pending = new WeakMap<Group, Map<Promise<void>, PendingOperation>>();

/** Tracks forwarding too, so the final answer/failure is queued before completion. */
export const trackOperation = (
  group: Group,
  call: { grantName: string; id: string; scriptName: string },
  result: Promise<void>,
): void => {
  let operations = pending.get(group);
  if (!operations) {
    operations = new Map();
    pending.set(group, operations);
  }
  const done = () => {
    operations.delete(completed);
  };
  const completed = result.then(done, done);
  operations.set(completed, {
    callId: call.id,
    grantName: call.grantName,
    scriptName: call.scriptName,
  });
};

export const pendingOperations = (group: Group): PendingOperation[] => [
  ...(pending.get(group)?.values() ?? []),
];

/** Includes abandoned calls whose Host work is still finishing. */
export const waitForOperations = async (group: Group): Promise<void> => {
  const operations = pending.get(group);
  while (operations?.size) {
    await Promise.all(operations.keys());
  }
};
