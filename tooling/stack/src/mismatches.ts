// Why no Handler Clause took a message, read from a Trace `run` record's
// `mismatches` field (ADR 0172) and said in words for Folio and
// `northtalk test` (#2059).
import { fromValue, readDisplay } from '@northtalk/ts';

type Explained = {
  code?: string;
  expected?: string;
  got?: string;
  kind?: string;
  path?: (number | string)[];
};
type Entry = {
  argument?: number;
  clause: number;
  mismatches?: Explained[];
  reason: 'arity' | 'guard' | 'pattern' | 'shape';
};

type Raw = Omit<Entry, 'argument' | 'clause' | 'mismatches'> & {
  argument?: unknown;
  clause: unknown;
  mismatches?: (Omit<Explained, 'path'> & { path?: unknown[] })[];
};

// The text of a `run` record's `mismatches=[…]`: brackets balanced outside
// quoted text, since a value inside may hold the same characters.
const field = (line: string): string | null => {
  const start = line.indexOf(' mismatches=[');
  if (!line.startsWith('run ') || start < 0) {
    return null;
  }
  const from = start + ' mismatches='.length;
  let depth = 0;
  let quoted = false;
  for (let at = from; at < line.length; at++) {
    const c = line[at]!;
    if (quoted) {
      if (c === '\\') {
        at++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if ('[{<'.includes(c)) {
      depth++;
    } else if (']}>'.includes(c) && --depth === 0) {
      return line.slice(from, at + 1);
    }
  }
  return null;
};

/** A Trace `run` line's `mismatches`, or null when it has none. */
export const mismatchesOf = (line: string): Entry[] | null => {
  const text = field(line);
  if (!text) {
    return null;
  }
  try {
    // Numbers read back as Decimals; positions and clause numbers are small.
    const plain = fromValue(readDisplay(text)) as unknown as Raw[];
    return plain.map((e): Entry => ({
      clause: Number(e.clause),
      reason: e.reason,
      ...(e.argument === undefined ? {} : { argument: Number(e.argument) }),
      ...(e.mismatches
        ? {
            mismatches: e.mismatches.map(({ path, ...m }): Explained => ({
              ...m,
              ...(path
                ? {
                    path: path.map(p =>
                      typeof p === 'string' ? p : Number(p),
                    ),
                  }
                : {}),
            })),
          }
        : {}),
    }));
  } catch {
    return null;
  }
};

const at = (path: (number | string)[] | undefined) =>
  path?.length
    ? ` at ${path.map(p => (typeof p === 'number' ? `item ${p}` : p)).join(' → ')}`
    : '';

const shapeWords = (argument: number, m: Explained) =>
  m.code === 'not encodable'
    ? `argument ${argument}${at(m.path)} is a ${m.kind}, which a Shape can't hold`
    : `argument ${argument}${at(m.path)} is ${m.got}, not ${m.expected}`;

/** One line per skipped clause: why dispatch passed it by. */
export const describeMismatches = (entries: Entry[]): string[] =>
  entries.map(e => {
    const lead = `clause ${e.clause}: `;
    switch (e.reason) {
      case 'arity':
        return `${lead}takes a different number of arguments`;
      case 'pattern':
        return `${lead}a parameter pattern didn't match`;
      case 'guard':
        return `${lead}its Guard wasn't true`;
      case 'shape': {
        const words = (e.mismatches ?? []).map(m =>
          shapeWords(e.argument ?? 1, m),
        );
        return `${lead}${words.length ? words.join('; ') : `argument ${e.argument} doesn't fit its Shape`}`;
      }
    }
  });
