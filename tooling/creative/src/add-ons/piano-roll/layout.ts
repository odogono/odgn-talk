// Where the Piano Roll draws a pattern (ADR 0175, #2181): its cycles left to
// right until the pattern repeats, a row per note pitch or sound name, and
// a bar per Pattern Event. It reads only the Pattern it is given, so the
// Add-on imports nothing from Folio at run time.
import type { Pattern, PatternEvent, Step, Time } from '../../mini-notation';

/** The most cycles the roll lays out. */
export const MAX_CYCLES = 16;
/** Semitones shown above and below the pitches in use. */
export const PITCH_MARGIN = 3;
/** The full keyboard range: C1 to C8. */
export const FULL_RANGE = { low: 24, high: 108 } as const;

export type RollRow = {
  /** A black key, shaded. */
  black: boolean;
  label: string;
  /** The row's MIDI note, in pitch mode. */
  note?: number;
};

export type RollNote = {
  /** Where it starts and ends from its cycle's start, in cycles. */
  begin: number;
  cycle: number;
  end: number;
  /** The step's characters in the pattern text. */
  from: number;
  /** Its row, from the top. */
  row: number;
  to: number;
};

export type RollLayout = {
  /** Cycles laid out before the pattern repeats, at most MAX_CYCLES. */
  cycles: number;
  mode: 'pitch' | 'sound';
  notes: RollNote[];
  /** Where each rest falls, when the layout was given them (#2182). */
  rests: Omit<RollNote, 'row'>[];
  rows: RollRow[];
  /** Grid divisions per cycle, from the shortest steps. */
  steps: number;
};

/** Every rest step's place in a text, from its step tree. */
export const restOffsets = (layers: readonly Step[][]): number[] => {
  const found: number[] = [];
  const visit = (step: Step) => {
    if (step.kind === 'rest') {
      found.push(step.from);
    } else if (step.kind === 'sequence' || step.kind === 'alternation') {
      step.layers.flat().forEach(visit);
    } else if (step.kind !== 'word') {
      visit(step.step);
    }
  };
  layers.flat().forEach(visit);
  return found;
};

/**
 * `text` with each rest written as a one-letter word, so its parse places
 * the rests as events at the same characters.
 */
export const restsAsWords = (text: string, rests: readonly number[]): string =>
  rests.reduce((t, at) => `${t.slice(0, at)}r${t.slice(at + 1)}`, text);

const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const BLACK = new Set([1, 3, 6, 8, 10]);

/** A MIDI note's name as Mini-Notation writes it, such as `a#4`. */
export const noteLabel = (note: number): string =>
  `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

/** `t` less `c` cycles, exactly: Times are reduced fractions. */
const within = (t: Time, c: number) => ({ n: t.n - c * t.d, d: t.d });

/** Cycle `c`'s events, placed within it, as text for comparing cycles. */
const shape = (events: PatternEvent[], c: number) =>
  events
    .map(e => {
      const begin = within(e.begin, c);
      const end = within(e.end, c);
      return `${e.from}:${e.to}:${begin.n}/${begin.d}:${end.n}/${end.d}`;
    })
    .join('|');

/** How many cycles pass before the pattern repeats, up to MAX_CYCLES. */
export const cyclesOf = (pattern: Pattern): number => {
  const shapes: string[] = [];
  const at = (c: number) => (shapes[c] ??= shape(pattern.cycle(c), c));
  for (let period = 1; period < MAX_CYCLES; period++) {
    let repeats = true;
    for (let c = 0; c < period && repeats; c++) {
      repeats = at(c) === at(c + period);
    }
    if (repeats) {
      return period;
    }
  }
  return MAX_CYCLES;
};

const fraction = ({ n, d }: { d: number; n: number }) => n / d;

const soundLabel = (e: PatternEvent) =>
  e.value.index === undefined
    ? e.value.name
    : `${e.value.name}:${e.value.index}`;

/** Lays out `pattern` for the roll; `fullRange` shows the whole keyboard. */
export const pianoRollLayout = (
  pattern: Pattern,
  {
    fullRange = false,
    rests,
  }: {
    fullRange?: boolean;
    /** The pattern with its rests as words, and where they are. */
    rests?: { at: readonly number[]; pattern: Pattern };
  } = {},
): RollLayout => {
  const cycles = cyclesOf(pattern);
  const events = Array.from({ length: cycles }, (_, c) =>
    pattern.cycle(c).map(event => ({ c, event })),
  ).flat();
  const mode =
    events.length > 0 &&
    events.every(({ event }) => event.value.note !== undefined)
      ? 'pitch'
      : 'sound';
  const restAt = new Set(rests?.at ?? []);
  const restEvents = rests
    ? Array.from({ length: cycles }, (_, c) =>
        rests.pattern
          .cycle(c)
          .filter(event => restAt.has(event.from))
          .map(event => ({ c, event })),
      ).flat()
    : [];
  let steps = 1;
  for (const { event } of [...events, ...restEvents]) {
    steps = Math.min(64, lcm(steps, lcm(event.begin.d, event.end.d)));
  }
  let rows: RollRow[];
  let rowOf: (event: PatternEvent) => number;
  if (mode === 'pitch') {
    const notes = events.map(({ event }) => event.value.note!);
    const low = fullRange
      ? Math.min(FULL_RANGE.low, ...notes)
      : Math.max(0, Math.min(...notes) - PITCH_MARGIN);
    const high = fullRange
      ? Math.max(FULL_RANGE.high, ...notes)
      : Math.min(127, Math.max(...notes) + PITCH_MARGIN);
    rows = [];
    for (let note = high; note >= low; note--) {
      rows.push({ black: BLACK.has(note % 12), label: noteLabel(note), note });
    }
    rowOf = event => high - event.value.note!;
  } else {
    const labels = [...new Set(events.map(({ event }) => soundLabel(event)))];
    rows = labels.map(label => ({ black: false, label }));
    rowOf = event => labels.indexOf(soundLabel(event));
  }
  return {
    cycles,
    mode,
    rows,
    steps,
    rests: restEvents.map(({ c, event }) => ({
      cycle: c,
      begin: fraction(within(event.begin, c)),
      end: fraction(within(event.end, c)),
      from: event.from,
      to: event.to,
    })),
    notes: events.map(({ c, event }) => ({
      cycle: c,
      begin: fraction(within(event.begin, c)),
      end: fraction(within(event.end, c)),
      from: event.from,
      to: event.to,
      row: rowOf(event),
    })),
  };
};
