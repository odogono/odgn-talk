// PROTOTYPE (throwaway, issue #38): a predictive parser for the ADR 0019 grammar.
//
// Rules this file keeps to, so that it tests the ADR's claim:
//   * No backtracking. There is no mark/reset; a consumed token stays consumed.
//   * Two tokens of lookahead, at most: `peek(0)` and `peek(1)`. A `peek(2)`
//     throws. Every decision that needs `peek(1)` goes through `la2(site, …)`,
//     which counts it under a site name, so the report lists every LL(2) spot.
//   * The parser drives the lexer: every peek names the mode the token is
//     lexed in. If a token already in the buffer was lexed in another mode and
//     comes out different, that's recorded as a relex (a mode the parser
//     didn't know in time).
//   * The first syntax error stops the parse (only it is normative).

import g from "./grammar.toml";
import { Lexer, type Mode, type Token } from "./lexer";

export type Node = { k: string; [key: string]: any };

export class ParseError extends Error {
  constructor(public tok: Token, msg: string) {
    super(msg);
  }
}

const RESERVED = new Set<string>(Object.values(g.reserved).flat() as string[]);
const WORD_OPS = new Set<string>(g.operators.word_operators);
const SINGULAR = new Set<string>(Object.keys(g.chunks.kinds).filter((k) => !k.includes(" ")));
const PLURAL = new Set<string>((Object.values(g.chunks.kinds) as string[]).filter((k) => !k.includes(" ")));
const ORDINALS = new Set<string>(g.contextual.ordinals.words);
const BUILTINS = new Set<string>(g.properties.builtin);
const PAT_KEYWORDS = new Set<string>(g.text_patterns.keywords);
const INT_TYPES = new Set<string>(g.binary_patterns.integer_types);
const SIZE_UNITS = new Set<string>(g.binary_patterns.size_units);
const HEAD_MODIFIERS = new Set<string>(g.contextual.handler_head.words);
// grammar.toml's FOLLOW set: after a chunk word, one of these means the chunk
// word was a plain name followed by an operator or modifier.
const FOLLOW_WORDS = new Set<string>(g.contextual.follow.words);

const CMP_SYMBOLS = new Set(["=", "<>", "<", ">", "<=", ">="]);

export interface Stats {
  sites: Map<string, number>;
  relexes: { site: string; line: number; col: number; was: string; now: string }[];
  notes: { line: number; col: number; msg: string }[];
}

export function newStats(): Stats {
  return { sites: new Map(), relexes: [], notes: [] };
}

interface Buffered {
  tok: Token;
  start: number;
}

export class Parser {
  lx: Lexer;
  buf: Buffered[] = [];
  offset = 0; // source offset after the last consumed token
  prev: Token | null = null;
  brackets: string[] = []; // open brackets, innermost last
  binBuild = 0; // inside a `<< … >>` build field, where `as uint16` is a field type
  site = "";

  constructor(src: string, public stats: Stats = newStats()) {
    this.lx = new Lexer(src);
  }

  // ---------------------------------------------------------------- tokens

  private opens(t: Token): string | null {
    if (t.t === "patopen") return "<";
    if (t.t === "binopen") return "<<";
    if (t.t === "op" && (t.v === "(" || t.v === "[" || t.v === "{")) return t.v;
    return null;
  }

  private closes(t: Token, top: string | undefined): boolean {
    if (t.t === "patclose") return top === "<";
    if (t.t !== "op") return false;
    return (t.v === ")" && top === "(") || (t.v === "]" && top === "[") ||
      (t.v === "}" && top === "{") || (t.v === ">>" && top === "<<");
  }

  // A line goes on after a binary operator, `&` or a comma (ADR 0019).
  private continues(t: Token | null): boolean {
    if (!t) return false;
    if (t.t === "op") return t.v === "," || (t.mode === "operator" && !["'s", ")", "]", "}", ">>", ":"].includes(t.v));
    if (t.t === "word" && t.mode === "operator") return ["and", "or", "is", "mod", "div", "contains", "matches"].includes(t.v);
    return false;
  }

  private lexAt(start: number, mode: Mode, before: Token | null, depth: number): Buffered {
    for (;;) {
      const tok = this.lx.lex(start, mode);
      if (tok.t === "nl" && (depth > 0 || this.continues(before))) {
        start = tok.end;
        continue;
      }
      return { tok, start };
    }
  }

  peek(k: 0 | 1 | 2, mode: Mode = "operand"): Token {
    if (k > 1) throw new Error(`lookahead of ${k + 1} tokens at ${this.site}`);
    while (this.buf.length <= k) this.fill(this.buf.length, mode);
    const b = this.buf[k];
    if (b.tok.mode !== mode && b.tok.t !== "nl" && b.tok.t !== "eof") {
      const i = k;
      const again = this.lexAt(b.start, mode, i === 0 ? this.prev : this.buf[0].tok, this.depthAt(i));
      const same = again.tok.t === b.tok.t && again.tok.v === b.tok.v && again.tok.end === b.tok.end;
      if (!same) {
        this.stats.relexes.push({ site: this.site, line: b.tok.line, col: b.tok.col, was: `${b.tok.t}:${b.tok.v}`, now: `${again.tok.t}:${again.tok.v}` });
        this.buf.length = i;
        this.buf.push(again);
      }
    }
    return this.buf[k].tok;
  }

  private depthAt(i: number): number {
    let d = this.brackets.length;
    if (i === 1) {
      const t0 = this.buf[0].tok;
      if (this.opens(t0)) d++;
      else if (this.closes(t0, this.brackets.at(-1))) d--;
    }
    return d;
  }

  private fill(i: number, mode: Mode) {
    const start = i === 0 ? this.offset : this.buf[0].tok.end;
    const before = i === 0 ? this.prev : this.buf[0].tok;
    this.buf.push(this.lexAt(start, mode, before, this.depthAt(i)));
  }

  next(mode: Mode = "operand"): Token {
    const t = this.peek(0, mode);
    if (t.t === "error") throw new ParseError(t, t.v);
    this.buf.shift();
    this.offset = t.end;
    this.prev = t;
    const o = this.opens(t);
    if (o) this.brackets.push(o);
    else if (this.closes(t, this.brackets.at(-1))) this.brackets.pop();
    return t;
  }

