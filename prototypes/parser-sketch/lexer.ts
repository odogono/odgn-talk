// PROTOTYPE (throwaway, issue #38): the modal lexer ADR 0019 describes.
//
// The lexer has no state of its own beyond the source. The parser asks for
// "the token at this offset, lexed in this mode", so the mode is always the
// parser's decision. The only characters whose meaning changes with the mode
// are `<`, `>`, and the text after a number, `as`, `date`, `instant` or `at`.

import g from "./grammar.toml";

export type Mode =
  | "operand" // `<` opens a Text Pattern, `<<` opens a Binary Pattern, `...` is spread/rest
  | "operator" // `<` is less-than, `<<` is an error token, `>>` closes a Binary Pattern
  | "pattern" // inside `<…>`: `<` nests, `>` closes (always one character)
  | "binary" // at a field start inside `<<…>>`
  | "unit" // after a numeric literal: a catalogue Unit, else as "operator"
  | "type" // after `as`: a compound Unit (`km/hr`), else as "operand"
  | "date" // after `date`/`instant`: a date-shaped token, else as "operand"
  | "time"; // after `at`: `14:30`, else as "operand"

export type TokType =
  | "num" | "str" | "word" | "op" | "unit" | "datetime" | "time"
  | "patopen" | "patclose" | "binopen" | "nl" | "eof" | "error";

export interface Token {
  t: TokType;
  v: string;
  pos: number;
  end: number;
  line: number;
  col: number;
  spaceBefore: boolean;
  mode: Mode;
}

const units = new Set<string>(g.units.catalogue);

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?(?![\w-])/;
const TIME = /^\d{1,2}:\d{2}(:\d{2})?(?!\w)/;
const UNIT = /^[A-Za-z]+(\^-?\d+)?(\/[A-Za-z]+(\^-?\d+)?)*(?![\w])/;

export class Lexer {
  lineStarts: number[] = [0];
  constructor(public src: string) {
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") this.lineStarts.push(i + 1);
  }

  where(pos: number): { line: number; col: number } {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - this.lineStarts[lo] + 1 };
  }

  tok(t: TokType, v: string, pos: number, end: number, spaceBefore: boolean, mode: Mode): Token {
    return { t, v, pos, end, ...this.where(pos), spaceBefore, mode };
  }

  // Skips spaces and comments. Newlines are tokens: whether one ends a
  // statement is decided by the token stream, which knows bracket depth.
  skip(pos: number): number {
    const s = this.src;
    for (;;) {
      const c = s[pos];
      if (c === " " || c === "\t" || c === "\r") pos++;
      else if (c === "-" && s[pos + 1] === "-") {
        while (pos < s.length && s[pos] !== "\n") pos++;
      } else return pos;
    }
  }

  lex(start: number, mode: Mode): Token {
    const s = this.src;
    const pos = this.skip(start);
    const sp = pos > start || pos === 0 || s[pos - 1] === "\n";
    const T = (t: TokType, v: string, len = v.length) => this.tok(t, v, pos, pos + len, sp, mode);
    if (pos >= s.length) return T("eof", "", 0);
    const c = s[pos];
    const rest = s.slice(pos, pos + 64);

    if (c === "\n") return T("nl", "\\n", 1);

    // The modes that try a special shape first, then fall back.
    if (mode === "unit") {
      const m = UNIT.exec(rest);
      if (m && m[0].split("/").every((p) => units.has(p.replace(/\^-?\d+$/, "")))) return T("unit", m[0]);
      return this.lex(start, "operator");
    }
    if (mode === "type") {
      const m = UNIT.exec(rest);
      if (m && m[0].includes("/") && m[0].split("/").every((p) => units.has(p.replace(/\^-?\d+$/, ""))))
        return T("unit", m[0]);
      return this.lex(start, "operand");
    }
    if (mode === "date") {
      const m = DATE.exec(rest);
      if (m) return T("datetime", m[0]);
      return this.lex(start, "operand");
    }
    if (mode === "time") {
      const m = TIME.exec(rest);
      if (m) return T("time", m[0]);
      return this.lex(start, "operand");
    }

    if (c === '"') {
      let i = pos + 1;
      while (i < s.length && s[i] !== '"' && s[i] !== "\n") i++;
      if (s[i] !== '"') return T("error", "unterminated text", 1);
      return this.tok("str", s.slice(pos + 1, i), pos, i + 1, sp, mode);
    }
    if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9A-Fa-f]+|\d+(\.\d+)?)/.exec(rest)!;
      return T("num", m[0]);
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)!;
      return T("word", m[0]);
    }
    if (c === "'" && s[pos + 1] === "s" && !/[A-Za-z0-9_]/.test(s[pos + 2] ?? "")) return T("op", "'s");

    // Brackets whose meaning is modal.
    if (c === "<") {
      if (mode === "operand" || mode === "binary") {
        if (s[pos + 1] === "<") return T("binopen", "<<");
        return T("patopen", "<");
      }
      if (mode === "pattern") return T("patopen", "<");
      // operator position: `<<` is lexed so the parser can reject it by name
      for (const op of ["<<", "<=", "<>", "<"]) if (rest.startsWith(op)) return T("op", op);
    }
    if (c === ">") {
      if (mode === "pattern") return T("patclose", ">");
      for (const op of [">>", ">=", ">"]) if (rest.startsWith(op)) return T("op", op);
    }
    for (const op of ["...", "..", "&", "=", "+", "-", "*", "/", "^", "(", ")", "[", "]", "{", "}", ",", ":"]) {
      if (rest.startsWith(op)) return T("op", op);
    }
    return T("error", `unexpected character ${JSON.stringify(c)}`, 1);
  }
}
