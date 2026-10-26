/// <reference lib="esnext.disposable" preserve="true" />
// autoDrive pumps one Group from the Host's event loop: a Pump when a queued
// Host Input makes it ready, another when a Fuel Slice runs out, and a timer
// for its next deadline (spec chapter 9, Outside parity). It is built on the
// public embedding interface. Closing also waits for TS Host Promises, outside parity.
//
// newDrivenGroup creates a Group with its readiness already wired to a driver.
// Both work on either Core (ADR 0121), and import nothing from the TS Core.
import { nowMicros } from './dates';
import type { Group } from './embedding';
import type { GroupOptions, PumpOptions, PumpResult } from './group';
import { waitForOperations } from './operation-promises';

export type AutoDriveOptions = {
  /** Epoch microseconds. The default reads `Date.now()`; readings never go backwards. */
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
  /** Closes with the default reason, "Host shutdown". */
  [Symbol.asyncDispose](): Promise<void>;
  /** Stops all Scripts, drains, awaits Host run Promises, then cancels scheduling. */
  close(reason?: string): Promise<void>;
  /** Resolves once no Pump is scheduled or running. A Group waiting only on a deadline counts as settled. */
  idle(): Promise<void>;
  /** The Group's onReady: schedules a Pump, once, on a later macrotask. */
  ready(): void;
  /** Cancels scheduling without stopping Scripts. Does not interrupt an active close. */
  stop(): void;
};

/** Group and driver options. The factory owns the Group's readiness callback. */
export type DrivenGroupOptions = Omit<GroupOptions, 'onReady'> &
  AutoDriveOptions;

/** Creates a Group on `core` ready to drive queued Inputs from the Host's event loop. */
export const newDrivenGroup = <G extends Group>(
  core: { newGroup(o: GroupOptions): G },
  o: DrivenGroupOptions,
): { drive: Drive; group: G } => {
  const { name, seed, trace, ...options } = o;
  const group = core.newGroup({
    name,
    seed,
    trace,
    onReady: () => drive.ready(),
  });
  const drive = autoDrive(group, options);
  return { group, drive };
};

// setTimeout takes a signed 32-bit millisecond delay.
const MAX_DELAY_MS = 2 ** 31 - 1;

// Older browser runtimes can still call close() explicitly.
export const asyncDispose: typeof Symbol.asyncDispose =
  Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose');

const timeoutDeadline =
  (read: () => bigint) =>
  (at: bigint, fire: () => void): (() => void) => {
    let handle: ReturnType<typeof setTimeout>;
    const arm = () => {
      const ms = Number((at - read() + 999n) / 1000n);
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
  const read = o.clock ?? nowMicros;
  const setDeadline = o.setDeadline ?? timeoutDeadline(read);
  let last = 0n;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let cancelDeadline: (() => void) | undefined;
  let stopped = false;
  let pumping = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let finishClose: ((failure?: { error: unknown }) => void) | undefined;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (scheduled === undefined && !pumping) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) {
        resolve();
      }
    }
  };
  const clearDeadline = () => {
    const cancel = cancelDeadline;
    cancelDeadline = undefined;
    cancel?.();
  };
  const pump = () => {
    scheduled = undefined;
    if (stopped) {
      settle();
      return;
    }
    pumping = true;
    let again = false;
    try {
      clearDeadline();
      const reading = read();
      const now = reading > last ? reading : last;
      last = now;
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
      let failure = error;
      try {
        o.onError?.(error);
      } catch (callbackError) {
        if (!closing) {
          throw callbackError;
        }
        failure = callbackError;
      }
      if (closing) {
        finishClose?.({ error: failure });
      }
    } finally {
      pumping = false;
      if (again) {
        ready();
      }
      settle();
    }
  };
  const ready = () => {
    if (!stopped && scheduled === undefined) {
      scheduled = setTimeout(pump, 0);
    }
  };
  const idle = () =>
    scheduled === undefined && !pumping
      ? Promise.resolve()
      : new Promise<void>(resolve => waiters.push(resolve));
  const stop = () => {
    stopped = true;
    if (scheduled !== undefined) {
      clearTimeout(scheduled);
      scheduled = undefined;
    }
    try {
      clearDeadline();
    } finally {
      settle();
    }
  };
  const close = (reason = 'Host shutdown'): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    closing = true;
    stopped = false;
    closePromise = new Promise<void>((resolve, reject) => {
      finishClose = failure => {
        if (!closing) {
          return;
        }
        closing = false;
        try {
          stop();
        } catch (error) {
          reject(error);
          return;
        }
        if (failure) {
          reject(failure.error);
        } else {
          resolve();
        }
      };
    });
    const drain = async () => {
      try {
        for (const name of group.scriptNames()) {
          group.script(name)!.stop(reason);
        }
        ready();
        await idle();
        if (!closing) {
          return;
        }
        await waitForOperations(group);
        if (!closing) {
          return;
        }
        await idle();
        finishClose?.();
      } catch (error) {
        finishClose?.({ error });
      }
    };
    void drain();
    return closePromise;
  };
  return {
    close,
    idle,
    ready,
    stop: () => {
      if (!closing) {
        stop();
      }
    },
    [asyncDispose]: () => close(),
  };
};