  // An LL(2) decision: counted under `site` for the report.
  la2(site: string, mode: Mode = "operand"): Token {
    this.site = site;
    this.stats.sites.set(site, (this.stats.sites.get(site) ?? 0) + 1);
    return this.peek(1, mode);
  }

  fail(t: Token, expected: string): never {
    if (t.t === "error") throw new ParseError(t, t.v);
    const got = t.t === "nl" ? "end of line" : t.t === "eof" ? "end of file" : `\`${t.v}\``;
    throw new ParseError(t, `expected ${expected}, found ${got}`);
  }

  note(t: Token, msg: string) {
    this.stats.notes.push({ line: t.line, col: t.col, msg });
  }

  isWord(t: Token, ...ws: string[]) {
    return t.t === "word" && (ws.length === 0 || ws.includes(t.v));
  }
  // A kind or Unit name after `is a`, `can be` or `as`: any word but a Reserved Word.
  isKindWord(t: Token) {
    return t.t === "word" && !RESERVED.has(t.v);
  }
  isOp(t: Token, ...vs: string[]) {
    return t.t === "op" && vs.includes(t.v);
  }
  atWord(...ws: string[]) {
    return this.isWord(this.peek(0), ...ws);
  }
  atEnd(mode: Mode = "operator") {
    const t = this.peek(0, mode);
    return t.t === "nl" || t.t === "eof";
  }

  expectWord(w: string, mode: Mode = "operand"): Token {
    const t = this.peek(0, mode);
    if (!this.isWord(t, w)) this.fail(t, `\`${w}\``);
    return this.next(mode);
  }
  expectOp(v: string, mode: Mode = "operator"): Token {
    const t = this.peek(0, mode);
    if (!this.isOp(t, v)) this.fail(t, `\`${v}\``);
    return this.next(mode);
  }
  name(what = "a name"): string {
    const t = this.peek(0);
    if (t.t !== "word" || RESERVED.has(t.v)) this.fail(t, what);
    return this.next().v;
  }
  anyWord(what: string): string {
    const t = this.peek(0);
    if (t.t !== "word") this.fail(t, what);
    return this.next().v;
  }
  endOfStatement() {
    const t = this.peek(0, "operator");
    if (t.t === "eof") return;
    if (t.t !== "nl") this.fail(t, "end of line");
    this.next("operator");
  }
  skipNL() {
    while (this.peek(0).t === "nl") this.next();
  }

  // ---------------------------------------------------------------- program

  program(): Node[] {
    const out: Node[] = [];
    this.skipNL();
    while (this.peek(0).t !== "eof") {
      const t = this.peek(0);
      if (this.isWord(t, "on")) out.push(this.handler());
      else if (this.isWord(t, "function")) out.push(this.func());
      else if (this.isWord(t, "script") && this.isWord(this.la2("script-variable"), "variable")) out.push(this.scriptVariable());
      else this.fail(t, "`on`, `function` or `script variable`");
      this.skipNL();
    }
    return out;
  }

  scriptVariable(): Node {
    this.next();
    this.next();
    const name = this.name();
    let init: Node | null = null;
    if (this.isOp(this.peek(0, "operator"), "=")) {
      this.next("operator");
      init = this.expr();
    }
    this.endOfStatement();
    return { k: "ScriptVariable", name, init };
  }

  handler(): Node {
    this.next();
    const nameTok = this.peek(0);
    const name = this.name("a Handler name");
    const params: Node[] = [];
    const modifiers: string[] = [];
    let guard: Node | null = null;
    let during: string | null = null;
    const startsHead = () => { const t = this.peek(0); return !(t.t === "nl" || t.t === "eof" || this.isOp(t, ",") || this.isWord(t, "where")); };
    if (startsHead()) params.push(this.pattern());
    for (;;) {
      const t = this.peek(0, "operator");
      if (this.isWord(t, "where") && !guard) {
        this.next();
        guard = this.expr();
        continue;
      }
      if (!this.isOp(t, ",")) break;
      this.next("operator");
      const w = this.peek(0);
      if (this.isWord(w) && HEAD_MODIFIERS.has(w.v)) modifiers.push(this.next().v);
      else if (this.isWord(w, "every") && this.isWord(this.la2("head-every-time"), "time")) {
        this.next(); this.next(); modifiers.push("every time");
      } else if (this.isWord(w, "during") && this.isWord(this.la2("head-during"))) {
        this.next(); during = this.name();
      } else if (modifiers.length || guard) this.fail(w, "a Handler modifier");
      else params.push(this.pattern());
    }
    this.endOfStatement();
    const body = this.block(["end", "finally"]);
    let fin: Node[] | null = null;
    if (this.atWord("finally")) {
      this.next();
      this.endOfStatement();
      fin = this.block(["end"]);
    }
    this.expectWord("end");
    const endTok = this.peek(0);
    const endName = this.anyWord(`\`${name}\``);
    if (endName !== name) this.fail(endTok, `\`end ${name}\` (the Handler at ${nameTok.line}:${nameTok.col})`);
    this.endOfStatement();
    return { k: "Handler", name, params, guard, modifiers, during, body, finally: fin };
  }

  func(): Node {
    this.next();
    const name = this.name("a function name");
    const params: string[] = [];
    if (this.atWord("of")) {
      this.next();
      params.push(this.name());
      while (this.isOp(this.peek(0, "operator"), ",")) { this.next("operator"); params.push(this.name()); }
    }
    this.endOfStatement();
    const body = this.block(["end"]);
    this.expectWord("end");
    const endTok = this.peek(0);
    if (this.anyWord(`\`${name}\``) !== name) this.fail(endTok, `\`end ${name}\``);
    this.endOfStatement();
    return { k: "Function", name, params, body };
  }

  // ---------------------------------------------------------------- statements

  block(terms: string[]): Node[] {
    const out: Node[] = [];
    for (;;) {
      this.skipNL();
      const t = this.peek(0);
      if (t.t === "eof") this.fail(t, `\`${terms.join("` or `")}\``);
      if (this.isWord(t) && terms.includes(t.v)) return out;
      out.push(this.statement());
      this.endOfStatement();
    }
  }

