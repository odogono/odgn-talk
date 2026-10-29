// One call's synchronous `charge` (spec/embedding/metered-operations.md):
// legal only while the Operation is starting, a whole Fuel amount, and
// refused for good once one increment doesn't fit. Whether an increment fits
// is the caller's: a TS Run's budget, or the Fuel the Zig Core says is left.
import { LimitReached } from './capabilities';
import { HostError } from './errors';

/** Spends `fuel` if it fits, after `charged` already accepted; false if not. */
export type Take = (fuel: number, charged: number) => boolean;

export class CallMeter {
  /** The Fuel accepted increments added up to. */
  charged = 0;
  /** An increment didn't fit: the call faults, whatever the Host does next. */
  refused = false;
  #starting = false;

  constructor(private readonly take: Take) {}

  /** Runs the Operation's starting callback, the only time it may charge. */
  starting<T>(start: () => T): T {
    this.#starting = true;
    try {
      return start();
    } finally {
      this.#starting = false;
    }
  }

  readonly charge = (fuel: number): void => {
    if (!this.#starting) {
      throw new HostError('invalid value', 'Charge only while starting');
    }
    if (!Number.isSafeInteger(fuel) || fuel < 0) {
      throw new HostError('invalid value', 'Fuel must be a whole number');
    }
    if (this.refused || !this.take(fuel, this.charged)) {
      this.refused = true;
      throw new LimitReached('the Run can’t cover this charge');
    }
    this.charged += fuel;
  };
}
