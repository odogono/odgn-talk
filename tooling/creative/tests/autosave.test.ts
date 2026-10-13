import { expect, test } from 'bun:test';
import { Autosave, failureMessage, type Timers } from '../src/autosave';

/** Timers a test advances by hand. */
const fakeTimers = () => {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers = {
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id: number) => {
      pending.delete(id);
    },
  } as unknown as Timers;
  const tick = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      pending.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { timers, tick };
};

/** Lets queued promises settle after a fake timer fires. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test('writes about a second after the last edit', async () => {
  const { timers, tick } = fakeTimers();
  let saves = 0;
  const autosave = new Autosave(
    async () => {
      saves++;
    },
    { timers },
  );
  autosave.markDirty();
  tick(900);
  autosave.markDirty();
  tick(900);
  await settle();
  expect(saves).toBe(0);
  tick(200);
  await settle();
  expect(saves).toBe(1);
  expect(autosave.state).toBe('saved');
  expect(autosave.dirty).toBe(false);
});

test('a continuous stream of edits cannot put a write off past five seconds', async () => {
  const { timers, tick } = fakeTimers();
  let saves = 0;
  const autosave = new Autosave(
    async () => {
      saves++;
    },
    { timers },
  );
  for (let elapsed = 0; elapsed < 4900; elapsed += 700) {
    autosave.markDirty();
    tick(700);
    await settle();
  }
  expect(saves).toBe(0);
  autosave.markDirty();
  tick(200);
  await settle();
  expect(saves).toBe(1);
});

test('flush writes at once', async () => {
  const { timers } = fakeTimers();
  let saves = 0;
  const autosave = new Autosave(
    async () => {
      saves++;
    },
    { timers },
  );
  autosave.markDirty();
  await autosave.flush();
  expect(saves).toBe(1);
});

test('an edit during a save is written by a following save', async () => {
  const { timers } = fakeTimers();
  let saves = 0;
  let unblock: (() => void) | undefined;
  const autosave = new Autosave(
    () =>
      new Promise<void>(resolve => {
        saves++;
        unblock = resolve;
      }),
    { timers },
  );
  autosave.markDirty();
  const flushed = autosave.flush();
  autosave.markDirty();
  unblock!();
  await settle();
  expect(saves).toBe(2);
  unblock!();
  await flushed;
  expect(autosave.state).toBe('saved');
});

test('a quota failure reports once, keeps the work, and the next edit retries', async () => {
  const { timers, tick } = fakeTimers();
  const errors: unknown[] = [];
  let attempts = 0;
  let overQuota = true;
  const autosave = new Autosave(
    async () => {
      attempts++;
      if (overQuota) {
        throw new DOMException('Full.', 'QuotaExceededError');
      }
    },
    { timers, onError: error => errors.push(error) },
  );
  autosave.markDirty();
  tick(1000);
  await settle();
  expect(attempts).toBe(1); // No immediate retry into a full store.
  expect(errors).toHaveLength(1);
  expect(autosave.state).toBe('failed');
  expect(autosave.dirty).toBe(true);

  overQuota = false;
  autosave.markDirty();
  tick(1000);
  await settle();
  expect(attempts).toBe(2);
  expect(autosave.state).toBe('saved');
  expect(autosave.dirty).toBe(false);
});

test('another failure is retried once at once, then reported', async () => {
  const { timers } = fakeTimers();
  const errors: unknown[] = [];
  let attempts = 0;
  const autosave = new Autosave(
    async () => {
      attempts++;
      throw new DOMException('Gone.', 'UnknownError');
    },
    { timers, onError: error => errors.push(error) },
  );
  autosave.markDirty();
  await autosave.flush();
  expect(attempts).toBe(2);
  expect(errors).toHaveLength(1);
  expect(autosave.dirty).toBe(true);
});

test('a disabled autosave writes nothing until enabled again', async () => {
  const { timers, tick } = fakeTimers();
  let saves = 0;
  const autosave = new Autosave(
    async () => {
      saves++;
    },
    { timers },
  );
  autosave.setEnabled(false);
  autosave.markDirty();
  tick(10_000);
  await settle();
  expect(saves).toBe(0);
  await autosave.flush();
  expect(saves).toBe(0);
});

test('failure wording names a full store as such', () => {
  expect(failureMessage(new DOMException('Full.', 'QuotaExceededError'))).toBe(
    "Couldn't save: the browser's storage for this site is full.",
  );
  expect(failureMessage(new Error('boom'))).toBe("Couldn't save.");
});