  // A statement's body after `then` or `else`: one statement on the same line,
  // or a newline and a block.
  body(terms: string[]): Node[] {
    if (this.atEnd()) {
      this.endOfStatement();
      return this.block(terms);
    }
    return [this.statement()];
  }

  statement(): Node {
    const t = this.peek(0);
    if (t.t !== "word") this.fail(t, "a statement");
    switch (t.v) {
      case "put": {
        this.next();
        let spread = false;
        if (this.isOp(this.peek(0), "...")) { this.next(); spread = true; }
        const value = this.expr();
        const p = this.peek(0, "operator");
        if (!this.isWord(p, "into", "after", "before")) this.fail(p, "`into`, `after` or `before`");
        this.next("operator");
        return { k: "Put", spread, value, prep: p.v, target: this.container() };
      }
      case "let": {
        this.next();
        const pat = this.pattern();
        this.expectWord("be", "operator");
        return { k: "Let", pat, value: this.expr() };
      }
      case "set": {
        this.next();
        const target = this.container();
        this.expectWord("to", "operator");
        return { k: "Set", target, value: this.expr() };
      }
      case "add":
      case "subtract": {
        this.next();
        const value = this.expr();
        this.expectWord(t.v === "add" ? "to" : "from", "operator");
        return { k: t.v === "add" ? "Add" : "Subtract", value, target: this.container() };
      }
      case "multiply":
      case "divide": {
        this.next();
        const target = this.container();
        this.expectWord("by", "operator");
        return { k: t.v === "multiply" ? "Multiply" : "Divide", target, value: this.expr() };
      }
      case "delete":
        this.next();
        return { k: "Delete", target: this.container() };
      case "send":
        return this.send();
      case "ask":
      case "tell":
        return this.askTell();
      case "wait":
        return this.wait();
      case "return": {
        this.next();
        return { k: "Return", value: this.atEnd("operand") || this.atWord("else") ? null : this.expr() };
      }
      case "pass": {
        this.next();
        const w = this.peek(0, "operator");
        return { k: "Pass", name: w.t === "word" && !RESERVED.has(w.v) ? this.next().v : null };
      }
      case "exit":
        this.next();
        this.expectWord("repeat");
        return { k: "ExitRepeat" };
      case "throw":
        this.next();
        return { k: "Throw", value: this.expr() };
      case "replace":
        return { ...this.replaceBody(true), k: "ReplaceStatement" };
      case "if":
        return this.ifStatement();
      case "repeat":
        return this.repeat();
      case "match":
        return this.match();
      case "try":
        return this.tryStatement();
      case "next":
        if (this.isWord(this.la2("next-repeat"), "repeat")) { this.next(); this.next(); return { k: "NextRepeat" }; }
    }
    if (RESERVED.has(t.v)) this.fail(t, "a statement");
    // A Command Call: a non-reserved word, then comma-separated arguments.
    const name = this.next().v;
    const args: Node[] = [];
    const p = this.peek(0); // arguments are in operand position
    if (this.isOp(p, "(") && !p.spaceBefore) {
      this.note(t, `\`${name}(…)\` as a statement: a function call, not a Command Call`);
      return { k: "CallStatement", call: this.postfix({ k: "Name", name, tok: t }) };
    }
    if (!(p.t === "nl" || p.t === "eof" || this.isWord(p, "else"))) args.push(...this.exprList());
    return { k: "Command", name, args };
  }

  exprList(): Node[] {
    const out = [this.expr()];
    while (this.isOp(this.peek(0, "operator"), ",")) {
      this.next("operator");
      out.push(this.expr());
    }
    return out;
  }

  // A Container: a name, or a Chunk Expression or key path rooted in one.
  container(): Node {
    const t = this.peek(0);
    const e = this.chunkLevel();
    let root = e;
    while (root && root.k !== "Name") root = root.of ?? root.target ?? root.base;
    if (!root) this.fail(t, "a Container (a variable, or a chunk or key of one)");
    return e;
  }

  send(): Node {
    this.next();
    const msg = this.name("a message name");
    let args: Node[] = [];
    if (this.atWord("with")) {
      this.next();
      args = this.exprList();
    }
    this.expectWord("to", "operator");
    const target = this.expr();
    return { k: "Send", msg, args, target, wait: this.andWait() };
  }

  andWait(): boolean {
    const t = this.peek(0, "operator");
    if (this.isWord(t, "and") && this.isWord(this.la2("and-wait"), "wait")) {
      this.next("operator");
      this.next();
      return true;
    }
    return false;
  }

  askTell(): Node {
    const verb = this.next().v;
    const target = this.expr();
    this.expectWord("to", "operator");
    // ADR 0012: the word after `to` is always an Operation name, reserved or not.
    const op = this.anyWord("an Operation name");
    let args: Node[] = [];
    const t = this.peek(0, "operator");
    const waitNext = this.isWord(t, "and") && this.isWord(this.la2("and-wait"), "wait");
    if (!(t.t === "nl" || t.t === "eof" || waitNext)) args = this.exprList();
    const wait = this.andWait();
    return { k: verb === "ask" ? "Ask" : "Tell", target, op, args, wait };
  }

  wait(): Node {
    this.next();
    if (!this.atWord("for")) return { k: "Wait", duration: this.expr() };
    this.next();
    if (this.atEnd()) {
      this.endOfStatement();
      const branches: Node[] = [];
      for (;;) {
        this.skipNL();
        const t = this.peek(0);
        if (this.isWord(t, "when")) {
          this.next();
          const ev = this.event();
          let guard: Node | null = null;
          if (this.atWord("where")) { this.next(); guard = this.expr(); }
          this.expectWord("then", "operator");
          branches.push({ ...ev, k: "WhenEvent", guard, body: this.body(["when", "after", "end"]) });
        } else if (this.isWord(t, "after")) {
          this.next();
          const d = this.expr();
          this.expectWord("then", "operator");
          branches.push({ k: "After", duration: d, body: this.body(["when", "after", "end"]) });
        } else if (this.isWord(t, "end")) {
          this.next();
          this.expectWord("wait");
          return { k: "WaitForBlock", branches };
        } else this.fail(t, "`when`, `after` or `end wait`");
        if (branches.at(-1)!.body.length === 1 && !this.atWord("when", "after", "end")) this.endOfStatement();
      }
    }
    const ev = this.event();
    let timeout: Node | null = null;
    if (this.isWord(this.peek(0, "operator"), "or")) {
      this.next("operator");
      timeout = this.expr();
    }
    return { ...ev, k: "WaitFor", timeout };
  }

