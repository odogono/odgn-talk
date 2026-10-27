// Record Test (ADR 0134): a reader's keys and clicks in Browse, and the time
// between them, written as a Recorded Test that replays them through the
// Folio Harness and ends in assertions about what the reader could see.
import { sourceForm } from '@northtalk/ts/debug';
import { text } from '@northtalk/ts';
import type { Project } from './model';
import type { DeepReadonly } from './readonly';
import { replayInput, type ReaderView } from './test-runner';

/** Recorded time is rounded to frames of this many ms. */
export const FRAME_MS = 16;
/** The Test Script Recorded Tests are added to. */
export const RECORDED_SCRIPT = 'recorded.test';

/** Input a Recorded Test can't replay, as its comment names it. */
export type Unrecorded = 'typing' | 'a prompt answer';

type Event = { at: number } & (
  | { key: string; kind: 'key' }
  | { kind: 'click'; name: string }
  | { kind: 'unrecorded'; what: Unrecorded }
);

/** The input of one recording, each stamped with ms since it started. */
export class Recorder {
  readonly events: Event[] = [];

  constructor(private readonly now: () => number) {
    this.#start = now();
  }

  #start: number;

  key(key: string): void {
    this.events.push({ kind: 'key', key, at: this.#elapsed() });
  }

  click(name: string): void {
    this.events.push({ kind: 'click', name, at: this.#elapsed() });
  }

  unrecorded(what: Unrecorded): void {
    const last = this.events.at(-1);
    // A run of typing is one comment, not one per key.
    if (last?.kind !== 'unrecorded' || last.what !== what) {
      this.events.push({ kind: 'unrecorded', what, at: this.#elapsed() });
    }
  }

  /** How long the recording has run, in ms. */
  get elapsed(): number {
    return this.#elapsed();
  }

  /** Paused time isn't recorded, as Play's Clock stops too. */
  pause(): void {
    this.#pausedAt ??= this.now();
  }

  resume(): void {
    if (this.#pausedAt !== undefined) {
      this.#start += this.now() - this.#pausedAt;
      this.#pausedAt = undefined;
    }
  }

  #pausedAt: number | undefined;

  #elapsed(): number {
    return (this.#pausedAt ?? this.now()) - this.#start;
  }
}

const quoted = (value: string) => sourceForm(text(value));

/**
 * The Harness calls that replay the events, with time rounded to frames.
 * Each input lands after the frames that passed before it.
 */
export const inputLines = (
  events: readonly Event[],
  end: number,
  frames: boolean,
): string[] => {
  const lines: string[] = [];
  let ticks = 0;
  const passTo = (at: number) => {
    const due = Math.floor(at / FRAME_MS) - ticks;
    if (due <= 0) {
      return;
    }
    ticks += due;
    const step = frames
      ? `ask harness to frame ${FRAME_MS} ms and wait`
      : `ask harness to advance ${due * FRAME_MS} ms and wait`;
    if (!frames || due === 1) {
      lines.push(step);
    } else {
      lines.push(`repeat ${due} times`, `  ${step}`, 'end repeat');
    }
  };
  for (const event of events) {
    passTo(event.at);
    if (event.kind === 'key') {
      lines.push(`ask harness to key ${quoted(event.key)} and wait`);
    } else if (event.kind === 'click') {
      lines.push(`ask harness to click ${quoted(event.name)} and wait`);
    } else {
      lines.push(`-- not recorded: ${event.what}`);
    }
  }
  passTo(end);
  return lines;
};

/** Assertions that what a reader sees matches `view`. */
export const assertionLines = (view: ReaderView): string[] => [
  'ask harness to page',
  `assertEqual(it, ${quoted(view.page)})`,
  ...view.texts.flatMap(([name, value]) => [
    `ask harness to property "text", ${quoted(name)}`,
    `assertEqual(it, ${quoted(value)})`,
  ]),
  ...view.visibility.flatMap(([name, visible]) => [
    `ask harness to property "visible", ${quoted(name)}`,
    `assertEqual(it, ${visible})`,
  ]),
];

/** A replayed recording, ready to add as a Recorded Test. */
export type Recording = {
  /** The Recorded Test's body: its input, then its assertions. */
  body: string[];
  /** True when the replay ends differently from what the reader saw. */
  drifted: boolean;
  /** Why the replay isn't a clean Run, if it isn't. */
  problems: string[];
  /** Input the Recorded Test doesn't replay. */
  unrecorded: Unrecorded[];
};

/**
 * Replays a recording headless, so its assertions are what that replay
 * shows, and notes whether it differs from what the reader saw.
 */
export const replayRecording = async (
  project: DeepReadonly<Project>,
  recorder: Recorder,
  seen: ReaderView,
  frames: boolean,
): Promise<Recording> => {
  const input = inputLines(recorder.events, recorder.elapsed, frames);
  const { problems, view } = await replayInput(project, input);
  return {
    body: [...input, ...assertionLines(view)],
    drifted: JSON.stringify(view) !== JSON.stringify(seen),
    problems,
    unrecorded: [
      ...new Set(
        recorder.events.flatMap(e => (e.kind === 'unrecorded' ? [e.what] : [])),
      ),
    ],
  };
};

/**
 * `recorded.test`'s source with the next `testRecording<n>` added, its name
 * and the line of its `on`.
 */
export const addRecordedTest = (
  source: string | undefined,
  body: readonly string[],
): { line: number; name: string; source: string } => {
  const base = source ?? 'use assertEqual from test\n';
  let n = 1;
  while (new RegExp(String.raw`^on testRecording${n}\b`, 'mu').test(base)) {
    n++;
  }
  const name = `testRecording${n}`;
  const prefix = base.endsWith('\n') ? `${base}\n` : `${base}\n\n`;
  return {
    name,
    line: prefix.split('\n').length,
    source: [
      prefix + `on ${name}`,
      ...body.map(line => `  ${line}`),
      `end ${name}`,
      '',
    ].join('\n'),
  };
};
