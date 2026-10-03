// The checks of a Trace Case and a Session Transcript case, over a reader of
// the case's files, so `corpus:run` under Bun and the Playground's browser
// corpus page run exactly the same checks. No file or process access here.
import { replayTrace, same, sessionSetup, type Setup } from '../src/replay';
import type { Group } from '../src/index';
import {
  parseTranscript,
  replayTranscript,
  writeTranscript,
  type SessionHost,
} from '../src/session';

/** A case file's text, by its path relative to the case directory. */
export type ReadCaseFile = (path: string) => string;

export type TraceDivergence = {
  actual: string;
  context: string[];
  expected: string;
  line: number;
};
export type TranscriptDivergence = TraceDivergence & {
  file: 'session.transcript' | 'case.trace';
};

export const linesOf = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
};

/** Replay a Trace's Host Inputs; debugging hooks remain Trace-silent. */
export const replayLines = (
  read: ReadCaseFile,
  setup: Setup,
  lines: readonly string[],
  options: {
    configureDebug?: (group: Group) => void;
    restoreBetweenPumps?: boolean;
  } = {},
): string[] => {
  const driver = replayTrace(read, setup, lines, options);
  let next = driver.next();
  while (!next.done) {
    next = driver.next();
  }
  return next.value;
};

/**
 * Replay a Trace Case twice, the second time restoring between Pumps, and
 * compare the Trace with its case.trace.
 */
export const checkTraceCase = (
  read: ReadCaseFile,
  setup: Setup,
): {
  actual: string[];
  divergence?: TraceDivergence;
  file: string[];
  lines: number;
} => {
  const file = read('case.trace').split('\n');
  if (file.at(-1) === '') {
    file.pop();
  }
  const actual = replayLines(read, setup, file);
  const roundTripped = replayLines(read, setup, file, {
    restoreBetweenPumps: true,
  });
  if (actual.join('\n') !== roundTripped.join('\n')) {
    const at = actual.findIndex((line, i) => line !== roundTripped[i]);
    throw new Error(
      `Save/restore replay differs at output ${at + 1}:\nexpected ${actual[at]}\nactual ${roundTripped[at]}`,
    );
  }
  const expected = file
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => text !== '' && !text.startsWith('#'));
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e || a === undefined || !same(e.text, a)) {
      return {
        actual,
        file,
        lines: i,
        divergence: {
          line: e?.line ?? file.length + 1,
          expected: e?.text ?? '(end of the Trace)',
          actual: a ?? '(end of the Trace)',
          context: actual.slice(Math.max(0, i - 3), i),
        },
      };
    }
  }
  return { actual, file, lines: actual.length };
};

const firstDifference = (
  file: TranscriptDivergence['file'],
  expected: readonly string[],
  actual: readonly string[],
  match: (e: string, a: string) => boolean,
): TranscriptDivergence | undefined => {
  const lines = expected
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(
      ({ text }) =>
        file === 'session.transcript' || !(text === '' || text.startsWith('#')),
    );
  for (let i = 0; i < Math.max(lines.length, actual.length); i++) {
    const e = lines[i];
    const a = actual[i];
    if (!e || a === undefined || !match(e.text, a)) {
      return {
        file,
        line: e?.line ?? expected.length + 1,
        expected: e?.text ?? `(end of ${file})`,
        actual: a ?? `(end of ${file})`,
        context: actual.slice(Math.max(0, i - 3), i),
      };
    }
  }
  return undefined;
};

/**
 * Replay a Session Transcript through a fresh Session Host, and compare its
 * output lines and its Trace with the case's.
 */
export const replayTranscriptCase = (
  read: ReadCaseFile,
): {
  divergence?: TranscriptDivergence;
  host: SessionHost;
  trace: string[];
  transcript: string;
} => {
  const recorded = read('session.transcript');
  const trace: string[] = [];
  const { host, items } = replayTranscript(parseTranscript(recorded), {
    trace: line => trace.push(line),
  });
  // Every Trace ends with `> vars` (chapter 11, Running a case).
  if (trace.filter(line => line.startsWith('> ')).at(-1) !== '> vars') {
    host.inspect();
  }
  const transcript = writeTranscript(items);
  const divergence =
    firstDifference(
      'session.transcript',
      linesOf(recorded),
      linesOf(transcript),
      (e, a) => e === a,
    ) ??
    firstDifference('case.trace', linesOf(read('case.trace')), trace, same);
  return { host, trace, transcript, ...(divergence ? { divergence } : {}) };
};

/** A Session Transcript case: its replay, then its Trace as a Trace Case. */
export const checkTranscriptCase = (
  read: ReadCaseFile,
): { divergence?: TranscriptDivergence; lines: number } => {
  const replayed = replayTranscriptCase(read);
  if (replayed.divergence) {
    return { lines: 0, divergence: replayed.divergence };
  }
  // The Trace replays without the Session Host that took it.
  const traced = checkTraceCase(read, sessionSetup(replayed.host));
  if (traced.divergence) {
    return {
      lines: traced.lines,
      divergence: { ...traced.divergence, file: 'case.trace' },
    };
  }
  return { lines: linesOf(replayed.transcript).length };
};
