// Folio's Mini-Notation (ADR 0159, #1893), written from Strudel's documented
// syntax with none of its code. Milestone 1 covers sequences, `-` rests,
// `[ ]` subdivision, `< >` alternation, `*n` and `/n`, `,` layers, `name:n`
// sample indexes and note names. One cycle is one bar.
//
// A pattern answers which events start in a span of cycles. Times are exact
// fractions, so `*3` inside `/2` never drifts, and every event keeps the
// character range of the step that made it.
import { noteNumber } from './instruments/notes';

/** An exact time in cycles. */
export class Time {
  readonly n: number;
  readonly d: number;
  constructor(n: number, d = 1) {
    if (d < 0) {
      [n, d] = [-n, -d];
    }
    const g = gcd(Math.abs(n), d) || 1;
    this.n = n / g;
    this.d = d / g;
  }
  add(t: Time): Time {
    return new Time(this.n * t.d + t.n * this.d, this.d * t.d);
  }
  sub(t: Time): Time {
    return new Time(this.n * t.d - t.n * this.d, this.d * t.d);
  }
  mul(t: Time): Time {
    return new Time(this.n * t.n, this.d * t.d);
  }
  div(t: Time): Time {
    return new Time(this.n * t.d, this.d * t.n);
  }
  lt(t: Time): boolean {
    return this.n * t.d < t.n * this.d;
  }
  floor(): number {
    return Math.floor(this.n / this.d);
  }
  ceil(): number {
    return Math.ceil(this.n / this.d);
  }
  valueOf(): number {
    return this.n / this.d;
  }
  toString(): string {
    return this.d === 1 ? String(this.n) : `${this.n}/${this.d}`;
  }
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** One step's sound: a sample or note name, with an optional sample index. */
export type StepValue = {
  /** The `n` of `name:n`. */
  index?: number;
  /** `bd`, `tr909` or a note such as `c3` or `f#4`. */
  name: string;
  /** The MIDI number when the name is a note name or number. */
  note?: number;
};

export type PatternEvent = {
  /** When the event starts, in cycles. */
  begin: Time;
  /** When it ends, in cycles. */
  end: Time;
  /** The step's character range in the pattern text, end exclusive. */
  from: number;
  to: number;
  value: StepValue;
};

export type MiniNotationError = { from: number; message: string; to: number };

/** The parsed form of a step, with its place in the text. */
export type Step =
  | { from: number; kind: 'word'; to: number; value: StepValue }
  | { from: number; kind: 'rest'; to: number }
  | { from: number; kind: 'sequence'; layers: Step[][]; to: number }
  | { from: number; kind: 'alternation'; layers: Step[][]; to: number }
  | {
      by: Time;
      from: number;
      kind: 'fast' | 'slow';
      step: Step;
      to: number;
    };

export type Pattern = {
  /** The events that start in one cycle, in time order. */
  cycle(index: number): PatternEvent[];
  /** The text's layers, each a sequence of steps. */
  readonly layers: readonly Step[][];
  /** The events that start in `[from, to)`, in time order. */
  query(from: Time, to: Time): PatternEvent[];
  /** Every word step, for checking names. */
  words(): Extract<Step, { kind: 'word' }>[];
};

export type ParseResult =
  { ok: true; pattern: Pattern } | { error: MiniNotationError; ok: false };

const FAILURE = Symbol('Mini-Notation failure');
type Failure = { [FAILURE]: MiniNotationError };
const isFailure = (error: unknown): error is Failure =>
  typeof error === 'object' && error !== null && FAILURE in error;

const WORD = /[A-Za-z0-9#_.]/u;
const DIGITS = /^\d+/u;
const NUMBER = /^\d+(?:\.\d+)?/u;

const parser = (text: string) => {
  let at = 0;
  const fail = (message: string, from = at, to = Math.max(from + 1, at)) => {
    const failure: Failure = {
      [FAILURE]: {
        message,
        from,
        to: Math.min(to, Math.max(text.length, from)),
      },
    };
    throw failure;
  };
  const space = () => {
    while (at < text.length && /\s/u.test(text[at]!)) {
      at += 1;
    }
  };

  const word = (): Step => {
    const from = at;
    // A `-` inside a word is a negative octave, as in `c-1`.
    while (
      at < text.length &&
      (WORD.test(text[at]!) || (text[at] === '-' && at > from))
    ) {
      at += 1;
    }
    const name = text.slice(from, at);
    let index: number | undefined;
    if (text[at] === ':') {
      const digits = DIGITS.exec(text.slice(at + 1))?.[0];
      if (!digits) {
        fail('Write a whole number after “:”, as in bd:3.', at, at + 1);
      }
      index = Number(digits);
      at += 1 + digits!.length;
    }
    const note = index === undefined ? noteFor(name) : undefined;
    return {
      kind: 'word',
      value: {
        name,
        ...(index === undefined ? {} : { index }),
        ...(note === undefined ? {} : { note }),
      },
      from,
      to: at,
    };
  };

  const group = (open: '[' | '<'): Step => {
    const from = at;
    const close = open === '[' ? ']' : '>';
    at += 1;
    const found = layers(close);
    if (text[at] !== close) {
      fail(`This “${open}” has no “${close}”.`, from, from + 1);
    }
    at += 1;
    return {
      kind: open === '[' ? 'sequence' : 'alternation',
      layers: found,
      from,
      to: at,
    };
  };

  const term = (): Step => {
    const c = text[at]!;
    if (c === '-' || c === '~') {
      at += 1;
      return { kind: 'rest', from: at - 1, to: at };
    }
    if (c === '[' || c === '<') {
      return group(c);
    }
    if (WORD.test(c)) {
      return word();
    }
    return fail(`“${c}” can’t start a step.`);
  };

  const step = (): Step => {
    let found = term();
    while (text[at] === '*' || text[at] === '/') {
      const op = text[at]!;
      const number = NUMBER.exec(text.slice(at + 1))?.[0];
      if (!number) {
        fail(`Write a number after “${op}”, as in bd${op}2.`, at, at + 1);
      }
      const by = decimal(number!);
      if (by.n === 0) {
        fail(
          `A step can’t be ${op === '*' ? 'sped up' : 'slowed'} by 0.`,
          at,
          at + 1 + number!.length,
        );
      }
      at += 1 + number!.length;
      found = {
        kind: op === '*' ? 'fast' : 'slow',
        step: found,
        by,
        from: found.from,
        to: at,
      };
    }
    return found;
  };

  const sequence = (close?: string): Step[] => {
    const steps: Step[] = [];
    space();
    while (at < text.length && text[at] !== ',' && text[at] !== close) {
      if (text[at] === ']' || text[at] === '>') {
        fail(`This “${text[at]}” closes nothing.`);
      }
      steps.push(step());
      const before = at;
      space();
      if (
        at === before &&
        at < text.length &&
        ![',', ']', '>'].includes(text[at]!)
      ) {
        fail('Put a space between steps.');
      }
    }
    if (!steps.length) {
      fail(
        close
          ? 'This group needs at least one step.'
          : 'Write at least one step.',
        Math.min(at, Math.max(text.length - 1, 0)),
      );
    }
    return steps;
  };

  const layers = (close?: string): Step[][] => {
    const found = [sequence(close)];
    while (text[at] === ',') {
      at += 1;
      found.push(sequence(close));
    }
    return found;
  };

  return { parse: () => layers(), done: () => at >= text.length, fail };
};

const noteFor = (name: string): number | undefined =>
  /^\d+$/u.test(name) ? noteNumber(Number(name)) : noteNumber(name);

const decimal = (text: string): Time => {
  const [whole, part = ''] = text.split('.');
  const d = 10 ** part.length;
  return new Time(Number(whole) * d + Number(part || 0), d);
};

/** Parses Mini-Notation, or says where and why it can't. */
export const parseMiniNotation = (text: string): ParseResult => {
  try {
    const p = parser(text);
    const found = p.parse();
    if (!p.done()) {
      p.fail('Unexpected text.');
    }
    return { ok: true, pattern: patternOf(found) };
  } catch (error) {
    if (isFailure(error)) {
      return { ok: false, error: error[FAILURE] };
    }
    throw error;
  }
};

// A Query returns the events whose begin lies in `[from, to)`.
type Query = (from: Time, to: Time) => PatternEvent[];

const ONE = new Time(1);

const stack =
  (queries: Query[]): Query =>
  (from, to) =>
    queries.flatMap(q => q(from, to));

const scale =
  (query: Query, by: Time): Query =>
  (from, to) =>
    query(from.mul(by), to.mul(by)).map(e => ({
      ...e,
      begin: e.begin.div(by),
      end: e.end.div(by),
    }));

/** Calls `each` for the part of `[from, to)` in each whole cycle. */
const byCycle = (
  from: Time,
  to: Time,
  each: (cycle: number, from: Time, to: Time) => PatternEvent[],
): PatternEvent[] => {
  const events: PatternEvent[] = [];
  for (let c = from.floor(); new Time(c).lt(to); c += 1) {
    const start = new Time(c);
    const end = start.add(ONE);
    events.push(
      ...each(c, from.lt(start) ? start : from, to.lt(end) ? to : end),
    );
  }
  return events;
};

/** Plays one child per cycle, each child resuming where it left off. */
const alternate =
  (queries: Query[]): Query =>
  (from, to) =>
    byCycle(from, to, (c, a, b) => {
      const n = queries.length;
      const shift = new Time(c - Math.floor(c / n));
      return queries[((c % n) + n) % n]!(a.sub(shift), b.sub(shift)).map(e => ({
        ...e,
        begin: e.begin.add(shift),
        end: e.end.add(shift),
      }));
    });

const queryOf = (step: Step): Query => {
  switch (step.kind) {
    case 'rest':
      return () => [];
    case 'word':
      return (from, to) => {
        const events: PatternEvent[] = [];
        for (let c = from.ceil(); new Time(c).lt(to); c += 1) {
          events.push({
            begin: new Time(c),
            end: new Time(c + 1),
            value: step.value,
            from: step.from,
            to: step.to,
          });
        }
        return events;
      };
    case 'sequence':
      return stack(step.layers.map(sequenceQuery));
    case 'alternation':
      return stack(step.layers.map(steps => alternate(steps.map(queryOf))));
    case 'fast':
      return scale(queryOf(step.step), step.by);
    case 'slow':
      return scale(queryOf(step.step), ONE.div(step.by));
  }
};

/** Fits every step into one cycle, each taking an equal share. */
const sequenceQuery = (steps: Step[]): Query =>
  steps.length === 1
    ? queryOf(steps[0]!)
    : scale(alternate(steps.map(queryOf)), new Time(steps.length));

const patternOf = (layers: Step[][]): Pattern => {
  const query = stack(layers.map(sequenceQuery));
  const sorted: Query = (from, to) =>
    query(from, to).sort(
      (a, b) => a.begin.valueOf() - b.begin.valueOf() || a.from - b.from,
    );
  const words = (steps: readonly Step[]): Extract<Step, { kind: 'word' }>[] =>
    steps.flatMap(s =>
      s.kind === 'word'
        ? [s]
        : s.kind === 'rest'
          ? []
          : 'step' in s
            ? words([s.step])
            : s.layers.flatMap(words),
    );
  return {
    layers,
    query: sorted,
    cycle: index => sorted(new Time(index), new Time(index + 1)),
    words: () => layers.flatMap(words),
  };
};
