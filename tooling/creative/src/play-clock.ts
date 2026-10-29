// When a Play Session's time moves (ADR 0128), and what each Pump of the
// Play worker is for: a Pause, a Step, a Stopped Run held at a Breakpoint
// until a Resume or Statement Step continues it (ADR 0147), and the Watches
// a paused session evaluates in their own Pump (ADR 0129). It runs no Pump
// and posts nothing: the Play worker asks it before and after each Pump.
import type { PumpResult } from '@northtalk/ts';

/** How far a Step moves the Play clock: one frame at 60 Hz, in ms. */
export const STEP = 1000 / 60;

/** The longest delay a timer takes. */
const maxDelay = 2_147_483_647;

/** What the next Pump runs. */
export type NextPump = {
  /** Continues a Stopped Run, in place of ordinary work. */
  advance?: () => PumpResult;
  /** Whether its frames don't count as frames of work: paused, not Stepping. */
  outOfBand: boolean;
};

/** What to do after a Pump that left no Run stopped. */
export type AfterPump =
  /** Publish, and Pump again at once to finish the slice. */
  | { sliced: true }
  | {
      /** Publish, then Pump again after this many ms, if a deadline waits. */
      delay?: number;
      /** Settle the Watches the Pump ran. */
      finishWatches: boolean;
      sliced?: false;
      /** Publish, then start the Watches; Pump again at once if any ran. */
      startWatches: boolean;
    };

export class PlayClock {
  #paused = false;
  #pausedSince = 0;
  // Paused milliseconds so far, less the time Steps have moved on.
  #pausedTotal = 0;
  // Whether the Pumps running now belong to a Step, not the Message Box.
  #stepping = false;
  #watchDue = false;
  #watching = false;
  // The Stopped Run's selected frame, innermost first, and that Run.
  #frame = 0;
  #frameOf: string | undefined;
  // Continues the Stopped Run, in the next Pump.
  #continue: (() => PumpResult) | undefined;

  constructor(private readonly performanceNow: () => number) {}

  /** Whether the session is paused: no time passes and reader input is dropped. */
  get paused(): boolean {
    return this.#paused;
  }

  /** The Stopped Run's selected frame, innermost first. */
  get frame(): number {
    return this.#frame;
  }

  /** Whether the Pumps running now are the Watches'. */
  get watching(): boolean {
    return this.#watching;
  }

  /** The milliseconds the Play clock is behind Host time. */
  pausedTime(): number {
    return (
      this.#pausedTotal +
      (this.#paused ? this.performanceNow() - this.#pausedSince : 0)
    );
  }

  /** A new session starts unpaused; its paused time stays in the clock. */
  newSession(): void {
    this.#watchDue = false;
    this.#watching = false;
    this.#continue = undefined;
    this.resume();
  }

  pause(): void {
    if (!this.#paused) {
      this.#paused = true;
      this.#pausedSince = this.performanceNow();
      this.#watchDue = true;
    }
  }

  resume(): void {
    if (this.#paused) {
      this.#pausedTotal += this.performanceNow() - this.#pausedSince;
      this.#paused = false;
    }
    this.#stepping = false;
  }

  /**
   * Moves a paused session on by one frame; whether it moved. A frame can't
   * move on until a Stopped Run finishes.
   */
  frameStep(stoppedRun: boolean): boolean {
    if (!this.#paused || stoppedRun) {
      return false;
    }
    this.#pausedTotal -= STEP;
    this.#stepping = true;
    this.#watchDue = true;
    return true;
  }

  /** Continues the Stopped Run in the next Pump: a Resume or Statement Step. */
  continueWith(advance: () => PumpResult): void {
    this.#continue = advance;
  }

  selectFrame(frame: number): void {
    this.#frame = frame;
  }

  /** The Watches changed: a paused session evaluates them again. */
  watchesChanged(): void {
    this.#watchDue = this.#paused;
  }

  /** A Message Box line runs: Watches follow it while paused. */
  messageSent(): void {
    this.#watchDue ||= this.#paused;
  }

  /** What the next Pump runs, or nothing while a Run stays stopped. */
  nextPump(stoppedRun: boolean): NextPump | undefined {
    const advance = this.#continue;
    this.#continue = undefined;
    if (stoppedRun && !advance) {
      return undefined;
    }
    return {
      ...(advance ? { advance } : {}),
      outOfBand: this.#paused && !this.#stepping,
    };
  }

  /** A Pump left `run` stopped: a Breakpoint hit is a Pause. */
  stoppedAt(run: string): void {
    if (!this.#paused) {
      this.#paused = true;
      this.#pausedSince = this.performanceNow();
    }
    this.#stepping = false;
    // Another Run's stop starts at its innermost frame.
    if (run !== this.#frameOf) {
      this.#frameOf = run;
      this.#frame = 0;
    }
  }

  /** What follows a Pump, at Play clock `now`, that left no Run stopped. */
  afterPump(
    result: Pick<PumpResult, 'nextDeadline' | 'state'>,
    now: bigint,
  ): AfterPump {
    if (result.state === 'sliced') {
      return { sliced: true };
    }
    this.#stepping = false;
    const finishWatches = this.#watching;
    this.#watching = false;
    // Once a Step's or the Message Box's Pump ends, Watches get their own.
    const startWatches = this.#paused && this.#watchDue;
    this.#watchDue &&= !startWatches;
    // No time passes while paused, so no deadline can come due.
    const delay =
      !this.#paused && result.nextDeadline !== undefined
        ? Math.min(
            maxDelay,
            Math.max(0, Number((result.nextDeadline - now) / 1000n)),
          )
        : undefined;
    return {
      finishWatches,
      startWatches,
      ...(delay === undefined ? {} : { delay }),
    };
  }

  /** The Watches started Runs, which the next Pumps run. */
  watchesStarted(): void {
    this.#watching = true;
  }
}
