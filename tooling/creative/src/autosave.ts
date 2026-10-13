// Autosave scheduling (#752): write about a second after the last edit, at
// most every five seconds during a continuous drag, and at once when told
// to flush (the page being hidden). The in-memory Project stays the master
// copy until a write succeeds: a failure keeps the dirty flag, reports the
// error once, and the next edit tries again.
import { isQuotaError } from './storage';

export type AutosaveState = 'dirty' | 'failed' | 'saved' | 'saving';

export type Timer = ReturnType<typeof setTimeout>;
export type Timers = {
  clearTimeout: (timer: Timer) => void;
  setTimeout: (run: () => void, ms: number) => Timer;
};

export type AutosaveOptions = {
  /** Quiet time after the last edit before writing. */
  delayMs?: number;
  /** Longest a continuous stream of edits may put a write off. */
  maxDelayMs?: number;
  onError?: (error: unknown) => void;
  onSaved?: () => void;
  onState?: (state: AutosaveState) => void;
  timers?: Timers;
};

export const systemTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer),
};

/** What the author is told when a save fails; the name stays under Details. */
export const failureMessage = (error: unknown): string =>
  isQuotaError(error)
    ? "Couldn't save: the browser's storage for this site is full."
    : "Couldn't save.";

export class Autosave {
  readonly #save: () => Promise<void>;
  readonly #options: Required<Pick<AutosaveOptions, 'delayMs' | 'maxDelayMs'>> &
    AutosaveOptions;
  readonly #timers: Timers;
  #state: AutosaveState = 'saved';
  #dirty = false;
  #enabled = true;
  #disposed = false;
  #timer: Timer | undefined;
  #maxTimer: Timer | undefined;
  #running: Promise<void> | undefined;

  constructor(save: () => Promise<void>, options: AutosaveOptions = {}) {
    this.#save = save;
    this.#options = { delayMs: 1000, maxDelayMs: 5000, ...options };
    this.#timers = options.timers ?? systemTimers;
  }

  get state(): AutosaveState {
    return this.#state;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  #setState(state: AutosaveState): void {
    if (this.#state !== state) {
      this.#state = state;
      this.#options.onState?.(state);
    }
  }

  #clearTimers(): void {
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#maxTimer !== undefined) {
      this.#timers.clearTimeout(this.#maxTimer);
      this.#maxTimer = undefined;
    }
  }

  /** Notes an edit: a write follows after the quiet time, or by the cap. */
  markDirty(): void {
    if (this.#disposed || !this.#enabled) {
      return;
    }
    this.#dirty = true;
    if (this.#state !== 'saving') {
      this.#setState('dirty');
    }
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer);
    }
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#options.delayMs);
    this.#maxTimer ??= this.#timers.setTimeout(() => {
      this.#maxTimer = undefined;
      void this.flush();
    }, this.#options.maxDelayMs);
  }

  /** Turns scheduling off (a read-only tab) or back on. Work stays dirty. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) {
      this.#clearTimers();
    } else if (this.#dirty) {
      this.markDirty();
    }
  }

  /**
   * Writes now if there is unsaved work, and again if more edits land
   * while writing. A non-quota failure is retried once at once; a failure
   * after that is reported and the work stays dirty in memory.
   */
  flush(): Promise<void> {
    if (this.#disposed || !this.#enabled) {
      return Promise.resolve();
    }
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #run(): Promise<void> {
    let retried = false;
    while (this.#dirty && this.#enabled && !this.#disposed) {
      this.#clearTimers();
      this.#dirty = false;
      this.#setState('saving');
      try {
        await this.#save();
      } catch (error) {
        // The write stored nothing; the in-memory Project is still master.
        this.#dirty = true;
        if (!isQuotaError(error) && !retried) {
          retried = true;
          continue;
        }
        this.#setState('failed');
        this.#options.onError?.(error);
        return;
      }
      retried = false;
      this.#options.onSaved?.();
    }
    if (!this.#dirty) {
      this.#setState('saved');
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
  }
}
