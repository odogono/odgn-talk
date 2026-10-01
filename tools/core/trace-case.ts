// Replaying a Trace Case (chapter 11): its Host Input lines drive a Group
// through the embedding interface, and the Trace the Group writes must equal
// the case's, ignoring comments and blank lines. Bless writes the Core's
// Trace back, keeping each comment and blank line before the Host Input line
// it preceded.
import corpus from '../../spec/data/corpus.toml';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HostError,
  LoadError,
  newGroup,
  NotImplementedError,
  parseInstant,
  readDisplay,
  type Limits,
  type Value,
} from '../../src/index';

type RecordSpec = {
  ids?: string[];
  input: boolean;
  key?: { filled?: boolean; key: string }[];
  name: string;
};
const records = new Map<string, RecordSpec>(
  (corpus.record as RecordSpec[]).map(r => [r.name, r]),
);

/** A case uses a Host Input this Core doesn't implement yet. */
export class DeferredCaseError extends Error {
  override name = 'DeferredCaseError';
}

type Parsed = {
  fields: Map<string, string>;
  ids: string[];
  input: boolean;
  name: string;
};

/** A Trace line's record: its name, ids and key=value fields, by corpus.toml's keys. */
export const parseRecord = (line: string): Parsed => {
  const input = line.startsWith('> ');
  const body = input ? line.slice(2) : line;
  const space = body.indexOf(' ');
  const name = space < 0 ? body : body.slice(0, space);
  const rest = space < 0 ? '' : body.slice(space + 1);
  const keys = (records.get(name)?.key ?? []).map(k => k.key);
  // Each field starts at a known key followed by `=`, in corpus.toml's order.
  const starts: [number, string][] = [];
  let from = 0;
  for (const key of keys) {
    const at = rest.indexOf(`${key}=`, from);
    if (at >= 0 && (at === 0 || rest[at - 1] === ' ')) {
      starts.push([at, key]);
      from = at + key.length + 1;
    }
  }
  const head = starts.length
    ? rest.slice(0, starts[0]![0]).trim()
    : rest.trim();
  const ids = head ? head.split(' ') : [];
  const fields = new Map<string, string>();
  starts.forEach(([at, key], i) => {
    const end = i + 1 < starts.length ? starts[i + 1]![0] - 1 : rest.length;
    fields.set(key, rest.slice(at + key.length + 1, end));
  });
  return { name, ids, fields, input };
};

/**
 * Whether the Core's line matches the case's. A Host Input line may leave out
 * its `filled` keys and the ids the Core assigns.
 */
const same = (expected: string, actual: string): boolean => {
  if (expected === actual) {
    return true;
  }
  if (!expected.startsWith('> ') || !actual.startsWith('> ')) {
    return false;
  }
  const e = parseRecord(expected);
  const a = parseRecord(actual);
  if (
    e.name !== a.name ||
    (e.ids.length && e.ids.join(' ') !== a.ids.join(' '))
  ) {
    return false;
  }
  const filled = new Set(
    (records.get(a.name)?.key ?? []).filter(k => k.filled).map(k => k.key),
  );
  for (const [key, value] of a.fields) {
    if (
      e.fields.get(key) !== value &&
      !(filled.has(key) && !e.fields.has(key))
    ) {
      return false;
    }
  }
  return [...e.fields.keys()].every(key => a.fields.has(key));
};

type Setup = {
  scripts?: {
    grants?: unknown;
    limits?: Partial<Limits>;
    name: string;
    objects?: Record<string, unknown>;
    owner?: unknown;
    source: string;
  }[];
};

// A value in the display form, or a deferral for a kind this Core can't read yet.
const read = (text: string): Value => {
  try {
    return readDisplay(text);
  } catch (error) {
    throw new DeferredCaseError(
      `a value it can't read yet, ${text}: ${(error as Error).message}`,
    );
  }
};
const valuesOf = (list: Value): Value[] =>
  Array.from({ length: list.length }, (_, i) => list.index(i + 1));

/** Replay a case's Host Inputs, giving the Trace the Core wrote. */
export const replay = (
  dir: string,
  setup: Setup,
  lines: readonly string[],
): string[] => {
  const trace: string[] = [];
  const group = newGroup({ name: 'case', trace: line => trace.push(line) });
  for (const line of lines) {
    if (!line.startsWith('> ')) {
      continue;
    }
    const r = parseRecord(line);
    try {
      switch (r.name) {
        case 'load': {
          const script = setup.scripts?.find(s => s.name === r.ids[0]);
          if (!script) {
            throw new Error(`case.toml has no Script ${r.ids[0]}`);
          }
          if (script.grants || script.owner) {
            throw new DeferredCaseError('Grants and owners');
          }
          group.load({
            name: script.name,
            source: readFileSync(resolve(dir, script.source), 'utf8'),
            limits: script.limits,
            objects: Object.keys(script.objects ?? {}),
          });
          break;
        }
        case 'deliver':
        case 'request': {
          const to = group.script(r.fields.get('to') ?? '');
          if (!to) {
            throw new DeferredCaseError('a Delivery to a Host Object');
          }
          const args = r.fields.has('args')
            ? valuesOf(read(r.fields.get('args')!))
            : [];
          const limitsValue = r.fields.has('limits')
            ? read(r.fields.get('limits')!)
            : null;
          const limits = limitsValue
            ? Object.fromEntries(
                limitsValue
                  .entries()
                  .map(([k, v]) => [k, Number(v.asDecimal()!.toString())]),
              )
            : undefined;
          const message = { name: r.fields.get('message')!, args, limits };
          if (r.name === 'deliver') {
            to.deliver(message);
          } else {
            to.request(message);
          }
          break;
        }
        case 'pump':
          group.pump(parseInstant(r.fields.get('clock')!), {
            fuelSlice: r.fields.has('fuel-slice')
              ? Number(r.fields.get('fuel-slice'))
              : 0,
            fuelCap: r.fields.has('fuel-cap')
              ? Number(r.fields.get('fuel-cap'))
              : 0,
          });
          break;
        case 'vars':
          group.inspect();
          break;
        default:
          throw new DeferredCaseError(`the Host Input ${r.name}`);
      }
    } catch (error) {
      if (
        error instanceof LoadError ||
        (error instanceof Error && error.name === 'MailboxFull') ||
        error instanceof HostError
      ) {
        continue;
      }
      if (error instanceof NotImplementedError) {
        throw new DeferredCaseError(error.message);
      }
      throw error;
    }
  }
  return trace;
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
const blessed = (
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
