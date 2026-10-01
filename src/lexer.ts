// Spec chapter 1: lossless modal tokenization. Offsets use UTF-16; columns use scalars.
import { grammar, units } from './generated/syntax';
import { assertScalarText } from './unicode';
import type { SyntaxErrorCode, Trivia } from './syntax';

export type Mode =
  | 'operand' // `<` opens a Text Pattern, `<<` opens a Binary Pattern
  | 'operator' // `<` is less-than, `<<` is lexed only to be refused, `>>` closes a Binary Pattern
  | 'pattern' // inside `<…>`: `<` nests, and `>` always closes, one character at a time
  | 'unit' // after a numeric literal: a Unit if one starts here, else as "operator"
  | 'type'; // after `as`: a Compound Unit if one starts here, else as "operand"

export type TokType =
  | 'num'
  | 'str'
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
  kind: 'token';
  leadingTrivia: readonly Trivia[];
  line: number;
  mode: Mode;
  pos: number;
  raw: string;
  spaceBefore: boolean;
  t: TokType;
  v: string;
};

export const RESERVED = new Set<string>(grammar.reserved);

type Unit = { calendar: boolean; name: string; plural?: string };
const UNITS = new Map<string, Unit>();
for (const u of units) {
  UNITS.set(u.name, u);
  if (u.plural) {
    UNITS.set(u.plural, u);
  }
}
const isCalendar = (u: Unit) => u.calendar;

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
const unitProblem = (text: string): string | null => {
  let slashes = text.startsWith('1/') ? 1 : 0;
  const body = text.startsWith('1/') ? text.slice(2) : text;
  const factors = body.split(/([*/])/);
  for (let i = 0; i < factors.length; i += 2) {
    if (factors[i - 1] === '/') {
      slashes++;
    }
    const [name, exp] = factors[i]!.split('^');
    const u = UNITS.get(name!);
    if (!u) {
      return `\`${name}\` is not a Unit`;
    }
    if (exp !== undefined && !/^[1-9]\d*$/.test(exp)) {
      return 'an exponent must be a positive integer';
    }
    if (
      isCalendar(u) &&
      (factors.length > 1 || exp !== undefined || text.startsWith('1/'))
    ) {
      return `the Calendar Unit \`${name}\` can't be part of a Compound Unit`;
    }
  }
  if (slashes > 1) {
    return 'a Compound Unit has at most one `/`';
  }
  return null;
};

export class Lexer {
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
        (first === '1' || UNITS.has(first!)) &&
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
