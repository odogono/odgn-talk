// The Play clock of a session with audio (ADR 0156, #1892): the page's
// audio clock plus a safety margin, extrapolated between the readings the
// page sends. Readings pair `AudioContext.currentTime` with an absolute
// time in ms (`performance.timeOrigin + performance.now()`), which the page
// and the Play worker share although their `performance.now()` differ.

/** How far ahead of the audio clock the Play clock runs. */
export const MARGIN_US = 15_000n;

/** One reading of the page's audio clock. */
export type AudioReading = {
  /** `AudioContext.currentTime`, in seconds. */
  readonly audio: number;
  /** When it was read: `performance.timeOrigin + performance.now()`, in ms. */
  readonly epoch: number;
  /**
   * Whether the audio clock was running. A stopped one, such as an
   * AudioContext that hasn't started yet, holds still between readings.
   */
  readonly running?: boolean;
};

export class AudioClock {
  #reading: AudioReading | undefined;
  /** The latest time given out; the clock never goes backwards. */
  #last = 0n;
  /** The Play-clock time held while paused. */
  #frozen: bigint | undefined;
  /** How far Steps have moved the clock past the audio clock. */
  #offset = 0n;

  constructor(private readonly epochNow: () => number) {}

  /** Whether a reading has arrived, so this clock drives the session. */
  get active(): boolean {
    return this.#reading !== undefined;
  }

  read(reading: AudioReading): void {
    this.#reading = reading;
  }

  /** The Play clock, in microseconds. */
  now(): bigint {
    if (this.#frozen !== undefined) {
      return this.#frozen;
    }
    const reading = this.#reading;
    if (!reading) {
      return this.#last;
    }
    const audio =
      reading.running === false
        ? reading.audio
        : reading.audio + (this.epochNow() - reading.epoch) / 1000;
    const now =
      BigInt(Math.round(audio * 1_000_000)) + MARGIN_US + this.#offset;
    if (now > this.#last) {
      this.#last = now;
    }
    return this.#last;
  }

  /** The audio stops with the Play clock; it holds its time. */
  pause(): void {
    this.#frozen ??= this.now();
  }

  /**
   * Continues from the held time. The audio restarts a moment later, so the
   * clock carries on from where it stopped until a fresh reading arrives.
   */
  resume(): void {
    const frozen = this.#frozen;
    if (frozen === undefined) {
      return;
    }
    this.#frozen = undefined;
    if (this.#reading) {
      this.#reading = {
        audio: Number(frozen - MARGIN_US - this.#offset) / 1_000_000,
        epoch: this.epochNow(),
      };
    }
  }

  /** A Step moves a paused clock on without starting the audio. */
  step(us: bigint): void {
    if (this.#frozen !== undefined) {
      this.#frozen += us;
      this.#offset += us;
      this.#last = this.#frozen;
    }
  }

  /** A Play-clock time, in seconds, as a time on the audio clock. */
  toAudio(seconds: number): number {
    return seconds - Number(this.#offset) / 1_000_000;
  }
}
