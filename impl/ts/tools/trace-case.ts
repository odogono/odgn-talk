import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Setup } from '../src/replay';
import type { Group } from '../src/index';
import {
  checkTraceCase,
  replayLines,
  type ReadCaseFile,
  type TraceDivergence,
} from './case-checks';

/** A case directory's files, read from disk. */
export const reader =
  (dir: string): ReadCaseFile =>
  path =>
    readFileSync(resolve(dir, path), 'utf8');
export {
  DeferredCaseError,
  parseRecord,
  same,
  type Setup,
} from '../src/replay';
/**
 * Corpus cases the debugger parity suites skip. Each costs seconds per replay
 * and the parity suites replay it several times. The complete Corpus run still
 * replays them both ways, and smaller cases cover the same Limit Faults.
 */
export const debugParitySkips: ReadonlySet<string> = new Set([
  // Builds a 64 MiB text; the small Persistent State caps in limits/ cover its
  // fault. Remove once its replay is fast (#560).
  'limits/persistent-state-minimum/case.toml',
]);
/** Replay with file-backed sources; debugging hooks remain Trace-silent. */
export const replay = (
  dir: string,
  setup: Setup,
  lines: readonly string[],
  options: {
    configureDebug?: (group: Group) => void;
    restoreBetweenPumps?: boolean;
  } = {},
): string[] => replayLines(reader(dir), setup, lines, options);

export type { TraceDivergence };

/** Run a Trace Case, or with `bless` write its case.trace from the Core's Trace. */
export const runTraceCase = (
  dir: string,
  setup: Setup,
  { bless = false } = {},
): { divergence?: TraceDivergence; lines: number } => {
  const result = checkTraceCase(reader(dir), setup);
  if (bless) {
    writeFileSync(
      resolve(dir, 'case.trace'),
      blessed(result.file, result.actual),
    );
    return { lines: result.actual.length };
  }
  return {
    lines: result.lines,
    ...(result.divergence ? { divergence: result.divergence } : {}),
  };
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
