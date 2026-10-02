// `northtalk replay`: replay a Session Transcript through a fresh Session
// Host, and report the first line it printed differently (chapter 12).
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseTranscript,
  replayTranscript,
  writeTranscript,
} from '@odgn/northtalk/session';

export const replay = (
  file: string,
  { trace: traceFile }: { trace?: string | undefined } = {},
): number => {
  const recorded = readFileSync(file, 'utf8');
  const trace: string[] = [];
  const { host, items } = replayTranscript(parseTranscript(recorded), {
    trace: line => trace.push(line),
  });
  // Every Trace ends with `> vars` (chapter 11, Running a case).
  if (trace.filter(line => line.startsWith('> ')).at(-1) !== '> vars') {
    host.inspect();
  }
  if (traceFile) {
    writeFileSync(traceFile, trace.map(line => `${line}\n`).join(''));
  }
  const expected = recorded.split('\n');
  const actual = writeTranscript(items).split('\n');
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) {
      console.error(
        [
          `${file}:${i + 1}: the replay differs`,
          `  expected: ${expected[i] ?? '(end of the Transcript)'}`,
          `  actual:   ${actual[i] ?? '(end of the Transcript)'}`,
        ].join('\n'),
      );
      return 1;
    }
  }
  console.log(`${file}: replays the same (${actual.length - 1} lines)`);
  return 0;
};
