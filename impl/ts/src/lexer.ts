// Spec chapter 1: lossless modal tokenization. Offsets use UTF-16; columns use scalars.
import { runTask, type Task } from './tasks';
import { grammar } from './generated/syntax';
import { assertScalarText } from './unicode';
import type { SyntaxErrorCode, Trivia } from './syntax';
import { parseUnit, unitEntry, UnitError } from './units';

export type Mode =
  | 'operand' // `<` opens a Text Pattern, `<<` opens a Binary Pattern
  | 'operator' // `<` is less-than, `<<` is lexed only to be refused, `>>` closes a Binary Pattern
  | 'pattern' // inside `<…>`: `<` nests, and `>` always closes, one character at a time
  | 'unit' // after a numeric literal: a Unit if one starts here, else as "operator"
  | 'type'; // after `as`: a Compound Unit if one starts here, else as "operand"

export type TokType =
  | 'num'
  | 'str'
  | 'template'
  | 'word'
  | 'op'
  | 'unit'
  | 'patopen'
  | 'patclose'
  | 'binopen'
  | 'nl'
  | 'eof'
  | 'error';

export type Token = {
  code?: SyntaxErrorCode; // for "error": the syntax error code
  col: number;
  end: number;
  incomplete?: boolean;
  kind: 'token';
  leadingTrivia: readonly Trivia[];
  line: number;
  mode: Mode;
  parts?: TextPart[];
  pos: number;
  raw: string;
  spaceBefore: boolean;
  t: TokType;
  v: string;
};

export type TextPart = {
  end: number;
  hole?: { at: number; end: number; start: number };
  start: number;
  value: string;
};

export const RESERVED = new Set<string>(grammar.reserved);

// A Compound Unit's shape: factors joined by `*`, one `/`, exponents after `^`.
// The lexer takes the longest run of this shape, then checks it.
const UNIT_SHAPE =
  /^(?:1\/)?[A-Za-z]+(?:\^[+-]?\d*)?(?:[*/][A-Za-z]+(?:\^[+-]?\d*)?)*(?!\w)/;
const NAME = /^[A-Z_a-z]\w*/;
const NUMBER = /^(?:0x[\dA-Fa-f]+|\d+(?:\.\d+)?)/;
const OPS = [
  '...',
  '..',
  '&',
  '=',
  '+',
  '-',
  '*',
  '/',
  '^',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
];

// Why a Unit-shaped run isn't a valid Unit, or null if it is one.
// A Unit as chapter 1 writes it, or why it's `bad unit`.
const unitProblem = (text: string): string | null => {
  try {
    parseUnit(text);
    return null;
  } catch (error) {
    if (error instanceof UnitError) {
      return error.message;
    }
    throw error;
  }
};

export class Lexer {
  private readonly fences = new Map<number, Token>();
  private readonly lineStarts: number[] = [0];
  private readonly surrogateOffsets: number[] = [];

