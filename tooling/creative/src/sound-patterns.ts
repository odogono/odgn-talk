// A Play Session's Sound Patterns (ADR 0159, #1896). Folio schedules every
// step on the Transport itself, so no Run is started and no Fuel is spent
// per note. Steps are sent to the audio one lead ahead of their time, so a
// Pump wakes for each step and Stop silences all but the last lead's worth.
//
// `loop` starts on the next bar and repeats each bar, one cycle per bar; a
// Script has at most one loop per Instrument, and a second `loop` replaces
// the first on the next bar. `play` spreads one cycle over one bar from now.
import { soundKey } from './sounds';
import type { InstrumentCommand } from './instruments/kind';
import type { InstrumentMessage } from './instruments/session';
import { Time, type Pattern, type PatternEvent } from './mini-notation';
import { LEAD_US, type Transport } from './transport';

/** A pattern's `with` options. */
export type PatternOptions = {
  readonly gain?: number;
  readonly pan?: number;
  readonly speed?: number;
};

/** How an Instrument turns a step into a note. */
export type PatternTarget = {
  /** The Instrument's name, or the default sampler's. */
  readonly instrument: string;
  /** A sampler plays steps as sounds, any other kind as notes. */
  readonly sampler: boolean;
};

/** A Sound Pattern as Folio holds it. */
export type SoundPattern = {
  readonly options: PatternOptions;
  readonly pattern: Pattern;
  /** The pattern text, for reports and tests. */
  readonly text: string;
};

/**
 * A Pattern Event as it is sent to sound (#2176), for the Playing Highlight:
 * the Script that owns it, its pattern text and the event's characters in
 * that text, and when it sounds and ends on the Play clock.
 */
export type HeardEvent = {
  /** The pattern's cycle the event falls in, from 0 when it starts. */
  cycle: number;
  end: bigint;
  from: number;
  owner: string;
  text: string;
  time: bigint;
  to: number;
};

type Segment = SoundPattern & {
  /** The bar it starts on; undefined until the Transport runs. */
  from: number | undefined;
};

type Loop = {
  /** Scheduled up to here, in bars. */
  cursor: Time | undefined;
  readonly owner: string;
  /** In bar order; each plays until the next one starts. */
  segments: Segment[];
  readonly target: PatternTarget;
};

type Shot = {
  readonly end: bigint;
  readonly event: PatternEvent;
  readonly options: PatternOptions;
  readonly owner: string;
  readonly target: PatternTarget;
  readonly text: string;
  readonly time: bigint;
};

// Bars as exact fractions: a millionth of a bar is well under a sample.
const STEPS = 1_000_000;
/** Just past `bars`, so a step that falls exactly on it is included. */
const justAfter = (bars: number) =>
  new Time(Math.floor(bars * STEPS) + 1, STEPS);

// A note's release comes this much before its step ends, so a step that
// repeats the note is never cut off by the release before it.
const RELEASE_EARLY_US = 2000n;

/** The Project sound a step plays. */
export const stepSound = (event: PatternEvent): string => soundKey(event.value);

const seconds = (t: bigint) => Number(t) / 1_000_000;

export class SoundPatterns {
  readonly #transport: Transport;
  readonly #send: (message: InstrumentMessage) => void;
  /** By owner, then Instrument. */
  readonly #loops = new Map<string, Loop>();
  /** One-shot steps from `play`, in time order. */
  #shots: Shot[] = [];

  /**
   * The bar each Punched In Script's new loops start on (ADR 0157), kept
   * until the Pump that applied it ends, so a late Pump doesn't move them.
   */
  readonly #punched = new Map<string, number>();

  /**
   * The loops a Punch In has made so far, so a later `loop` on the same
   * Instrument replaces one from the punched bar, as it would while browsing.
   */
  readonly #punchedLoops = new Set<string>();

  /** Whether loops play; Edit holds them without playing (ADR 0159). */
  readonly #loopsPlay: boolean;

  /** Hears each Pattern Event as it is sent to sound (#2176). */
  readonly #heard: ((event: HeardEvent) => void) | undefined;

  constructor(
    transport: Transport,
    send: (message: InstrumentMessage) => void,
    {
      heard,
      loopsPlay = true,
    }: { heard?: (event: HeardEvent) => void; loopsPlay?: boolean } = {},
  ) {
    this.#transport = transport;
    this.#send = send;
    this.#loopsPlay = loopsPlay;
    this.#heard = heard;
  }

