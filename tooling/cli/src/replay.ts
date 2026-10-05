import { canvasCapabilities } from '@odgn/northtalk-tooling/canvas';
// `northtalk replay`: replay a Session Transcript through a fresh Session
// Host, and report the first line it printed differently (chapter 12).
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseTranscript,
  replayTranscript,
  writeTranscript,
} from '@odgn/northtalk/session';

/** A replay's outcome: its line count, or the first line that differs. */
export type Replayed =
  | { lines: number; ok: true }
  | { actual?: string; expected?: string; line: number; ok: false };

/** Replays a Transcript, and compares what it printed with the recording. */
export const replayFile = (
  file: string,
  trace?: (line: string) => void,
): Replayed => {
  const recorded = readFileSync(file, 'utf8');
  const lines: string[] = [];
  const { host, items } = replayTranscript(parseTranscript(recorded), {
    capabilities: canvasCapabilities,
    trace: line => lines.push(line),
  });
  // Every Trace ends with `> vars` (chapter 11, Running a case).
  if (lines.filter(line => line.startsWith('> ')).at(-1) !== '> vars') {
    host.inspect();
  }
  lines.forEach(line => trace?.(line));
  const expected = recorded.split('\n');
  const actual = writeTranscript(items).split('\n');
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) {
      return {
        ok: false,
        line: i + 1,
        ...(expected[i] === undefined ? {} : { expected: expected[i] }),
        ...(actual[i] === undefined ? {} : { actual: actual[i] }),
      };
    }
  }
  return { ok: true, lines: actual.length - 1 };
};

/** The lines that explain a replay that differs. */
export const differs = (
  file: string,
  result: Extract<Replayed, { ok: false }>,
): string[] => [
  `${file}:${result.line}: the replay differs`,
  `  expected: ${result.expected ?? '(end of the Transcript)'}`,
  `  actual:   ${result.actual ?? '(end of the Transcript)'}`,
];

export const replay = (
  file: string,
  { trace: traceFile }: { trace?: string | undefined } = {},
): number => {
  const trace: string[] = [];
  const result = replayFile(file, line => trace.push(line));
  if (traceFile) {
    writeFileSync(traceFile, trace.map(line => `${line}\n`).join(''));
  }
  if (!result.ok) {
    console.error(differs(file, result).join('\n'));
    return 1;
  }
  console.log(`${file}: replays the same (${result.lines} lines)`);
  return 0;
};