  constructor(readonly src: string) {
    assertScalarText(src);
    for (let i = 0; i < src.length; i++) {
      const code = src.charCodeAt(i);
      if (code >= 0xdc_00 && code <= 0xdf_ff) {
        this.surrogateOffsets.push(i);
      }
      if (src[i] === '\n' || (src[i] === '\r' && src[i + 1] !== '\n')) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  // Lines and columns are 1-based, and a column counts Unicode scalar values.
  where(pos: number): { col: number; line: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= pos) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const start = this.lineStarts[lo]!;
    const col =
      pos -
      start +
      1 -
      (this.surrogatesBefore(pos) - this.surrogatesBefore(start));
    return { line: lo + 1, col };
  }

  private surrogatesBefore(pos: number): number {
    let lo = 0;
    let hi = this.surrogateOffsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.surrogateOffsets[mid]! < pos) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  tok(
    t: TokType,
    v: string,
    pos: number,
    end: number,
    spaceBefore: boolean,
    mode: Mode,
    code?: SyntaxErrorCode,
  ): Token {
    return {
      kind: 'token',
      raw: this.src.slice(pos, end),
      leadingTrivia: [],
      t,
      v,
      code,
      pos,
      end,
      ...this.where(pos),
      spaceBefore,
      mode,
    };
  }

  // Skips spaces, tabs and comments. A line break is a token: whether it ends
  // a statement depends on bracket depth, which the parser knows.
  private trivia(start: number): { pos: number; trivia: Trivia[] } {
    const s = this.src;
    let pos = start;
    const trivia: Trivia[] = [];
    const add = (kind: Trivia['kind'], from: number) => {
      trivia.push({
        kind,
        pos: from,
        end: pos,
        raw: s.slice(from, pos),
        ...this.where(from),
      });
    };
    if (pos === 0 && s.charCodeAt(0) === 0xfe_ff) {
      pos++;
      add('bom', 0);
    }
    for (;;) {
      const from = pos;
      if (s[pos] === ' ' || s[pos] === '\t') {
        do {
          pos++;
        } while (s[pos] === ' ' || s[pos] === '\t');
        add('space', from);
      } else if (s[pos] === '-' && s[pos + 1] === '-') {
        while (pos < s.length && s[pos] !== '\n' && s[pos] !== '\r') {
          pos++;
        }
        add('comment', from);
      } else {
        return { pos, trivia };
      }
    }
  }

  // Fences retain original spans; only values undergo margin/escape processing.
  private *fenced(open: number, space: boolean, mode: Mode): Task<Token> {
    const cached = this.fences.get(open);
    if (cached) {
      return { ...cached, spaceBefore: space, mode };
    }
    const token = (yield this.scanFenced(open, space, mode)) as Token;
    this.fences.set(open, token);
    return token;
  }

  private *scanFenced(open: number, space: boolean, mode: Mode): Task<Token> {
    const s = this.src;
    const raw = s[open] === '"';
    let width = 1;
    if (raw) {
      while (s[open + width] === '"') {
        width++;
      }
    }
    const begin = open + width;
    const block = s[begin] === '\r' || s[begin] === '\n';
    const parts: TextPart[] = [];
    let start = begin;
    let i = begin;
    const error = (code: SyntaxErrorCode, at: number, incomplete = false) => ({
      ...this.tok(
        'error',
        code,
        at,
        Math.min(s.length, at + 1),
        space,
        mode,
        code,
      ),
      incomplete,
      parts: incomplete ? [] : parts.filter(p => p.hole && p.hole.end < at),
    });
    while (i < s.length) {
      if ((!raw && s[i] === '`') || (raw && s[i] === '"')) {
        let count = 1;
        if (raw) {
          while (s[i + count] === '"') {
            count++;
          }
        }
        if (raw && count > width) {
          return error('invalid text delimiter', i);
        }
        if (count === width) {
          break;
        }
        i += count;
        continue;
      }
      if (!raw && s[i] === '\\') {
        i++;
        if (s[i] === '\r' && s[i + 1] === '\n') {
          i++;
        }
        i++;
        continue;
      }
      if (!raw && s.startsWith('${', i)) {
        const at = i;
        let cursor = i + 2;
        let depth = 0;
        for (;;) {
          const next = this.trivia(cursor).pos;
          const t =
            s[next] === '`' || s.startsWith('"""', next)
              ? ((yield this.fenced(next, true, 'operand')) as Token)
              : this.lex(cursor, 'operand');
          if (t.t === 'error') {
            return {
              ...t,
              parts: t.incomplete
                ? []
                : [...parts.filter(p => p.hole), ...(t.parts ?? [])],
            };
          }
          if (t.t === 'eof') {
            return error('unterminated interpolation', at, true);
          }
          if (t.t === 'op' && t.v === '}' && depth === 0) {
            parts.push({
              start,
              end: at,
              value: '',
              hole: { at, start: at + 2, end: t.pos },
            });
            i = t.end;
            start = i;
            break;
          }
          if (t.t === 'op' && t.v === '{') {
            depth++;
          }
          if (t.t === 'op' && t.v === '}') {
            depth--;
          }
          cursor = t.end;
        }
        continue;
      }
      i++;
    }
    if (i >= s.length) {
      return error('unterminated text', open, true);
    }
    parts.push({ start, end: i, value: '' });
    let margin = '';
    let closeLine = i;
    if (block) {
      while (
        closeLine > 0 &&
        s[closeLine - 1] !== '\n' &&
        s[closeLine - 1] !== '\r'
      ) {
        closeLine--;
      }
      margin = s.slice(closeLine, i);
      const mismatch = margin.search(/[^\t ]/);
      if (mismatch >= 0) {
        return error('invalid text indentation', closeLine + mismatch);
      }
    }
    for (const part of parts) {
      let from = part.start;
      let to = part.end;
      if (block && from === begin) {
        from += s[from] === '\r' && s[from + 1] === '\n' ? 2 : 1;
      }
      if (block && to === i) {
        to = closeLine;
        if (to > from && s[to - 1] === '\n') {
          to--;
        }
        if (to > from && s[to - 1] === '\r') {
          to--;
        }
      }
      const chars: string[] = [];
      const positions: number[] = [];
      for (let j = from; j < to;) {
        if (block && (j === 0 || s[j - 1] === '\n' || s[j - 1] === '\r')) {
          let k = 0;
          while (k < margin.length && j + k < to && s[j + k] === margin[k]) {
            k++;
          }
          if (k !== margin.length) {
            const c = s[j + k];
            const blank =
              c === '\n' || c === '\r' || (j + k === to && !part.hole);
            if (!blank) {
              return error('invalid text indentation', j + k);
            }
          }
          j += k;
          if (j >= to) {
            break;
          }
        }
        positions.push(j);
        if (s[j] === '\r') {
          chars.push('\n');
          j += s[j + 1] === '\n' ? 2 : 1;
        } else {
          chars.push(s[j++]!);
        }
      }
      const text = chars.join('');
      if (raw) {
        part.value = text;
        continue;
      }
      let value = '';
      const origins: number[] = [];
      // eslint-disable-next-line unicorn/consistent-function-scoping -- Captures this piece's value and source origins.
      const append = (v: string, at: number) => {
        value += v;
        for (let n = 0; n < v.length; n++) {
          origins.push(at);
        }
      };
      for (let j = 0; j < text.length; j++) {
        const at = positions[j]!;
        if (text[j] !== '\\') {
          append(text[j]!, at);
          continue;
        }
        const c = text[++j];
        if (c === undefined) {
          return error('invalid text escape', at);
        }
        if (c === '\n' || c === '\u2028' || c === '\u2029') {
          continue;
        }
        if (c === '0') {
          if (/\d/.test(text[j + 1] ?? '')) {
            return error('invalid text escape', at);
          }
          append('\0', at);
          continue;
        }
        if (/[1-9]/.test(c)) {
          return error('invalid text escape', at);
        }
        const simple: Record<string, string> = {
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
          v: '\v',
        };
        if (simple[c] !== undefined) {
          append(simple[c]!, at);
          continue;
        }
        if (c === 'x' || c === 'u') {
          let digits: string;
          if (c === 'u' && text[j + 1] === '{') {
            const end = text.indexOf('}', j + 2);
            if (end < 0) {
              return error('invalid text escape', at);
            }
            digits = text.slice(j + 2, end);
            j = end;
          } else {
            const length = c === 'x' ? 2 : 4;
            digits = text.slice(j + 1, j + 1 + length);
            j += length;
            if (digits.length !== length) {
              return error('invalid text escape', at);
            }
          }
          if (
            !/^[\dA-Fa-f]+$/.test(digits) ||
            Number.parseInt(digits, 16) > 0x10_ff_ff
          ) {
            return error('invalid text escape', at);
          }
          append(String.fromCodePoint(Number.parseInt(digits, 16)), at);
          continue;
        }
        append(c, at);
      }
      for (let j = 0; j < value.length; j++) {
        const c = value.charCodeAt(j);
        if (
          c >= 0xd8_00 &&
          c <= 0xdb_ff &&
          value.charCodeAt(j + 1) >= 0xdc_00 &&
          value.charCodeAt(j + 1) <= 0xdf_ff
        ) {
          j++;
          continue;
        }
        if (c >= 0xd8_00 && c <= 0xdf_ff) {
          return error('invalid text escape', origins[j]!);
        }
      }
      part.value = value;
    }
    return {
      ...this.tok(
        parts.length === 1 ? 'str' : 'template',
        parts[0]!.value,
        open,
        i + width,
        space,
        mode,
      ),
      parts,
    };
  }

  lex(start: number, mode: Mode): Token {
    const s = this.src;
    const { pos, trivia } = this.trivia(start);
    const sp =
      pos > start || pos === 0 || s[pos - 1] === '\n' || s[pos - 1] === '\r';
    const T = (
      t: TokType,
      v: string,
      len = v.length,
      code?: SyntaxErrorCode,
    ) => ({
      ...this.tok(t, v, pos, pos + len, sp, mode, code),
      leadingTrivia: trivia,
    });
    if (pos >= s.length) {
      return T('eof', '', 0);
    }
    const c = s[pos]!;
    const rest = s.slice(pos);

    if (c === '\n') {
      return T('nl', String.raw`\n`, 1);
    }
    if (c === '\r') {
      return T('nl', String.raw`\n`, s[pos + 1] === '\n' ? 2 : 1);
    }

    if (mode === 'unit' || mode === 'type') {
      const m = UNIT_SHAPE.exec(rest);
      const first = m?.[0].startsWith('1/')
        ? '1'
        : m?.[0].match(/^[A-Za-z]+/)?.[0];
      const compound = m && /[*/^]/.test(m[0]);
      // After a number any Unit starts here; after `as` only a Compound Unit
      // does, since a single word there may be a kind.
      if (
        m &&
        (first === '1' || unitEntry(first!) !== undefined) &&
        (mode === 'unit' || compound)
      ) {
        const problem = unitProblem(m[0]);
        if (problem) {
          return T('error', problem, m[0].length, 'bad unit');
        }
        return T('unit', m[0]);
      }
      // Fall through without rescanning trivia or changing the requested mode.
    }

    if (c === '`' || rest.startsWith('"""')) {
      return { ...runTask(this.fenced(pos, sp, mode)), leadingTrivia: trivia };
    }
    if (c === '"') {
      let i = pos + 1;
      while (i < s.length && s[i] !== '"' && s[i] !== '\n' && s[i] !== '\r') {
        i++;
      }
      if (s[i] !== '"') {
        return T(
          'error',
          'text has no closing quote on its line',
          i - pos,
          'unterminated text',
        );
      }
      return {
        ...this.tok('str', s.slice(pos + 1, i), pos, i + 1, sp, mode),
        leadingTrivia: trivia,
      };
    }
    if (/\d/.test(c)) {
      return T('num', NUMBER.exec(rest)![0]);
    }
    if (/[A-Z_a-z]/.test(c)) {
      return T('word', NAME.exec(rest)![0]);
    }
    if (c === "'" && s[pos + 1] === 's' && !/\w/.test(s[pos + 2] ?? '')) {
      return T('op', "'s");
    }

    const interpretation =
      mode === 'unit' ? 'operator' : mode === 'type' ? 'operand' : mode;
    if (c === '<') {
      if (interpretation === 'pattern') {
        return T('patopen', '<');
      }
      if (interpretation === 'operand') {
        return s[pos + 1] === '<' ? T('binopen', '<<') : T('patopen', '<');
      }
      for (const op of ['<<', '<=', '<>', '<']) {
        if (rest.startsWith(op)) {
          return T('op', op);
        }
      }
    }
    if (c === '>') {
      if (interpretation === 'pattern') {
        return T('patclose', '>');
      }
      for (const op of ['>>', '>=', '>']) {
        if (rest.startsWith(op)) {
          return T('op', op);
        }
      }
    }
    for (const op of OPS) {
      if (rest.startsWith(op)) {
        return T('op', op);
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(pos)!);
    return T(
      'error',
      `${JSON.stringify(ch)} starts no token`,
      ch.length,
      'bad character',
    );
  }
}
