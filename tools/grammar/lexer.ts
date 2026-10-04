// The modal lexer of Spec chapter 1. Not normative (ADR 0028): it exists to
// check that the grammar stays predictive with two tokens of lookahead.
//
// The lexer keeps no state beyond the source. The parser asks for "the token
// at this offset, lexed in this mode", so the mode is always the parser's
// decision. Only `<`, `>`, `<<`, `>>` and the word after a numeric literal or
// `as` change with the mode.

import { Lexer as FencedLexer, type TextPart } from '../../impl/ts/src/lexer';
import grammar from '../../spec/data/grammar.toml';
import units from '../../spec/data/units.toml';

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
  code?: string; // for "error": the syntax error code
  col: number;
  end: number;
  line: number;
  mode: Mode;
  parts?: TextPart[];
  pos: number;
  spaceBefore: boolean;
  t: TokType;
  v: string;
};

export const RESERVED = new Set<string>(grammar.reserved);

type Unit = { kind: string; name: string; plural?: string };
const kinds = new Map<string, any>(units.kind.map((k: any) => [k.name, k]));
const UNITS = new Map<string, Unit>();
for (const u of units.unit as Unit[]) {
  UNITS.set(u.name, u);
  if (u.plural) {
    UNITS.set(u.plural, u);
  }
}
const isCalendar = (u: Unit) => Boolean(kinds.get(u.kind)?.calendar);

// A Compound Unit's shape: factors joined by `*`, one `/`, exponents after `^`.
// The lexer takes the longest run of this shape, then checks it.
const UNIT_SHAPE =
  /^(?:1\/)?[A-Za-z]+(?:\^-?\d+)?(?:[*/][A-Za-z]+(?:\^-?\d+)?)*(?!\w)/;
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
  private fenced: FencedLexer;
  lineStarts: number[] = [0];

  constructor(public src: string) {
    this.fenced = new FencedLexer(src);
    for (let i = 0; i < src.length; i++) {
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
    let col = 1;
    for (let i = this.lineStarts[lo]!; i < pos; i++) {
      const c = this.src.charCodeAt(i);
      if (!(c >= 0xdc_00 && c <= 0xdf_ff)) {
        col++;
      }
    }
    return { line: lo + 1, col };
  }

  tok(
    t: TokType,
    v: string,
    pos: number,
    end: number,
    spaceBefore: boolean,
    mode: Mode,
    code?: string,
  ): Token {
    return { t, v, code, pos, end, ...this.where(pos), spaceBefore, mode };
  }

  // Skips spaces, tabs and comments. A line break is a token: whether it ends
  // a statement depends on bracket depth, which the parser knows.
  skip(pos: number): number {
    const s = this.src;
    if (pos === 0 && s.charCodeAt(0) === 0xfe_ff) {
      pos = 1;
    }
    for (;;) {
      const c = s[pos];
      if (c === ' ' || c === '\t') {
        pos++;
      } else if (c === '-' && s[pos + 1] === '-') {
        while (pos < s.length && s[pos] !== '\n' && s[pos] !== '\r') {
          pos++;
        }
      } else {
        return pos;
      }
    }
  }

  lex(start: number, mode: Mode): Token {
    const s = this.src;
    const pos = this.skip(start);
    const sp =
      pos > start || pos === 0 || s[pos - 1] === '\n' || s[pos - 1] === '\r';
    const T = (t: TokType, v: string, len = v.length, code?: string) =>
      this.tok(t, v, pos, pos + len, sp, mode, code);
    if (pos >= s.length) {
      return T('eof', '', 0);
    }
    const c = s[pos]!;
    const rest = s.slice(pos, pos + 128);
    if (c === '`' || rest.startsWith('"""')) {
      return this.fenced.lex(start, mode);
    }

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
      return this.lex(start, mode === 'unit' ? 'operator' : 'operand');
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
          1,
          'unterminated text',
        );
      }
      return this.tok('str', s.slice(pos + 1, i), pos, i + 1, sp, mode);
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

    if (c === '<') {
      if (mode === 'pattern') {
        return T('patopen', '<');
      }
      if (mode === 'operand') {
        return s[pos + 1] === '<' ? T('binopen', '<<') : T('patopen', '<');
      }
      for (const op of ['<<', '<=', '<>', '<']) {
        if (rest.startsWith(op)) {
          return T('op', op);
        }
      }
    }
    if (c === '>') {
      if (mode === 'pattern') {
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