  // `paid {order: ^orderId}`, `click from okButton`
  event(): Node {
    const name = this.name("an event name");
    const pats: Node[] = [];
    let from: Node | null = null;
    const stop = () => {
      const t = this.peek(0, "operator");
      return t.t === "nl" || t.t === "eof" || this.isWord(t, "where", "then", "or") ||
        (this.isWord(t, "from") && this.startsOperand(this.la2("wait-from")));
    };
    if (!stop()) {
      pats.push(this.pattern());
      while (this.isOp(this.peek(0, "operator"), ",")) { this.next("operator"); pats.push(this.pattern()); }
    }
    if (this.isWord(this.peek(0, "operator"), "from")) {
      this.next("operator");
      // `from` takes a postfix-level operand, so `… from okButton or 30 s`
      // leaves `or` to the timeout.
      from = this.chunkLevel();
    }
    return { k: "Event", name, pats, from };
  }

  ifStatement(): Node {
    this.next();
    const cond = this.expr();
    this.expectWord("then", "operator");
    if (this.atEnd()) {
      this.endOfStatement();
      const then = this.block(["else", "end"]);
      let els: Node[] | null = null;
      if (this.atWord("else")) {
        this.next();
        if (this.atWord("if")) {
          const inner = this.ifStatement();
          els = [inner];
          if (inner.block) return { k: "If", cond, then, else: els, block: true };
          this.endOfStatement();
          this.skipNL();
        } else {
          this.endOfStatement();
          els = this.block(["end"]);
        }
      }
      this.expectWord("end");
      this.expectWord("if");
      return { k: "If", cond, then, else: els, block: true };
    }
    const then = [this.statement()];
    let els: Node[] | null = null;
    if (this.isWord(this.peek(0, "operator"), "else")) {
      this.next();
      els = [this.statement()];
    }
    return { k: "If", cond, then, else: els, block: false };
  }

  repeat(): Node {
    this.next();
    const t = this.peek(0);
    let head: Node;
    if (this.isWord(t, "for")) {
      this.next();
      this.expectWord("each");
      const pat = this.pattern();
      this.expectWord("in", "operator");
      head = { k: "ForEach", pat, src: this.expr() };
    } else if (this.isWord(t, "while", "until")) {
      this.next();
      head = { k: t.v === "while" ? "While" : "Until", cond: this.expr() };
    } else if (this.isWord(t, "forever") || t.t === "nl") {
      if (t.t !== "nl") this.next();
      head = { k: "Forever" };
    } else {
      const n = this.expr();
      this.expectWord("times", "operator");
      head = { k: "Times", n };
    }
    this.endOfStatement();
    const body = this.block(["end"]);
    this.expectWord("end");
    this.expectWord("repeat");
    return { k: "Repeat", head, body };
  }

  match(): Node {
    this.next();
    const subject = this.expr();
    const ic = this.ignoringCase();
    this.endOfStatement();
    const branches: Node[] = [];
    for (;;) {
      this.skipNL();
      const t = this.peek(0);
      if (this.isWord(t, "when")) {
        this.next();
        let search = false;
        if (this.atWord("contains") && this.la2("when-contains").t === "patopen") { this.next(); search = true; }
        const pat = this.pattern();
        let guard: Node | null = null;
        if (this.isWord(this.peek(0, "operator"), "where")) { this.next("operator"); guard = this.expr(); }
        this.expectWord("then", "operator");
        branches.push({ k: "When", search, pat, guard, body: this.body(["when", "else", "end"]) });
      } else if (this.isWord(t, "else")) {
        this.next();
        branches.push({ k: "Else", body: this.body(["end"]) });
      } else if (this.isWord(t, "end")) {
        this.next();
        this.expectWord("match");
        return { k: "Match", subject, ignoringCase: ic, branches };
      } else this.fail(t, "`when`, `else` or `end match`");
      if (branches.at(-1)!.body.length === 1 && !this.atWord("when", "else", "end")) this.endOfStatement();
    }
  }

  tryStatement(): Node {
    this.next();
    this.endOfStatement();
    const body = this.block(["catch", "finally", "end"]);
    const catches: Node[] = [];
    while (this.atWord("catch")) {
      this.next();
      const pat = this.pattern();
      let guard: Node | null = null;
      if (this.isWord(this.peek(0, "operator"), "where")) { this.next("operator"); guard = this.expr(); }
      this.endOfStatement();
      catches.push({ k: "Catch", pat, guard, body: this.block(["catch", "finally", "end"]) });
    }
    let fin: Node[] | null = null;
    if (this.atWord("finally")) {
      this.next();
      this.endOfStatement();
      fin = this.block(["end"]);
    }
    this.expectWord("end");
    this.expectWord("try");
    return { k: "Try", body, catches, finally: fin };
  }

  // `replace [first] <p> in c with e`. As a statement `c` is a Container.
  replaceBody(statement: boolean): Node {
    this.next();
    let first = false;
    if (this.atWord("first") && !this.isWord(this.la2("replace-first"), "in")) { this.next(); first = true; }
    const pat = this.chunkLevel();
    this.expectWord("in", "operator");
    const target = statement ? this.container() : this.concat();
    this.expectWord("with", "operator");
    const value = statement ? this.expr() : this.concat();
    return { k: "Replace", first, pat, target, value };
  }