  /** The Sound Patterns a Script loops, by Instrument; for tests and views. */
  loops(owner: string): { instrument: string; text: string }[] {
    return [...this.#loops.values()]
      .filter(loop => loop.owner === owner)
      .map(loop => ({
        instrument: loop.target.instrument,
        text: loop.segments.at(-1)!.text,
      }));
  }

  /** Whether a Script loops a Sound Pattern or has `play` steps to send. */
  owns(owner: string): boolean {
    return (
      [...this.#loops.values()].some(loop => loop.owner === owner) ||
      this.#shots.some(shot => shot.owner === owner)
    );
  }

  /** Whether any Script loops a Sound Pattern. */
  get looping(): boolean {
    return this.#loops.size > 0;
  }

  /** Whether any step is still to be sent. */
  get active(): boolean {
    return this.#loops.size > 0 || this.#shots.length > 0;
  }

  /**
   * Loops a pattern from the next bar no step has been sent for, replacing
   * the owner's loop on the same Instrument from that bar. `at`, the
   * calling Run's musical time, such as the bar line a `wait 8 bars` ended
   * on, starts it on the bar at or after that time even in a late Pump.
   */
  loop(
    owner: string,
    target: PatternTarget,
    sound: SoundPattern,
    now: bigint,
    at?: bigint,
  ): void {
    const key = `${owner}\u0000${target.instrument}`;
    const existing = this.#loops.get(key);
    const punched = this.#transport.running
      ? this.#punched.get(owner)
      : undefined;
    const fromPunch =
      punched !== undefined && (!existing || this.#punchedLoops.has(key));
    const from = fromPunch
      ? punched
      : this.#nextBar(existing?.cursor, at ?? now + LEAD_US);
    if (fromPunch) {
      this.#punchedLoops.add(key);
    }
    if (!existing) {
      this.#loops.set(key, {
        owner,
        target,
        cursor: from === undefined ? undefined : new Time(from),
        segments: [{ ...sound, from }],
      });
      return;
    }
    existing.segments = [
      ...existing.segments.filter(
        s => s.from !== undefined && from !== undefined && s.from < from,
      ),
      { ...sound, from },
    ];
  }

  /** Plays one cycle of a pattern over one bar, from `start`. */
  play(
    owner: string,
    target: PatternTarget,
    sound: SoundPattern,
    start: bigint,
  ): void {
    const transport = this.#transport;
    const bar = transport.duration(
      transport.meterAt(transport.countAt(start)).beatsPerBar,
    );
    const at = (t: Time) =>
      start + BigInt(Math.round(t.valueOf() * Number(bar)));
    for (const event of sound.pattern.cycle(0)) {
      this.#shots.push({
        owner,
        target,
        event,
        text: sound.text,
        options: sound.options,
        time: at(event.begin),
        end: at(event.end),
      });
    }
    this.#shots.sort((a, b) =>
      a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
    );
  }

  /** A Punch In's new loops for `owner` start on `bar`, until `settle`. */
  punchedAt(owner: string, bar: number): void {
    this.#punched.set(owner, bar);
  }

  /** Ends the Pump's Punch Ins: later loops start on the next bar. */
  settle(): void {
    this.#punched.clear();
    this.#punchedLoops.clear();
  }

  /**
   * Ends an owner's Sound Patterns, on one Instrument or all of them. Steps
   * already sent still sound, at most a lead's worth.
   */
  stop(owner: string, instrument?: string): void {
    for (const [key, loop] of this.#loops) {
      if (
        loop.owner === owner &&
        (instrument === undefined || loop.target.instrument === instrument)
      ) {
        this.#loops.delete(key);
      }
    }
    this.#shots = this.#shots.filter(
      shot =>
        shot.owner !== owner ||
        (instrument !== undefined && shot.target.instrument !== instrument),
    );
  }

  stopAll(): void {
    this.#loops.clear();
    this.#shots = [];
  }

  /** Sends every step `play` has queued, however far ahead; for previews. */
  flush(): void {
    for (const shot of this.#shots) {
      this.#sound(shot, shot.event, shot.options, shot.time, shot.end);
    }
    this.#shots = [];
  }

  /** Sends every step due within a lead of `now`. */
  schedule(now: bigint): void {
    const horizon = now + LEAD_US;
    while (this.#shots.length && this.#shots[0]!.time <= horizon) {
      const shot = this.#shots.shift()!;
      this.#sound(shot, shot.event, shot.options, shot.time, shot.end);
    }
    if (!this.#transport.running || !this.#loopsPlay) {
      return;
    }
    const until = justAfter(this.#bars(horizon));
    for (const loop of this.#loops.values()) {
      this.#scheduleLoop(loop, until, now);
    }
  }

  /** When the next step must be sent, a lead before it sounds. */
  nextDeadline(): bigint | undefined {
    let next = this.#shots[0]?.time;
    if (this.#transport.running && this.#loopsPlay) {
      for (const loop of this.#loops.values()) {
        const time = this.#nextStep(loop);
        if (time !== undefined && (next === undefined || time < next)) {
          next = time;
        }
      }
    }
    return next === undefined ? undefined : next - LEAD_US;
  }

  // Bars count on the Transport's Meters, so a time-signature change
  // lengthens or shortens the bars after its bar line.
  #bars(time: bigint): number {
    return this.#transport.barAt(this.#transport.countAt(time));
  }

  #timeOf(bars: Time): bigint {
    return this.#transport.timeOf(this.#transport.countOfBar(bars.valueOf()));
  }

  /** The first bar after `cursor` and at or after `time`. */
  #nextBar(cursor: Time | undefined, time: bigint): number | undefined {
    if (!this.#transport.running) {
      return undefined;
    }
    const due = Math.ceil(this.#bars(time) - 1e-6);
    return cursor === undefined ? due : Math.max(due, cursor.ceil());
  }

  /** Sends a loop's steps that start before `until`, in bars. */
  #scheduleLoop(loop: Loop, until: Time, now: bigint): void {
    if (loop.cursor === undefined) {
      // A loop made while the Transport was stopped starts once it runs.
      const from = this.#nextBar(undefined, now + LEAD_US)!;
      for (const segment of loop.segments) {
        segment.from = from;
      }
      loop.segments = loop.segments.slice(-1);
      loop.cursor = new Time(from);
    }
    const cursor = loop.cursor;
    if (!cursor.lt(until)) {
      return;
    }
    for (const [i, segment] of loop.segments.entries()) {
      const start = new Time(segment.from!);
      const next = loop.segments[i + 1];
      const end = next === undefined ? until : new Time(next.from!);
      const from = cursor.lt(start) ? start : cursor;
      const to = until.lt(end) ? until : end;
      if (!from.lt(to)) {
        continue;
      }
      // The pattern's own cycle 0 is the bar the segment starts on.
      for (const event of segment.pattern.query(
        from.sub(start),
        to.sub(start),
      )) {
        this.#sound(
          { owner: loop.owner, target: loop.target, text: segment.text },
          event,
          segment.options,
          this.#timeOf(event.begin.add(start)),
          this.#timeOf(event.end.add(start)),
        );
      }
    }
    loop.cursor = until;
    // Segments that have ended are dropped.
    while (
      loop.segments.length > 1 &&
      !until.lt(new Time(loop.segments[1]!.from!))
    ) {
      loop.segments.shift();
    }
  }

  /** When a loop's next unsent step sounds. */
  #nextStep(loop: Loop): bigint | undefined {
    if (loop.cursor === undefined) {
      return undefined;
    }
    const cursor = loop.cursor;
    // Every pattern has a step in each bar or is all rests, so two bars
    // always find the next step if there is one.
    const until = new Time(cursor.floor() + 2);
    let next: bigint | undefined;
    for (const [i, segment] of loop.segments.entries()) {
      const start = new Time(segment.from!);
      const following = loop.segments[i + 1];
      const end = following === undefined ? until : new Time(following.from!);
      const from = cursor.lt(start) ? start : cursor;
      const to = until.lt(end) ? until : end;
      if (!from.lt(to)) {
        continue;
      }
      const [event] = segment.pattern.query(from.sub(start), to.sub(start));
      if (event) {
        const time = this.#timeOf(event.begin.add(start));
        if (next === undefined || time < next) {
          next = time;
        }
      }
    }
    // A bar of rests still needs a wake-up at its end to move on.
    return next ?? this.#timeOf(until);
  }

  #sound(
    {
      owner,
      target,
      text,
    }: { owner: string; target: PatternTarget; text: string },
    event: PatternEvent,
    options: PatternOptions,
    time: bigint,
    end: bigint,
  ): void {
    const velocity = options.gain ?? 1;
    let command: InstrumentCommand | undefined;
    if (target.sampler) {
      command = {
        kind: 'note',
        note: 60,
        sound: stepSound(event),
        velocity,
        ...(options.pan === undefined ? {} : { pan: options.pan }),
        ...(options.speed === undefined ? {} : { speed: options.speed }),
      };
    } else if (event.value.note !== undefined) {
      command = { kind: 'note', note: event.value.note, velocity };
    }
    if (!command) {
      return;
    }
    this.#send({
      instrument: target.instrument,
      at: seconds(time),
      commands: [command],
    });
    this.#heard?.({
      owner,
      text,
      cycle: event.begin.floor(),
      from: event.from,
      to: event.to,
      time,
      end,
    });
    if (!target.sampler && command.kind === 'note') {
      const release =
        end - RELEASE_EARLY_US > time ? end - RELEASE_EARLY_US : end;
      this.#send({
        instrument: target.instrument,
        at: seconds(release),
        commands: [{ kind: 'release', note: command.note }],
      });
    }
  }
}
