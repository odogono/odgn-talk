// A Play Session's Transport (ADR 0158, #1892): its tempo, time signature
// and position, on the Play clock in microseconds. Beats fall on a grid that
// starts at `origin`; a tempo change re-anchors the grid at the current
// position, so the beat in progress keeps its place and durations already
// converted keep their length. Bars are counted on a table of Meters, so a
// time-signature change takes effect at the next bar line and bars number on
// from there (ADR 0166). The Transport also holds Scripts' musical Waits,
// `wait 8 bars` and `wait 2 beats`, and says when each ends.

/** How long before its musical time each `beat` is delivered (ADR 0156). */
export const LEAD_US = 100_000n;

export const DEFAULT_TEMPO = 120;
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 400;
export const MAX_BEATS_PER_BAR = 32;
export const BEAT_UNITS = [1, 2, 4, 8, 16, 32] as const;

/** Where a beat falls: its bar and beat from 1, and a running count from 0. */
export type BeatPosition = {
  readonly bar: number;
  readonly beat: number;
  readonly count: number;
};

/** A time signature from a bar line on: `bar` counts from 0 for bar 1. */
export type Meter = {
  readonly bar: number;
  readonly beatsPerBar: number;
  readonly beatUnit: number;
  readonly count: number;
};

/** What a musical Wait counts: bar lines or beat lines. */
export type MusicalUnit = 'bar' | 'beat';

/**
 * A Script's `wait N bars` or `wait N beats`. While the Transport runs it
 * ends on `line`, a bar from 0 or a beat count; while it is stopped the Wait
 * is held with `remaining` lines still to come.
 */
export type MusicalWait = {
  line: number | undefined;
  remaining: number;
  readonly unit: MusicalUnit;
};

const MINUTE_US = 60_000_000;
/** A millionth of a beat or bar absorbs the grid's rounding to whole µs. */
const EPSILON = 1e-6;

export class Transport {
  #tempo = DEFAULT_TEMPO;
  #running = false;
  /** The Play-clock time beat `#originCount` falls on. */
  #origin = 0n;
  #originCount = 0;
  /** The next beat to deliver. */
  #next = 0;
  /** In bar order; the first is bar 1, at count 0. */
  #meters: Meter[] = [{ bar: 0, beatUnit: 4, beatsPerBar: 4, count: 0 }];
  readonly #waits = new Set<MusicalWait>();

