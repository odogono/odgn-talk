import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { replayTrace, same, type Setup } from '../src/replay';
import type { Group } from '../src/index';
export {
  DeferredCaseError,
  parseRecord,
  same,
  type Setup,
} from '../src/replay';
/** Replay with file-backed sources; debugging hooks remain Trace-silent. */
export const replay = (
  dir: string,
  setup: Setup,
  lines: readonly string[],
  options: {
    configureDebug?: (group: Group) => void;
    restoreBetweenPumps?: boolean;
  } = {},
): string[] => {
  const driver = replayTrace(
    file => readFileSync(resolve(dir, file), 'utf8'),
    setup,
    lines,
    options,
  );
  let next = driver.next();
  while (!next.done) {
    next = driver.next();
  }
  return next.value;
};

export type TraceDivergence = {
  actual: string;
  context: string[];
  expected: string;
  line: number;
};

/** Run a Trace Case, or with `bless` write its case.trace from the Core's Trace. */
export const runTraceCase = (
  dir: string,
  setup: Setup,
  { bless = false } = {},
): { divergence?: TraceDivergence; lines: number } => {
  const path = resolve(dir, 'case.trace');
  const file = readFileSync(path, 'utf8').split('\n');
  if (file.at(-1) === '') {
    file.pop();
  }
  const actual = replay(dir, setup, file);
  const roundTripped = replay(dir, setup, file, { restoreBetweenPumps: true });
  if (actual.join('\n') !== roundTripped.join('\n')) {
    const at = actual.findIndex((line, i) => line !== roundTripped[i]);
    throw new Error(
      `Save/restore replay differs at output ${at + 1}:\nexpected ${actual[at]}\nactual ${roundTripped[at]}`,
    );
  }
  if (bless) {
    writeFileSync(path, blessed(file, actual));
    return { lines: actual.length };
  }
  const expected = file
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => text !== '' && !text.startsWith('#'));
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e || a === undefined || !same(e.text, a)) {
      return {
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
  return { lines: actual.length };
};

// The Core's Trace, with each comment and blank line of the case kept before
// the Host Input line it preceded, and the case's trailing ones kept last.
export const blessed = (
  file: readonly string[],
  actual: readonly string[],
): string => {
  const before: string[][] = [];
  let pending: string[] = [];
  for (const line of file) {
    if (line === '' || line.startsWith('#')) {
      pending.push(line);
    } else if (line.startsWith('> ')) {
      before.push(pending);
      pending = [];
    }
  }
  const out: string[] = [];
  let input = 0;
  for (const line of actual) {
    if (line.startsWith('> ')) {
      out.push(...(before[input++] ?? []));
    }
    out.push(line);
  }
  out.push(...pending);
  return `${out.join('\n')}\n`;
};

/** Whether a case's Trace says it was written by hand, not by bless. */
export const unblessed = (dir: string): boolean =>
  readFileSync(resolve(dir, 'case.trace'), 'utf8').includes('# Unblessed:');
