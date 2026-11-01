// A Play Session's Transport (ADR 0158, #1892): its tempo, time signature
// and position, on the Play clock in microseconds. Beats fall on a grid that
// starts at `origin`; a tempo change re-anchors the grid at the current
// position, so the beat in progress keeps its place and durations already
// converted keep their length.

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

const MINUTE_US = 60_000_000;

export class Transport {
  #tempo = DEFAULT_TEMPO;
  #beatsPerBar = 4;
  #beatUnit = 4;
  #running = false;
  /** The Play-clock time beat `#originCount` falls on. */
  #origin = 0n;
  #originCount = 0;
  /** The next beat to deliver. */
  #next = 0;

  get tempo(): number {
    return this.#tempo;
  }
  get beatsPerBar(): number {
    return this.#beatsPerBar;
  }
  get beatUnit(): number {
    return this.#beatUnit;
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

  /** Where beat `count` falls in the bar. */
  position(count: number): BeatPosition {
    return {
      bar: Math.floor(count / this.#beatsPerBar) + 1,
      beat: (count % this.#beatsPerBar) + 1,
      count,
    };
  }

  /**
   * Starts from bar 1, its first beat sounding one lead after `now` so it can
   * be delivered at once. A running Transport is left alone.
   */
  start(now: bigint): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#origin = now + LEAD_US;
    this.#originCount = 0;
    this.#next = 0;
  }

  stop(): void {
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

  /** Changes the time signature; bars count from the next beat delivered. */
  setTimeSignature(beatsPerBar: number, beatUnit: number): void {
    this.#beatsPerBar = beatsPerBar;
    this.#beatUnit = beatUnit;
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
}