  get tempo(): number {
    return this.#tempo;
  }
  /** The beats in a bar at the next beat, or once started if stopped. */
  get beatsPerBar(): number {
    return this.meterAt(this.#next).beatsPerBar;
  }
  get beatUnit(): number {
    return this.meterAt(this.#next).beatUnit;
  }
  get running(): boolean {
    return this.#running;
  }

  /** One beat at the current tempo, in microseconds. */
  beatLength(): number {
    return MINUTE_US / this.#tempo;
  }

  /** `beats` beats at the current tempo, in whole microseconds. */
  duration(beats: number): bigint {
    return BigInt(Math.round(beats * this.beatLength()));
  }

  /** The Play-clock time beat `count` falls on, at the current tempo. */
  timeOf(count: number): bigint {
    return this.#origin + this.duration(count - this.#originCount);
  }

  /**
   * The beat count, fractional, that falls at Play-clock `time` at the
   * current tempo; before the grid's origin it is below the origin's count.
   */
  countAt(time: bigint): number {
    return this.#originCount + Number(time - this.#origin) / this.beatLength();
  }

  /** The Meter in effect at beat `count`. */
  meterAt(count: number): Meter {
    let found = this.#meters[0]!;
    for (const meter of this.#meters) {
      if (meter.count > count + EPSILON) {
        break;
      }
      found = meter;
    }
    return found;
  }

  /** The bar, fractional and from 0 for bar 1, that beat `count` falls in. */
  barAt(count: number): number {
    const meter = this.meterAt(count);
    return meter.bar + (count - meter.count) / meter.beatsPerBar;
  }

  /** The beat count bar `bar`, fractional and from 0, falls on. */
  countOfBar(bar: number): number {
    let found = this.#meters[0]!;
    for (const meter of this.#meters) {
      if (meter.bar > bar + EPSILON) {
        break;
      }
      found = meter;
    }
    return found.count + (bar - found.bar) * found.beatsPerBar;
  }

  /** The first bar line, from 0, at or after beat `count`. */
  barLineFrom(count: number): number {
    return Math.ceil(this.barAt(count) - EPSILON);
  }

  /** Where beat `count` falls in the bar. */
  position(count: number): BeatPosition {
    const meter = this.meterAt(count);
    const into = count - meter.count;
    return {
      bar: meter.bar + Math.floor(into / meter.beatsPerBar) + 1,
      beat: (into % meter.beatsPerBar) + 1,
      count,
    };
  }

  /**
   * Starts from bar 1, its first beat sounding one lead after `now` so it can
   * be delivered at once, in the last time signature set. Held Waits count
   * from bar 1's line, which isn't one of theirs. A running Transport is left
   * alone.
   */
  start(now: bigint): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#origin = now + LEAD_US;
    this.#originCount = 0;
    this.#next = 0;
    const { beatUnit, beatsPerBar } = this.#meters.at(-1)!;
    this.#meters = [{ bar: 0, beatUnit, beatsPerBar, count: 0 }];
    for (const wait of this.#waits) {
      wait.line = wait.remaining;
    }
  }

  /**
   * Stops the Transport at `now`. Each Wait is held with the lines it still
   * has to come, which it counts once the Transport starts again.
   */
  stop(now: bigint): void {
    if (!this.#running) {
      return;
    }
    const count = this.countAt(now + LEAD_US);
    for (const wait of this.#waits) {
      if (wait.line !== undefined) {
        const passed =
          wait.unit === 'bar'
            ? Math.floor(this.barAt(count) + EPSILON)
            : Math.floor(count + EPSILON);
        wait.remaining = Math.max(1, wait.line - passed);
        wait.line = undefined;
      }
    }
    this.#running = false;
  }

  /**
   * Changes the tempo from `now`. The grid re-anchors on the next beat not
   * yet delivered, at the time it was due, so no beat moves backwards.
   */
  setTempo(bpm: number, now: bigint): void {
    if (this.#running) {
      const anchor = this.timeOf(this.#next);
      this.#origin = anchor > now ? anchor : now;
      this.#originCount = this.#next;
    }
    this.#tempo = bpm;
  }

  /**
   * Changes the time signature from the next bar line not yet delivered,
   * where bars number on; a stopped Transport takes it from bar 1. A second
   * change before that line replaces the first.
   */
  setTimeSignature(beatsPerBar: number, beatUnit: number): void {
    if (!this.#running) {
      this.#meters = [{ bar: 0, beatUnit, beatsPerBar, count: 0 }];
      return;
    }
    const bar = this.barLineFrom(this.#next);
    const count = this.countOfBar(bar);
    this.#meters = [
      // Meters ended more than a beat ago are no longer read.
      ...this.#meters.filter(
        (meter, i, all) =>
          meter.bar < bar &&
          (all[i + 1] === undefined || all[i + 1]!.count > this.#next - 1),
      ),
      { bar, beatUnit, beatsPerBar, count },
    ];
  }

  /** When the next beat must be delivered, a lead before its time. */
  nextDelivery(): bigint | undefined {
    return this.#running ? this.timeOf(this.#next) - LEAD_US : undefined;
  }

  /**
   * Every beat due for delivery by `now`, each with its musical time. A beat
   * more than a lead late is skipped unless it is the latest, so a session
   * that falls far behind doesn't deliver a burst of stale beats.
   */
  due(now: bigint): { position: BeatPosition; time: bigint }[] {
    if (!this.#running) {
      return [];
    }
    const due: { position: BeatPosition; time: bigint }[] = [];
    while (this.timeOf(this.#next) - LEAD_US <= now) {
      const time = this.timeOf(this.#next);
      if (
        time + LEAD_US >= now ||
        this.timeOf(this.#next + 1) - LEAD_US > now
      ) {
        due.push({ position: this.position(this.#next), time });
      }
      this.#next += 1;
    }
    return due;
  }

  /**
   * Starts a Wait that ends on the `lines`th bar or beat line after beat
   * `from`, a line it starts exactly on not counting (ADR 0166). Without
   * `from`, as when the Transport is stopped, it is held until it starts.
   * A Wait that would start before bar 1 counts from bar 1's line.
   */
  wait(
    unit: MusicalUnit,
    lines: number,
    from: number | undefined,
  ): MusicalWait {
    const wait: MusicalWait = { line: undefined, remaining: lines, unit };
    if (this.#running && from !== undefined) {
      const at = Math.max(0, from);
      wait.line =
        Math.floor((unit === 'bar' ? this.barAt(at) : at) + EPSILON) + lines;
    }
    this.#waits.add(wait);
    return wait;
  }

  /** Forgets a Wait, as when its Run ends some other way. */
  cancel(wait: MusicalWait): void {
    this.#waits.delete(wait);
  }

  /** The Waits still to end. */
  get waits(): ReadonlySet<MusicalWait> {
    return this.#waits;
  }

  /** The Play-clock time a running Wait's line falls on. */
  lineTime(wait: MusicalWait): bigint | undefined {
    if (!this.#running || wait.line === undefined) {
      return undefined;
    }
    return this.timeOf(
      wait.unit === 'bar' ? this.countOfBar(wait.line) : wait.line,
    );
  }

  /** When the next Wait ends, a lead before its line. */
  nextWaitEnd(): bigint | undefined {
    let next: bigint | undefined;
    for (const wait of this.#waits) {
      const time = this.lineTime(wait);
      if (time !== undefined && (next === undefined || time < next)) {
        next = time;
      }
    }
    return next === undefined ? undefined : next - LEAD_US;
  }

  /**
   * Ends every Wait due by `now`, a lead before its line, each with its
   * line's time, even when the Pump comes late.
   */
  endedWaits(now: bigint): { time: bigint; wait: MusicalWait }[] {
    const ended: { time: bigint; wait: MusicalWait }[] = [];
    for (const wait of this.#waits) {
      const time = this.lineTime(wait);
      if (time !== undefined && time - LEAD_US <= now) {
        ended.push({ time, wait });
        this.#waits.delete(wait);
      }
    }
    return ended.sort((a, b) =>
      a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
    );
  }
}
