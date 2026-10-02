// Session Transcripts (chapter 11): replay one through a fresh Session Host,
// match its output lines and its Trace, then replay that Trace as a Trace
// Case in both replays.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseTranscript,
  replayTranscript,
  writeTranscript,
} from '../src/session';
import {
  blessed,
  runTraceCase,
  same,
  type Setup,
  type TraceDivergence,
} from './trace-case';

// The Session Host's Group, as a Trace Case sets it up: the Session Script
// loaded from empty source, granted `console`, whose Operations cost nothing.
const sessionSetup: Setup = {
  scripts: [
    {
      name: 'session',
      source: '(empty)',
      text: '',
      grants: { console: { ops: 'all' } },
    },
  ],
  standard: [
    {
      capability: 'console',
      costs: { write: { fuel: 0 }, read: { fuel: 0 } },
    },
  ],
};

export type TranscriptDivergence = TraceDivergence & {
  file: 'session.transcript' | 'case.trace';
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

const linesOf = (text: string) => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
};

/**
 * Run a Session Transcript, or with `bless` fill in its output lines and
 * write its case.trace from the Session Host's.
 */
export const runTranscriptCase = (
  dir: string,
  { bless = false } = {},
): { divergence?: TranscriptDivergence; lines: number } => {
  const transcriptPath = resolve(dir, 'session.transcript');
  const tracePath = resolve(dir, 'case.trace');
  const recorded = readFileSync(transcriptPath, 'utf8');
  const trace: string[] = [];
  const { host, items } = replayTranscript(parseTranscript(recorded), {
    trace: line => trace.push(line),
  });
  // Every Trace ends with `> vars` (chapter 11, Running a case).
  if (trace.filter(line => line.startsWith('> ')).at(-1) !== '> vars') {
    host.inspect();
  }
  const transcript = writeTranscript(items);
  const caseTrace = linesOf(readFileSync(tracePath, 'utf8'));
  if (bless) {
    writeFileSync(transcriptPath, transcript);
    writeFileSync(tracePath, blessed(caseTrace, trace));
  } else {
    const divergence =
      firstDifference(
        'session.transcript',
        linesOf(recorded),
        linesOf(transcript),
        (e, a) => e === a,
      ) ?? firstDifference('case.trace', caseTrace, trace, same);
    if (divergence) {
      return { lines: 0, divergence };
    }
  }
  // The Trace replays without the Session Host that took it.
  const replayed = runTraceCase(dir, sessionSetup);
  if (replayed.divergence) {
    return {
      lines: replayed.lines,
      divergence: { ...replayed.divergence, file: 'case.trace' },
    };
  }
  return { lines: linesOf(transcript).length };
};