  ignoringCase(): boolean {
    if (this.isWord(this.peek(0, "operator"), "ignoring") && this.isWord(this.la2("ignoring-case"), "case")) {
      this.next("operator");
      this.next();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- expressions

  expr(): Node {
    const e = this.or();
    const t = this.peek(0, "operator");
    if (this.isWord(t, "for") && this.isWord(this.la2("for-every"), "every")) {
      // map Comprehension: lowest precedence, so all of `e` is the projection
      this.next("operator");
      this.next();
      return { ...this.comprehensionTail(), k: "MapEvery", project: e };
    }
    return e;
  }

  comprehensionTail(): Node {
    const name = this.name("the element name");
    this.expectWord("in", "operator");
    const src = this.concat();
    let where: Node | null = null;
    let sort: Node | null = null;
    if (this.isWord(this.peek(0, "operator"), "where")) { this.next("operator"); where = this.or(); }
    if (this.isWord(this.peek(0, "operator"), "sorted") && this.isWord(this.la2("sorted-by"), "by")) {
      this.next("operator");
      this.next();
      const key = this.concat();
      let dir = "ascending";
      const d = this.peek(0, "operator");
      if (this.isWord(d, "ascending", "descending")) dir = this.next("operator").v;
      sort = { k: "SortBy", key, dir };
    }
    return { k: "Every", name, src, where, sort };
  }

  or(): Node {
    let l = this.and();
    while (this.isWord(this.peek(0, "operator"), "or")) {
      this.next("operator");
      l = { k: "Or", l, r: this.and() };
    }
    return l;
  }

  and(): Node {
    let l = this.not();
    for (;;) {
      const t = this.peek(0, "operator");
      if (!this.isWord(t, "and")) return l;
      if (this.isWord(this.la2("and-wait"), "wait")) return l;
      this.next("operator");
      l = { k: "And", l, r: this.not() };
    }
  }

  not(): Node {
    if (this.atWord("not")) {
      this.next();
      return { k: "Not", e: this.not() };
    }
    return this.cmp();
  }

  cmp(): Node {
    const l = this.concat();
    const t = this.peek(0, "operator");
    let node: Node | null = null;
    if (t.t === "op" && CMP_SYMBOLS.has(t.v)) {
      this.next("operator");
      node = { k: "Cmp", op: t.v, l, r: this.concat() };
    } else if (this.isWord(t, "is")) {
      this.next("operator");
      let neg = false;
      if (this.atWord("not")) { this.next(); neg = true; }
      const u = this.peek(0);
      if (this.isWord(u, "in")) {
        this.next();
        node = { k: neg ? "NotIn" : "In", l, r: this.concat() };
      } else if (this.isWord(u, "a", "an") && this.isKindWord(this.la2("is-a"))) {
        this.next();
        node = { k: "IsA", neg, l, kind: this.next().v };
      } else if (this.isWord(u, "empty")) {
        this.next();
        node = { k: "IsEmpty", neg, l };
      } else {
        node = { k: neg ? "IsNot" : "Is", l, r: this.concat() };
      }
    } else if (this.isWord(t, "can") && this.isWord(this.la2("can-be", "operator"), "be")) {
      this.next("operator");
      this.next();
      if (this.atWord("a", "an")) this.next();
      node = { k: "CanBe", l, kind: this.typeName() };
    } else if (this.isWord(t, "contains", "matches")) {
      this.next("operator");
      node = { k: t.v === "contains" ? "Contains" : "Matches", l, r: this.concat() };
    } else if (this.isWord(t, "begins", "ends") && this.isWord(this.la2("begins-with"), "with")) {
      this.next("operator");
      this.next();
      node = { k: t.v === "begins" ? "BeginsWith" : "EndsWith", l, r: this.concat() };
    }
    if (!node) return l;
    if (this.ignoringCase()) node.ignoringCase = true;
    return node;
  }

  concat(): Node {
    let l = this.range();
    while (this.isOp(this.peek(0, "operator"), "&")) {
      this.next("operator");
      l = { k: "Concat", l, r: this.range() };
    }
    return l;
  }

  range(): Node {
    const l = this.add();
    if (this.isOp(this.peek(0, "operator"), "..")) {
      this.next("operator");
      return { k: "Range", l, r: this.add() };
    }
    return l;
  }

  add(): Node {
    let l = this.mul();
    for (;;) {
      const t = this.peek(0, "operator");
      if (!this.isOp(t, "+", "-")) return l;
      this.next("operator");
      l = { k: "Bin", op: t.v, l, r: this.mul() };
    }
  }

  mul(): Node {
    let l = this.pow();
    for (;;) {
      const t = this.peek(0, "operator");
      if (!(this.isOp(t, "*", "/") || this.isWord(t, "mod", "div"))) return l;
      this.next("operator");
      l = { k: "Bin", op: t.v, l, r: this.pow() };
    }
  }

  pow(): Node {
    const l = this.unary();
    if (this.isOp(this.peek(0, "operator"), "^")) {
      this.next("operator");
      return { k: "Bin", op: "^", l, r: this.pow() };
    }
    return l;
  }

  unary(): Node {
    if (this.isOp(this.peek(0), "-")) {
      this.next();
      return { k: "Neg", e: this.unary() };
    }
    return this.asLevel();
  }

  // Postfix `as`: tighter than every binary operator, looser than `of` and `'s`.
  asLevel(): Node {
    let e = this.chunkLevel();
    for (;;) {
      const t = this.peek(0, "operator");
      if (!this.isWord(t, "as")) return e;
      if (this.binBuild && INT_TYPES.has(this.la2("as-in-binary-build", "type").v)) return e;
      this.next("operator");
      e = { k: "As", e, type: this.typeName() };
    }
  }

  typeName(): string {
    const t = this.peek(0, "type");
    if (t.t === "unit" || this.isKindWord(t)) return this.next("type").v;
    this.fail(t, "a kind or Unit");
  }

  // A postfix expression, plus a `delimited by` that belongs to the outermost
  // Chunk Expression of an `of` chain.
  chunkLevel(): Node {
    const e = this.postfix(this.primary());
    if (this.isWord(this.peek(0, "operator"), "delimited") && this.isWord(this.la2("delimited-by"), "by")) {
      if (!["Chunk", "Chunks", "AllChunks", "OrdinalChunk"].includes(e.k)) this.fail(this.peek(0, "operator"), "a Chunk Expression before `delimited by`");
      this.next("operator");
      this.next();
      return { ...e, delimiter: this.postfix(this.primary()) };
    }
    return e;
  }

  postfix(e: Node): Node {
    for (;;) {
      const t = this.peek(0, "operator");
      if (this.isOp(t, "'s")) {
        this.next("operator");
        e = { k: "Key", key: this.anyWord("a key after `'s`"), base: e };
      } else if (this.isOp(t, "(") && !t.spaceBefore && e.k === "Name") {
        this.next("operator");
        const args: Node[] = [];
        if (!this.isOp(this.peek(0), ")")) args.push(...this.withoutBuild(() => this.exprList()));
        this.expectOp(")");
        e = { k: "Call", fn: e.name, args };
      } else return e;
    }
  }

  withoutBuild<T>(f: () => T): T {
    const b = this.binBuild;
    this.binBuild = 0;
    try { return f(); } finally { this.binBuild = b; }
  }

  // After a chunk word: does the next token start its index? A word in the
  // FOLLOW set means the chunk word was a plain name followed by an operator.
  startsOperand(t: Token): boolean {
    if (t.t === "num" || t.t === "str") return true;
    if (t.t === "op") return ["-", "[", "("].includes(t.v);
    if (t.t === "word") return (!RESERVED.has(t.v) || ["the", "it", "me"].includes(t.v)) && !FOLLOW_WORDS.has(t.v);
    return false;
  }

  primary(): Node {
    const t = this.peek(0);
    switch (t.t) {
      case "num": {
        this.next();
        const u = this.peek(0, "unit");
        if (u.t === "unit") { this.next("unit"); return { k: "Quantity", n: t.v, unit: u.v }; }
        return { k: "Num", v: t.v };
      }
      case "str":
        this.next();
        return { k: "Str", v: t.v };
      case "patopen":
        this.next();
        return this.textPattern();
      case "binopen":
        this.next();
        return this.binaryBuild();
      case "op":
        if (t.v === "(") {
          this.next();
          const e = this.withoutBuild(() => this.expr());
          this.expectOp(")");
          return { k: "Paren", e };
        }
        if (t.v === "[") return this.listLiteral();
        if (t.v === "{") return this.mapLiteral();
        if (t.v === "...") { this.next(); return { k: "Spread", e: this.chunkLevel() }; }
        this.fail(t, "an expression");
      case "word":
        return this.wordPrimary(t);
    }
    this.fail(t, "an expression");
  }

  wordPrimary(t: Token): Node {
    const w = t.v;
    if (["true", "false", "nothing", "it", "me"].includes(w)) { this.next(); return { k: "Const", v: w }; }
    if (w === "the") return this.the();
    if (w === "return") {
      this.note(t, "`return` used as the line-break constant in operand position");
      this.next();
      return { k: "Const", v: "return" };
    }
    if (w === "replace") return this.replaceBody(false);
    if (w === "not") { this.next(); return { k: "Not", e: this.unary() }; }
    if (RESERVED.has(w)) this.fail(t, "an expression");
    if (w === "every") {
      const n = this.la2("every");
      if (this.isWord(n, "match")) {
        this.next(); this.next();
        this.expectWord("of", "operator");
        const pat = this.chunkLevel();
        this.expectWord("in", "operator");
        return { k: "EveryMatch", pat, src: this.concat(), ignoringCase: this.ignoringCase() };
      }
      if (this.isWord(n) && !RESERVED.has(n.v)) { this.next(); return this.comprehensionTail(); }
    }
    if (w === "date" || w === "instant") {
      if (this.la2("date-literal", "date").t === "datetime") {
        this.next();
        const d = this.next("date").v;
        let time: string | null = null;
        if (this.isWord(this.peek(0, "operator"), "at") && this.la2("date-at", "time").t === "time") {
          this.next("operator");
          time = this.next("time").v;
        }
        return { k: w === "date" ? "DateLit" : "InstantLit", v: d, time };
      }
    }
    if (w === "code") {
      const n = this.la2("code-point");
      if (this.isWord(n, "point", "points")) {
        this.next(); this.next();
        return this.chunkAfterKind(n.v === "point" ? "code point" : "code points", t);
      }
    }
    if (SINGULAR.has(w) || PLURAL.has(w)) {
      const n = this.la2("chunk-word");
      if (this.startsOperand(n) && !(this.isOp(n, "(") && !n.spaceBefore)) {
        this.next();
        return this.chunkAfterKind(w, t);
      }
    }
    this.next();
    return { k: "Name", name: w };
  }

  // `item 2 of x`, `characters 2..4 of w`
  chunkAfterKind(kind: string, t: Token): Node {
    const index = this.range();
    this.expectWord("of", "operator");
    return { k: "Chunk", kind, index, of: this.chunkTarget() };
  }

  // The operand of `of`: another chunk or `the` form, or a postfix expression.
  chunkTarget(): Node {
    return this.postfix(this.primary());
  }

  the(): Node {
    this.next();
    const t = this.peek(0);
    if (this.isOp(t, "(")) {
      this.next();
      const key = this.withoutBuild(() => this.expr());
      this.expectOp(")");
      this.expectWord("of", "operator");
      return { k: "Key", key, computed: true, base: this.chunkTarget() };
    }
    if (t.t === "str") {
      this.next();
      this.expectWord("of", "operator");
      return { k: "Key", key: t.v, base: this.chunkTarget() };
    }
    if (t.t !== "word") this.fail(t, "a word after `the`");
    const n = this.la2("the");
    if (ORDINALS.has(t.v) && (this.isWord(n) && (SINGULAR.has(n.v) || n.v === "code"))) {
      this.next();
      let kind = this.next().v;
      if (kind === "code") { this.expectWord("point"); kind = "code point"; }
      this.expectWord("of", "operator");
      return { k: "OrdinalChunk", ord: t.v, kind, of: this.chunkTarget() };
    }
    if (this.isWord(t, "target") && !this.isWord(n, "of")) { this.next(); return { k: "Target" }; }
    if (this.isWord(t, "match") && this.isWord(n, "of")) {
      this.next(); this.next();
      const pat = this.chunkLevel();
      this.expectWord("in", "operator");
      return { k: "FirstMatch", pat, src: this.concat(), ignoringCase: this.ignoringCase() };
    }
    if (this.isWord(t, "code") && this.isWord(n, "points")) {
      this.next(); this.next();
      this.expectWord("of", "operator");
      return { k: "AllChunks", kind: "code points", of: this.chunkTarget() };
    }
    if (RESERVED.has(t.v)) this.fail(t, "a key or property name (a Reserved Word needs `the \"…\" of`)");
    this.next();
    this.expectWord("of", "operator");
    // `the number of words in report` (count), decided on the chunk word and `in`
    if (t.v === "number") {
      const c = this.peek(0);
      const c2 = this.la2("count-form", "operator");
      if (this.isWord(c) && PLURAL.has(c.v) && this.isWord(c2, "in")) {
        this.next(); this.next();
        return { k: "Count", kind: c.v, of: this.chunkTarget() };
      }
      if (this.isWord(c, "code") && this.isWord(c2, "points")) {
        this.next(); this.next();
        this.expectWord("in", "operator");
        return { k: "Count", kind: "code points", of: this.chunkTarget() };
      }
    }
    if (PLURAL.has(t.v)) return { k: "AllChunks", kind: t.v, of: this.chunkTarget() };
    return { k: BUILTINS.has(t.v) ? "Property" : "Key", key: t.v, base: this.chunkTarget() };
  }

  listLiteral(): Node {
    this.next();
    const items: Node[] = [];
    if (!this.isOp(this.peek(0), "]")) {
      do {
        if (items.length) this.next("operator");
        items.push(this.expr());
      } while (this.isOp(this.peek(0, "operator"), ","));
    }
    this.expectOp("]");
    return { k: "List", items };
  }

  // A word followed by `:` is a key, even a Reserved Word (`{to: who}`).
  mapKey(): string {
    const t = this.peek(0);
    if ((t.t === "word" || t.t === "str") && this.isOp(this.la2("map-key", "operator"), ":")) {
      this.next();
      this.next("operator");
      if (t.t === "word" && RESERVED.has(t.v)) this.note(t, `map key \`${t.v}\` is a Reserved Word: read it back with \`the "${t.v}" of …\``);
      return t.v;
    }
    this.fail(t, "a key and `:`");
  }

  mapLiteral(): Node {
    this.next();
    const entries: Node[] = [];
    if (!this.isOp(this.peek(0), "}")) {
      do {
        if (entries.length) this.next("operator");
        const key = this.mapKey();
        entries.push({ k: "Entry", key, value: this.expr() });
      } while (this.isOp(this.peek(0, "operator"), ","));
    }
    this.expectOp("}");
    return { k: "Map", entries };
  }

  // ---------------------------------------------------------------- Destructuring

  pattern(): Node {
    let p = this.patternPrimary();
    const t = this.peek(0, "operator");
    if (this.isWord(t, "is")) {
      this.next("operator");
      let neg = false;
      if (this.atWord("not")) { this.next(); neg = true; }
      if (this.atWord("a", "an")) this.next();
      p = { k: "KindTest", p, neg, kind: this.anyWord("a kind") };
    }
    if (this.isWord(this.peek(0, "operator"), "as") && this.isWord(this.la2("pattern-as"))) {
      this.next("operator");
      p = { k: "BindAs", p, name: this.name() };
    }
    return p;
  }

  patternPrimary(): Node {
    const t = this.peek(0);
    if (this.isOp(t, "[")) {
      this.next();
      const items: Node[] = [];
      if (!this.isOp(this.peek(0), "]")) {
        do {
          if (items.length) this.next("operator");
          if (this.isOp(this.peek(0), "...")) {
            this.next();
            const n = this.peek(0, "operator");
            items.push({ k: "Rest", name: n.t === "word" && !RESERVED.has(n.v) ? this.next().v : null });
          } else items.push(this.pattern());
        } while (this.isOp(this.peek(0, "operator"), ","));
      }
      this.expectOp("]");
      return { k: "ListPat", items };
    }
    if (this.isOp(t, "{")) {
      this.next();
      const entries: Node[] = [];
      if (!this.isOp(this.peek(0), "}")) {
        do {
          if (entries.length) this.next("operator");
          const k = this.peek(0);
          if (k.t === "word" && !this.isOp(this.la2("map-key", "operator"), ":")) {
            entries.push({ k: "Entry", key: this.name("a key"), value: { k: "Bind", name: k.v } }); // shorthand `{n}`
          } else entries.push({ k: "Entry", key: this.mapKey(), value: this.pattern() });
        } while (this.isOp(this.peek(0, "operator"), ","));
      }
      this.expectOp("}");
      return { k: "MapPat", entries };
    }
    if (t.t === "patopen") { this.next(); return this.textPattern(); }
    if (t.t === "binopen") { this.next(); return this.binaryPattern(); }
    if (this.isOp(t, "^")) { this.next(); return { k: "Pin", name: this.name() }; }
    if (this.isOp(t, "-") || t.t === "num" || t.t === "str") return { k: "LitPat", v: this.unary() };
    if (this.isWord(t, "true", "false", "nothing")) { this.next(); return { k: "LitPat", v: t.v }; }
    if (this.isWord(t, "_")) { this.next(); return { k: "Wildcard" }; }
    if (t.t === "word" && !RESERVED.has(t.v)) { this.next(); return { k: "Bind", name: t.v }; }
    this.fail(t, "a pattern");
  }

  // ---------------------------------------------------------------- Text Patterns

  textPattern(): Node {
    const els: Node[] = [];
    if (this.peek(0, "pattern").t !== "patclose") {
      els.push(this.patAlt());
      while (this.isOp(this.peek(0, "pattern"), ",")) { this.next("pattern"); els.push(this.patAlt()); }
    }
    const c = this.peek(0, "pattern");
    if (c.t !== "patclose") this.fail(c, "`,` or `>`");
    this.next("pattern");
    return { k: "TextPattern", els };
  }

  patAlt(): Node {
    let l = this.patPost();
    while (this.isWord(this.peek(0, "pattern"), "or")) {
      this.next("pattern");
      l = { k: "PatOr", l, r: this.patPost() };
    }
    return l;
  }

  patPost(): Node {
    let e = this.patAtom();
    for (;;) {
      const t = this.peek(0, "pattern");
      if (this.isWord(t, "as")) { this.next("pattern"); e = { k: "As", e, type: this.typeName() }; }
      else if (this.isWord(t, "lazily")) { this.next("pattern"); e = { k: "Lazily", e }; }
      else if (this.isWord(t, "ignoring") && this.isWord(this.la2("ignoring-case", "pattern"), "case")) {
        this.next("pattern"); this.next("pattern"); e = { k: "IgnoringCase", e };
      } else return e;
    }
  }

  patAtom(): Node {
    const t = this.peek(0, "pattern");
    if (t.t === "str") { this.next("pattern"); return { k: "Str", v: t.v }; }
    if (t.t === "num") { this.next("pattern"); return { k: "PatCount", n: t.v, e: this.patAtom() }; }
    if (t.t === "patopen") { this.next("pattern"); return { ...this.textPattern(), k: "PatGroup" }; }
    if (this.isOp(t, "(")) {
      this.next("pattern");
      const e = this.expr();
      this.expectOp(")");
      return { k: "Splice", e };
    }
    if (t.t === "word") {
      if (this.isOp(this.la2("capture", "pattern"), ":")) {
        this.next("pattern");
        this.next("pattern");
        if (RESERVED.has(t.v)) this.note(t, `Capture \`${t.v}\` is a Reserved Word: it binds, but the Script can never read it`);
        return { k: "Capture", name: t.v, e: this.patAlt() };
      }
      if (this.isWord(t, "one", "zero")) {
        this.next("pattern");
        this.expectWord("or", "pattern"); this.expectWord("more", "pattern"); this.expectWord("of", "pattern");
        return { k: t.v === "one" ? "OneOrMore" : "ZeroOrMore", e: this.patAtom() };
      }
      if (this.isWord(t, "optional")) { this.next("pattern"); return { k: "Optional", e: this.patAtom() }; }
      if (this.isWord(t, "a", "an")) { this.next("pattern"); return { k: "Typed", kind: this.anyWord("a kind") }; }
      if (PAT_KEYWORDS.has(t.v)) { this.next("pattern"); return { k: "PatKw", v: t.v }; }
      this.fail(t, "a pattern keyword, a Capture (`name:`) or a splice (`(…)`)");
    }
    this.fail(t, "a Text Pattern element");
  }

  // ---------------------------------------------------------------- Binary Patterns

  binaryPattern(): Node {
    const fields: Node[] = [];
    const closes = () => this.isOp(this.peek(0, "operator"), ">>");
    if (!closes()) {
      do {
        if (fields.length) this.next("operator");
        fields.push(this.binField());
      } while (this.isOp(this.peek(0, "operator"), ","));
    }
    this.expectOp(">>");
    return { k: "BinaryPattern", fields };
  }

  binField(): Node {
    const t = this.peek(0, "binary");
    if (this.isOp(t, "...")) {
      this.next("binary");
      const n = this.peek(0, "operator");
      const name = n.t === "word" && !RESERVED.has(n.v) && n.v !== "as" ? this.next().v : null;
      let asText = false;
      if (this.isWord(this.peek(0, "operator"), "as")) { this.next("operator"); this.expectWord("text"); asText = true; }
      return { k: "BinRest", name, asText };
    }
    if (t.t === "num" || t.t === "str") { this.next("binary"); return { k: "BinLit", v: t.v }; }
    if (t.t === "word" && this.isOp(this.la2("binary-field", "operator"), ":")) {
      this.next("binary");
      this.next("operator");
      return { k: "BinField", name: t.v, type: this.binType() };
    }
    this.fail(t, "a Binary Pattern field (`name: type`, a literal or `...`)");
  }

  binType(): Node {
    const t = this.peek(0);
    if (this.isWord(t) && INT_TYPES.has(t.v)) {
      this.next();
      const o = this.peek(0, "operator");
      const order = this.isWord(o, "little", "big") ? this.next("operator").v : null;
      return { k: "Int", type: t.v, order };
    }
    let size: Node;
    if (t.t === "num") size = { k: "Num", v: this.next().v };
    else if (this.isOp(t, "(")) { this.next(); size = this.withoutBuild(() => this.expr()); this.expectOp(")"); }
    else if (t.t === "word" && !RESERVED.has(t.v)) size = { k: "Name", name: this.next().v };
    else this.fail(t, "a field type (`uint16`, `n bytes`, `n bits`)");
    const u = this.peek(0, "operator");
    if (!(this.isWord(u) && SIZE_UNITS.has(u.v))) this.fail(u, "`bytes` or `bits` after a field size");
    this.next("operator");
    let asText = false;
    if (this.isWord(this.peek(0, "operator"), "as")) { this.next("operator"); this.expectWord("text"); asText = true; }
    return { k: "Sized", size, unit: u.v, asText };
  }

  binaryBuild(): Node {
    const fields: Node[] = [];
    if (!this.isOp(this.peek(0, "operator"), ">>")) {
      do {
        if (fields.length) this.next("operator");
        this.binBuild++;
        let value: Node;
        try { value = this.concat(); } finally { this.binBuild--; }
        let type: Node | null = null;
        if (this.isWord(this.peek(0, "operator"), "as")) { this.next("operator"); type = this.binType(); }
        fields.push({ k: "BuildField", value, type });
      } while (this.isOp(this.peek(0, "operator"), ","));
    }
    this.expectOp(">>");
    return { k: "BinaryBuild", fields };
  }
}

export function parse(src: string, stats: Stats = newStats()): { ast: Node[] | null; error: ParseError | null; stats: Stats } {
  const p = new Parser(src, stats);
  try {
    return { ast: p.program(), error: null, stats };
  } catch (e) {
    if (e instanceof ParseError) return { ast: null, error: e, stats };
    throw e;
  }
}
