// Session observation (spec/session-observation.md): trace filters, latched
// traced Runs and Fuel Measurements, read only from public Run accounting
// reports. It never inspects the Group.
import type { Report } from '../group';
import { validComputedMessageName } from '../selectors';
import { traceValue } from '../trace';
import { listValues, nothing, text } from '../values';

// One `:fuel` Entry's measurement: its root Delivery and every Run and
// queued message spawned from it.
type Measurement = {
  /** Printed its first row; printed its final row. */
  announced: boolean;
  closed: boolean;
  /** A causal work record has reported the root. */
  counted: boolean;
  entry: number;
  /** Each member Run's latest cumulative Fuel, in first-reported order. */
  fuel: Map<string, number>;
  interrupted: boolean;
  live: number;
  queued: number;
  root: string;
};

const settled = (m: Measurement) => m.counted && m.live === 0 && m.queued === 0;

// A map in the display form, its fields in the order given.
const row = (fields: [string, string][]) =>
  `{${fields.map(([k, v]) => `${k}: ${v}`).join(', ')}}`;
const textForm = (s: string) => text(s).toString();

const fuelRow = (m: Measurement) => {
  const fuel = [...m.fuel.values()].reduce((a, b) => a + b, 0);
  const state = !settled(m)
    ? 'pending'
    : m.interrupted
      ? 'interrupted'
      : 'complete';
  return `fuel ${row([
    ['entry', textForm(`entry${m.entry}`)],
    ['fuel', String(fuel)],
    ['state', textForm(state)],
    ['interrupted', String(m.interrupted)],
    ['runs', String(m.live)],
    ['queued', String(m.queued)],
  ])}`;
};

// A full Selector, as a static `send` could name a message.
export const selectorText = (s: string) =>
  validComputedMessageName(s, s.includes(':') ? s.split(':').length - 1 : 0);

export class Observation {
  private filters = new Set<string>();
  // Each traced Run's message Selector.
  private traced = new Map<string, string>();
  private measurements: Measurement[] = [];
  // Trace rows awaiting the end of this Host call.
  private lines: string[] = [];

  clone(): Observation {
    const c = new Observation();
    c.filters = new Set(this.filters);
    c.traced = new Map(this.traced);
    c.measurements = this.measurements.map(m => ({
      ...m,
      fuel: new Map(m.fuel),
    }));
    return c;
  }

  /** `:trace` and `:untrace`. */
  trace(name: 'trace' | 'untrace', rest: string): string[] | null {
    const selector = rest.trim();
    if (selector && !selectorText(selector)) {
      return null;
    }
    if (name === 'untrace') {
      if (selector) {
        this.filters.delete(selector);
      } else {
        this.filters.clear();
      }
    } else if (selector) {
      this.filters.add(selector);
    } else {
      // Code-point order, not UTF-16 order.
      return [...this.filters]
        .sort((a, b) => {
          const x = [...a].map(c => c.codePointAt(0)!);
          const y = [...b].map(c => c.codePointAt(0)!);
          for (let i = 0; i < Math.min(x.length, y.length); i++) {
            if (x[i] !== y[i]) {
              return x[i]! - y[i]!;
            }
          }
          return x.length - y.length;
        })
        .map(s => `trace ${textForm(s)}`);
    }
    return [];
  }

  /** Starts measuring the Entry whose Request made this root Delivery. */
  measure(entry: number, root: string) {
    this.measurements.push({
      announced: false,
      closed: false,
      counted: false,
      entry,
      fuel: new Map(),
      interrupted: false,
      live: 0,
      queued: 0,
      root,
    });
  }

  /** Bare `:fuel`: every measurement's current row, in Entry order. */
  rows(): string[] {
    return this.measurements.map(fuelRow);
  }

  /** The Entry names of measurements still pending, which a restore abandons. */
  pending(): string[] {
    return this.measurements
      .filter(m => !settled(m))
      .map(m => `entry${m.entry}`);
  }

  // A latched Run's terminal row; an untraced Run prints none.
  private end(script: string, run: string, fields: [string, string][]) {
    const selector = this.traced.get(run);
    if (selector === undefined) {
      return;
    }
    this.traced.delete(run);
    this.lines.push(
      `trace end ${row([
        ['script', textForm(script)],
        ['run', textForm(run)],
        ['selector', textForm(selector)],
        ...fields,
      ])}`,
    );
  }

  private measured(root: string): Measurement | undefined {
    return this.measurements.find(m => m.root === root);
  }

  /**
   * Follows one Host call's reports, in order. `errors` holds each errored
   * Run's projected error, as its `! error` row shows it.
   */
  observe(reports: readonly Report[], errors?: ReadonlyMap<string, string>) {
    for (const r of reports) {
      if (r.kind === 'run started') {
        if (r.selector !== undefined && this.filters.has(r.selector)) {
          this.traced.set(r.run, r.selector);
          this.lines.push(
            `trace start ${row([
              ['script', textForm(r.script)],
              ['run', textForm(r.run)],
              ['selector', textForm(r.selector)],
              ['args', traceValue(listValues(r.args))],
            ])}`,
          );
        }
      } else if (r.kind === 'run end') {
        const fields: [string, string][] = [['outcome', textForm(r.outcome)]];
        if (r.outcome === 'completed') {
          fields.push(['result', traceValue(r.result ?? nothing)]);
        } else if (r.outcome === 'errored') {
          fields.push(['error', errors?.get(r.run ?? '') ?? '']);
        } else if (r.outcome === 'limit fault') {
          fields.push(['limit', textForm(r.limit ?? '')]);
        } else if (r.outcome === 'effect failed' && r.effect) {
          const e = r.effect;
          fields.push([
            'effect',
            row([
              ['script', textForm(e.script)],
              ['run', textForm(e.run)],
              ['grant', textForm(e.grant)],
              ['segment', textForm(e.segment)],
              ['phase', textForm(e.phase)],
              ['status', textForm(e.status)],
              ...(e.scope
                ? [['scope', textForm(e.scope)] as [string, string]]
                : []),
            ]),
          ]);
        }
        if (r.run) {
          this.end(r.script, r.run, fields);
        }
      } else if (r.kind === 'run discarded') {
        this.end(r.script, r.run, [
          ['outcome', textForm('discarded')],
          ['reason', textForm(r.reason)],
        ]);
      } else if (r.kind === 'run accounting') {
        const m = this.measured(r.rootDelivery);
        if (m) {
          m.fuel.set(r.run, r.fuel);
          m.interrupted ||= r.state === 'discarded';
        }
      } else if (r.kind === 'causal work') {
        const m = this.measured(r.rootDelivery);
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
   * This Host call's trace rows, then its Fuel milestones: a new
   * measurement's first row, and the final row of each one that has settled.
   */
  observed(): string[] {
    const out = this.lines;
    this.lines = [];
    for (const m of this.measurements) {
      if (m.closed || (m.announced && !settled(m))) {
        continue;
      }
      m.announced = true;
      m.closed = settled(m);
      out.push(fuelRow(m));
    }
    return out;
  }
}
