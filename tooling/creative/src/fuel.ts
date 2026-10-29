// `:fuel` in the Message Box (ADR 0141): the Fuel Measurement of one
// command's root Delivery and every Run and message it spawns, read from the
// Group's public Run accounting reports as the Session Host reads them.
import { type Report } from '@northtalk/ts';

type Measurement = {
  /** A causal work report has named the root. */
  counted: boolean;
  /** Each member Run's latest cumulative Fuel. */
  fuel: Map<string, number>;
  interrupted: boolean;
  live: number;
  queued: number;
};

/** A measurement as the Message Box prints it. */
export type FuelRow = {
  fuel: number;
  interrupted: boolean;
  queued: number;
  runs: number;
  state: 'complete' | 'interrupted' | 'pending';
};

export class FuelMeasurements {
  readonly #measurements = new Map<string, Measurement>();

  /** Starts measuring the work rooted at `delivery`. */
  measure(delivery: string): void {
    this.#measurements.set(delivery, {
      counted: false,
      fuel: new Map(),
      interrupted: false,
      live: 0,
      queued: 0,
    });
  }

  /** Follows one Host call's reports. */
  observe(reports: readonly Report[]): void {
    for (const r of reports) {
      if (r.kind === 'run accounting') {
        const m = this.#measurements.get(r.rootDelivery);
        if (m) {
          m.fuel.set(r.run, r.fuel);
          m.interrupted ||= r.state === 'discarded';
        }
      } else if (r.kind === 'causal work') {
        const m = this.#measurements.get(r.rootDelivery);
        if (m) {
          m.counted = true;
          m.live = r.liveRuns;
          m.queued = r.queuedMessages;
          m.interrupted ||= r.discardedMessages > 0;
        }
      }
    }
  }

  /**
   * The measurement's row, then measuring stops, since the Message Box
   * prints one reply; undefined for a delivery never measured.
   */
  take(delivery: string): FuelRow | undefined {
    const m = this.#measurements.get(delivery);
    if (!m) {
      return undefined;
    }
    this.#measurements.delete(delivery);
    const settled = m.counted && m.live === 0 && m.queued === 0;
    return {
      fuel: [...m.fuel.values()].reduce((a, b) => a + b, 0),
      interrupted: m.interrupted,
      queued: m.queued,
      runs: m.live,
      state: !settled ? 'pending' : m.interrupted ? 'interrupted' : 'complete',
    };
  }
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One line for the Message Box, after the command's own value. */
export const fuelText = (row: FuelRow): string =>
  row.state === 'pending'
    ? `Fuel: ${row.fuel} so far, with ${count(row.runs, 'Run')} and ${count(row.queued, 'message')} still pending`
    : `Fuel: ${row.fuel}${row.state === 'interrupted' ? ' (interrupted)' : ''}`;
