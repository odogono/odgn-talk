// Reads SQL text as SQLite's tokenizer does, as far as the Host obligations
// need: where each top-level statement may end, and the placeholders the
// first statement holds (chapter 9, One statement and Bound parameters).

/** A placeholder: `?`, `?NNN`, or a name with its prefix, such as `:id`. */
export type Placeholder =
  | { readonly index?: number; readonly kind: 'positional' }
  | { readonly kind: 'named'; readonly name: string; readonly prefix: string };

export type Scanned = {
  /** Each top-level `;`, by offset, and the text's end. */
  readonly ends: readonly number[];
  /** The first word, upper-cased, or '' when the text has none. */
  readonly keyword: string;
  /** By the offset of the end it comes before. */
  readonly placeholders: readonly (readonly [number, Placeholder])[];
  /** Whether anything but white space and comments follows each end. */
  readonly trailing: readonly boolean[];
};

const isWordChar = (c: string) => /[\w$]/.test(c) || c.charCodeAt(0) > 0x7f;

/** Scans `sql` once; strings, quoted names and comments hide what they hold. */
export const scan = (sql: string): Scanned => {
  const ends: number[] = [];
  const placeholders: [number, Placeholder][] = [];
  // Where something other than white space or a comment was last seen.
  const content: number[] = [];
  let keyword = '';
  let i = 0;
  const closing = (quote: string) => {
    // A doubled quote stands for itself, except in brackets.
    for (i++; i < sql.length; i++) {
      if (sql[i] === quote) {
        if (quote !== ']' && sql[i + 1] === quote) {
          i++;
        } else {
          i++;
          return;
        }
      }
    }
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === ';') {
      ends.push(i);
      i++;
    } else {
      content.push(i);
      if (c === "'" || c === '"' || c === '`') {
        closing(c);
      } else if (c === '[') {
        closing(']');
      } else if (c === '?') {
        let j = i + 1;
        while (j < sql.length && /\d/.test(sql[j]!)) {
          j++;
        }
        placeholders.push([
          ends.length,
          j > i + 1
            ? { kind: 'positional', index: Number(sql.slice(i + 1, j)) }
            : { kind: 'positional' },
        ]);
        i = j;
      } else if (
        (c === ':' || c === '@' || c === '$') &&
        isWordChar(sql[i + 1] ?? ' ')
      ) {
        let j = i + 1;
        while (j < sql.length && isWordChar(sql[j]!)) {
          j++;
        }
        placeholders.push([
          ends.length,
          { kind: 'named', prefix: c, name: sql.slice(i + 1, j) },
        ]);
        i = j;
      } else if (isWordChar(c)) {
        let j = i + 1;
        while (j < sql.length && isWordChar(sql[j]!)) {
          j++;
        }
        if (!keyword && ends.length === 0) {
          keyword = sql.slice(i, j).toUpperCase();
        }
        i = j;
      } else {
        i++;
      }
    }
  }
  ends.push(sql.length);
  const last = content.at(-1) ?? -1;
  return {
    ends,
    trailing: ends.map(end => last > end),
    keyword,
    placeholders,
  };
};
