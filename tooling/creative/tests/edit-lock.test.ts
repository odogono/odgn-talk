import { expect, test } from 'bun:test';
import {
  EditLock,
  type LockManagerLike,
  type ProjectChannel,
  type ProjectMessage,
} from '../src/edit-lock';

/** One origin's Web Locks, seen by several tabs (clients). */
const fakeLockOrigin = () => {
  const held = new Map<string, { clientId: string }>();
  const waiters = new Map<string, (() => void)[]>();
  const wake = (name: string): void => {
    for (const run of waiters.get(name) ?? []) {
      run();
    }
    waiters.set(name, []);
  };
  const forClient = (clientId: string): LockManagerLike => ({
    query: async () => ({
      held: [...held.entries()].map(([name, lock]) => ({
        name,
        clientId: lock.clientId,
      })),
    }),
    request: async (name, options, callback) => {
      for (;;) {
        const holder = held.get(name);
        if (!holder) {
          held.set(name, { clientId });
          try {
            return await callback({ name });
          } finally {
            if (held.get(name)?.clientId === clientId) {
              held.delete(name);
              wake(name);
            }
          }
        }
        if (options.ifAvailable) {
          return callback(null);
        }
        if (options.steal) {
          // The stolen-from tab's callback keeps running, unaware.
          held.delete(name);
          continue;
        }
        await new Promise<void>(resolve => {
          const queue = waiters.get(name) ?? [];
          queue.push(resolve);
          waiters.set(name, queue);
        });
      }
    },
  });
  return { forClient };
};

/** A BroadcastChannel hub: each endpoint hears the others, never itself. */
const fakeChannels = (count: number): ProjectChannel[] => {
  const endpoints: { handlers: Set<(m: ProjectMessage) => void> }[] =
    Array.from({ length: count }, () => ({ handlers: new Set() }));
  return endpoints.map((endpoint, index) => ({
    close: () => {},
    listen: handler => {
      endpoint.handlers.add(handler);
      return () => endpoint.handlers.delete(handler);
    },
    post: message => {
      endpoints.forEach((other, otherIndex) => {
        if (otherIndex !== index) {
          for (const handler of other.handlers) {
            handler(message);
          }
        }
      });
    },
  }));
};

const makeTabs = () => {
  const origin = fakeLockOrigin();
  const [channelA, channelB] = fakeChannels(2) as [
    ProjectChannel,
    ProjectChannel,
  ];
  const flushedA: string[] = [];
  const editingA: boolean[] = [];
  const editingB: boolean[] = [];
  const a = new EditLock(
    origin.forClient('tab-a'),
    channelA,
    {
      flush: async () => {
        flushedA.push('flushed');
      },
      onEditing: editing => editingA.push(editing),
    },
    { takeoverWaitMs: 20 },
  );
  const b = new EditLock(
    origin.forClient('tab-b'),
    channelB,
    {
      flush: () => Promise.resolve(),
      onEditing: editing => editingB.push(editing),
    },
    { takeoverWaitMs: 20 },
  );
  return { a, b, flushedA, editingA, editingB };
};

test('a second tab on the same Project is read-only', async () => {
  const { a, b } = makeTabs();
  expect(await a.acquire('project-1')).toBe(true);
  expect(await b.acquire('project-1')).toBe(false);
  expect(b.editing).toBe(false);
  // A different Project is free for the second tab.
  expect(await b.acquire('project-2')).toBe(true);
});

test('taking over flushes the other tab, which becomes read-only', async () => {
  const { a, b, flushedA, editingA, editingB } = makeTabs();
  await a.acquire('project-1');
  await b.acquire('project-1');
  expect(await b.takeOver()).toBe(true);
  expect(flushedA).toEqual(['flushed']);
  expect(a.editing).toBe(false);
  expect(b.editing).toBe(true);
  expect(editingA.at(-1)).toBe(false);
  expect(editingB.at(-1)).toBe(true);
  expect(await b.stillEditing()).toBe(true);
});

test('a steal the holder slept through is caught by stillEditing', async () => {
  const origin = fakeLockOrigin();
  const a = new EditLock(
    origin.forClient('tab-a'),
    undefined,
    { flush: () => Promise.resolve() },
    { takeoverWaitMs: 5 },
  );
  const b = new EditLock(
    origin.forClient('tab-b'),
    undefined,
    { flush: () => Promise.resolve() },
    { takeoverWaitMs: 5 },
  );
  await a.acquire('project-1');
  await b.acquire('project-1');
  // No channel: b waits briefly, then steals; a believes it still edits…
  expect(await b.takeOver()).toBe(true);
  expect(a.editing).toBe(true);
  // …until it checks the lock list before writing.
  expect(await a.stillEditing()).toBe(false);
});

test('releasing lets another tab take the Project', async () => {
  const { a, b } = makeTabs();
  await a.acquire('project-1');
  a.release();
  expect(a.editing).toBe(false);
  // The lock frees asynchronously, as a real Web Lock does.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await b.acquire('project-1')).toBe(true);
});

test('without Web Locks, editing is allowed rather than blocked', async () => {
  const lock = new EditLock(undefined, undefined, {
    flush: () => Promise.resolve(),
  });
  expect(await lock.acquire('project-1')).toBe(true);
  expect(await lock.stillEditing()).toBe(true);
});
