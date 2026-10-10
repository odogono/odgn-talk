// autoDrive pumps one Group from the Host's event loop: a Pump when a queued
// Host Input makes it ready, another when a Fuel Slice runs out, and a timer
// for its next deadline (spec chapter 9, Outside parity). It is built on the
// public embedding interface alone, so it isn't covered by parity.
//
// A Group's onReady is fixed when it is made, so the Host passes the driver's:
//
//   const group = newGroup({ name, onReady: () => drive.ready() });
//   const drive = autoDrive(group);
import type { Group, PumpOptions, PumpResult } from './group';

export type AutoDriveOptions = {
  /** Epoch nanoseconds. The default reads `Date.now()`; readings never go backwards. */
  clock?: () => bigint;
  /** A Pump that threw, such as a `clock backwards` HostError. The driver keeps going. */
  onError?: (error: unknown) => void;
  /** Each Pump's result, as soon as it returns. It may make worker calls, such as Reload after a `rewound` Pump. */
  onPump?: (result: PumpResult) => void;
  /** Passed to every Pump. A Fuel Slice yields the event loop between Pumps. */
  pump?: PumpOptions;
  /**
   * Calls `fire` once the clock reaches `at`, and returns a cancel function.
   * The default uses `setTimeout`; a Host with its own clock supplies its own.
   */
  setDeadline?: (at: bigint, fire: () => void) => () => void;
};

export type Drive = {
  /** Resolves once no Pump is scheduled or running. A Group waiting only on a deadline counts as settled. */
  idle(): Promise<void>;
  /** The Group's onReady: schedules a Pump, once, on a later macrotask. */
  ready(): void;
  /** Cancels the scheduled Pump and the deadline timer; later readiness is ignored. */
  stop(): void;
};

// setTimeout takes a signed 32-bit millisecond delay.
const MAX_DELAY_MS = 2 ** 31 - 1;

const timeoutDeadline =
  (read: () => bigint) =>
  (at: bigint, fire: () => void): (() => void) => {
    let handle: ReturnType<typeof setTimeout>;
    const arm = () => {
      const ms = Number((at - read() + 999_999n) / 1_000_000n);
      // A deadline past setTimeout's range is reached in steps.
      handle = setTimeout(
        ms > MAX_DELAY_MS ? arm : fire,
        Math.min(Math.max(ms, 0), MAX_DELAY_MS),
      );
    };
    arm();
    return () => clearTimeout(handle);
  };

export const autoDrive = (group: Group, o: AutoDriveOptions = {}): Drive => {
  const read = o.clock ?? (() => BigInt(Date.now()) * 1_000_000n);
  const setDeadline = o.setDeadline ?? timeoutDeadline(read);
  let last = 0n;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let cancelDeadline: (() => void) | undefined;
  let stopped = false;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (scheduled === undefined) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) {
        resolve();
      }
    }
  };
  const clearDeadline = () => {
    cancelDeadline?.();
    cancelDeadline = undefined;
  };
  const pump = () => {
    scheduled = undefined;
    if (stopped) {
      settle();
      return;
    }
    clearDeadline();
    const reading = read();
    const now = reading > last ? reading : last;
    last = now;
    let again = false;
    try {
      const result = group.pump(now, o.pump);
      o.onPump?.(result);
      again = result.state === 'sliced' || result.state === 'rewound';
      if (!again && result.nextDeadline !== undefined && !stopped) {
        cancelDeadline = setDeadline(result.nextDeadline, () => {
          cancelDeadline = undefined;
          ready();
        });
      }
    } catch (error) {
      o.onError?.(error);
    }
    if (again) {
      ready();
    }
    settle();
  };
  const ready = () => {
    if (!stopped && scheduled === undefined) {
      scheduled = setTimeout(pump, 0);
    }
  };
  return {
    ready,
    idle: () =>
      scheduled === undefined
        ? Promise.resolve()
        : new Promise(resolve => waiters.push(resolve)),
    stop: () => {
      stopped = true;
      if (scheduled !== undefined) {
        clearTimeout(scheduled);
        scheduled = undefined;
      }
      clearDeadline();
      settle();
    },
  };
};
