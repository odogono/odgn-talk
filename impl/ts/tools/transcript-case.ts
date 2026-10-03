// Session Transcripts (chapter 11): replay one through a fresh Session Host,
// match its output lines and its Trace, then replay that Trace as a Trace
// Case in both replays.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionSetup } from '../src/replay';
import {
  checkTranscriptCase,
  linesOf,
  replayTranscriptCase,
  type TranscriptDivergence,
} from './case-checks';
import { blessed, reader, runTraceCase } from './trace-case';

export type { TranscriptDivergence };

/**
 * Run a Session Transcript, or with `bless` fill in its output lines and
 * write its case.trace from the Session Host's.
 */
export const runTranscriptCase = (
  dir: string,
  { bless = false } = {},
): { divergence?: TranscriptDivergence; lines: number } => {
  const read = reader(dir);
  if (!bless) {
    return checkTranscriptCase(read);
  }
  const { host, trace, transcript } = replayTranscriptCase(read);
  writeFileSync(resolve(dir, 'session.transcript'), transcript);
  writeFileSync(
    resolve(dir, 'case.trace'),
    blessed(linesOf(read('case.trace')), trace),
  );
  // The Trace replays without the Session Host that took it.
  const replayed = runTraceCase(dir, sessionSetup(host));
  if (replayed.divergence) {
    return {
      lines: replayed.lines,
      divergence: { ...replayed.divergence, file: 'case.trace' },
    };
  }
  return { lines: linesOf(transcript).length };
};
