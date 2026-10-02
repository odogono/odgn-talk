// A predictive parser for the grammar of Spec chapter 2. Not normative (ADR
// 0028): it exists to check that the grammar in spec/data/grammar.ebnf stays
// predictive, with two tokens of lookahead and no backtracking, the way the
// #38 prototype did. It reads its word lists from spec/data/grammar.toml.
//
//   * No backtracking. There is no mark/reset, so a consumed token stays consumed.
//   * Two tokens of lookahead at most: `peek(0)` and `peek(1)`, and `peek(2)`
//     throws. Every decision that reads `peek(1)` goes through `la2(name)`,
//     and each name must be a `[[decision]]` in grammar.toml.
//   * The parser drives the lexer: every peek names the mode. A buffered token
//     that lexes differently in the mode asked for is recorded as a relex.
//   * The first syntax error stops the parse. Only it is normative.

import grammar from '../../spec/data/grammar.toml';
import { Lexer, RESERVED, type Mode, type Token } from './lexer';

export type Node = {
  [key: string]: any;
  col?: number;
  k: string;
  line?: number;
};

export class SyntaxError extends Error {
  constructor(
    public tok: Token,
    public code: string,
    msg: string,
  ) {
    super(msg);
  }
}

const words = (list: string[]) => new Set(list.filter(w => !w.includes(' ')));
const SINGULAR = words(grammar.chunk.map((c: any) => c.singular));
const PLURAL = words(grammar.chunk.map((c: any) => c.plural));
const ORDINALS = new Set<string>(grammar.ordinals);
const PROPERTIES = new Set<string>(grammar.properties);
const FOLLOW = new Set<string>(grammar.follow);
const DECISIONS = new Set<string>(grammar.decision.map((d: any) => d.name));
const PAT_KEYWORDS = new Set<string>(grammar.text_patterns.keywords);
const PAT_CLASSES = new Map<string, Set<string>>();
for (const c of grammar.text_patterns.classes as string[]) {
  const [a, b] = c.split(' ');
  PAT_CLASSES.set(a!, (PAT_CLASSES.get(a!) ?? new Set()).add(b!));
}
const ANCHORS = new Map<string, Set<string>>();
for (const c of grammar.text_patterns.anchors as string[]) {
  const [a, b] = c.split(' ');
  ANCHORS.set(a!, (ANCHORS.get(a!) ?? new Set()).add(b!));
}
const INT_TYPES = new Set<string>(grammar.binary_patterns.integer_types);
const SIZE_UNITS = new Set<string>(grammar.binary_patterns.size_units);
const BYTE_ORDERS = new Set<string>(grammar.binary_patterns.byte_orders);
const HEAD_SUFFIXES = new Set(['queued', 'dropping', 'replacing', 'deciding']);
const COMPARISONS = new Set(['=', '<>', '<', '>', '<=', '>=']);
// Statement blocks' ending keywords, which never follow a Lambda's `end`.
const BLOCK_KEYWORDS = ['if', 'repeat', 'match', 'try', 'wait'];
const endSuffixExpected = (name: string, at: Token) =>
  `end of line or \`${name}\` after \`end\` (closing line ${at.line})`;
// The operand-starting Reserved Words.
const OPERAND_WORDS = new Set([
  'the',
  'not',
  'true',
  'false',
  'nothing',
  'it',
  'me',
  'given',
  'replace',
]);
// Words that end a line in operator position and so continue it.
const CONTINUING_WORDS = new Set([
  'and',
  'or',
  'is',
  'mod',
  'div',
  'contains',
  'matches',
  'with',
  'be',
]);

export type Stats = {
  relexes: {
    col: number;
    line: number;
    now: string;
    site: string;
    was: string;
  }[];
  sites: Map<string, number>;
};

export const newStats = (): Stats => ({ sites: new Map(), relexes: [] });

type Buffered = {
  start: number;
  tok: Token;
};

export class Parser {
  lx: Lexer;
  buf: Buffered[] = [];
  offset = 0; // the source offset after the last consumed token
  prev: Token | null = null;
  brackets: string[] = []; // the open brackets, innermost last
  build = 0; // inside a `<< … >>` build value, where `as uint16` is a field type
  size = 0; // inside a parenthesised Binary Pattern size, where `^n` is allowed
  // A newline is skipped only while more brackets are open than the top of
  // this stack. A Lambda head and a block Lambda body push their own depth.
  nlBase: number[] = [0];
  site = '';

  constructor(
    src: string,
    public stats: Stats = newStats(),
  ) {
    this.lx = new Lexer(src);
  }

  // ---------------------------------------------------------------- tokens

  private opens(t: Token): string | null {
    if (t.t === 'patopen') {
      return '<';
    }
    if (t.t === 'binopen') {
      return '<<';
    }
    if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) {
      return t.v;
    }
    return null;
  }

  private closes(t: Token, top: string | undefined): boolean {
    if (t.t === 'patclose') {
      return top === '<';
    }
    if (t.t !== 'op') {
      return false;
    }
    return (
      (t.v === ')' && top === '(') ||
      (t.v === ']' && top === '[') ||
      (t.v === '}' && top === '{') ||
      (t.v === '>>' && top === '<<')
    );
  }

  // A line goes on after a comma, or after a binary operator (chapter 1).
  private continues(t: Token | null): boolean {
    if (!t || t.mode !== 'operator') {
      return t?.t === 'op' && t.v === ',';
    }
    if (t.t === 'op') {
      return !["'s", ')', ']', '}', '>>', ':'].includes(t.v);
    }
    return t.t === 'word' && CONTINUING_WORDS.has(t.v);
  }

  private lexAt(
    start: number,
    mode: Mode,
    before: Token | null,
    depth: number,
  ): Buffered {
    for (;;) {
      const tok = this.lx.lex(start, mode);
      if (
        tok.t === 'nl' &&
        (depth > this.nlBase.at(-1)! || this.continues(before))
      ) {
        start = tok.end;
        continue;
      }
      return { tok, start };
    }
  }

  peek(k: 0 | 1 | 2, mode: Mode = 'operand'): Token {
    if (k > 1) {
      throw new Error(`a third token of lookahead at ${this.site}`);
    }
    while (this.buf.length <= k) {
      this.fill(this.buf.length, mode);
    }
    const b = this.buf[k]!;
    if (b.tok.mode !== mode && b.tok.t !== 'nl' && b.tok.t !== 'eof') {
      const again = this.lexAt(
        b.start,
        mode,
        k === 0 ? this.prev : this.buf[0]!.tok,
        this.depthAt(k),
      );
      const same =
        again.tok.t === b.tok.t &&
        again.tok.v === b.tok.v &&
        again.tok.end === b.tok.end;
      if (!same) {
        this.stats.relexes.push({
          site: this.site,
          line: b.tok.line,
          col: b.tok.col,
          was: `${b.tok.t}:${b.tok.v}`,
          now: `${again.tok.t}:${again.tok.v}`,
        });
        this.buf.length = k;
        this.buf.push(again);
      } else {
        b.tok.mode = mode;
      }
    }
    return this.buf[k]!.tok;
  }

  private depthAt(i: number): number {
    let d = this.brackets.length;
    if (i === 1) {
      const t0 = this.buf[0]!.tok;
      if (this.opens(t0)) {
        d++;
      } else if (this.closes(t0, this.brackets.at(-1))) {
        d--;
      }
    }
    return d;
  }

  private fill(i: number, mode: Mode) {
    const start = i === 0 ? this.offset : this.buf[0]!.tok.end;
    const before = i === 0 ? this.prev : this.buf[0]!.tok;
    this.buf.push(this.lexAt(start, mode, before, this.depthAt(i)));
  }

  next(mode: Mode = 'operand'): Token {
    const t = this.peek(0, mode);
    if (t.t === 'error') {
      throw new SyntaxError(t, t.code!, t.v);
    }
    this.buf.shift();
    this.offset = t.end;
    this.prev = t;
    const o = this.opens(t);
    if (o) {
      this.brackets.push(o);
    } else if (this.closes(t, this.brackets.at(-1))) {
      this.brackets.pop();
    }
    return t;
  }

  // A decision that reads the second token, counted under its name.
  la2(site: string, mode: Mode = 'operand'): Token {
    if (!DECISIONS.has(site)) {
      throw new Error(`decision \`${site}\` isn't in grammar.toml`);
    }
    this.site = site;
    this.stats.sites.set(site, (this.stats.sites.get(site) ?? 0) + 1);
    return this.peek(1, mode);
  }

  fail(t: Token, expected: string): never {
    if (t.t === 'error') {
      throw new SyntaxError(t, t.code!, t.v);
    }
    const got =
      t.t === 'nl'
        ? 'end of line'
        : t.t === 'eof'
          ? 'end of source'
          : `\`${t.v}\``;
    throw new SyntaxError(
      t,
      'unexpected token',
      `expected ${expected}, found ${got}`,
    );
  }

  // Stamps a node with the position of the token its construct starts at,
  // or its operator's, for the source map (chapter 8).
  at<N extends Node>(t: Token, n: N): N {
    if (n.line === undefined) {
      n.line = t.line;
      n.col = t.col;
    }
    return n;
  }

  isWord(t: Token, ...ws: string[]) {
    return t.t === 'word' && (ws.length === 0 || ws.includes(t.v));
  }
  isName(t: Token) {
    return t.t === 'word' && !RESERVED.has(t.v) && t.v !== '_';
  }
  isOp(t: Token, ...vs: string[]) {
    return t.t === 'op' && vs.includes(t.v);
  }
  atWord(...ws: string[]) {
    return this.isWord(this.peek(0), ...ws);
  }
  atOperatorWord(...ws: string[]) {
    return this.isWord(this.peek(0, 'operator'), ...ws);
  }
  atEnd(mode: Mode = 'operator') {
    const t = this.peek(0, mode);
    return t.t === 'nl' || t.t === 'eof';
  }
  expectWord(w: string, mode: Mode = 'operand'): Token {
    const t = this.peek(0, mode);
    if (!this.isWord(t, w)) {
      this.fail(t, `\`${w}\``);
    }
    return this.next(mode);
  }
  expectOp(v: string, mode: Mode = 'operator'): Token {
    const t = this.peek(0, mode);
    if (!this.isOp(t, v)) {
      this.fail(t, `\`${v}\``);
    }
    return this.next(mode);
  }
  name(what = 'a name', mode: Mode = 'operand'): string {
    const t = this.peek(0, mode);
    if (!this.isName(t)) {
      this.fail(t, what);
    }
    return this.next(mode).v;
  }
  // A Handler, message or event name: any name but `all` (a Join).
  messageName(what: string): string {
    const t = this.peek(0);
    if (this.isWord(t, 'all')) {
      this.fail(t, `${what} (\`all\` can't name a message)`);
    }
    return this.name(what);
  }
  endOfStatement() {
    const t = this.peek(0, 'operator');
    if (t.t === 'eof') {
      return;
    }
    if (t.t !== 'nl') {
      this.fail(t, 'end of line');
    }
    this.next('operator');
  }
  skipNL() {
    while (this.peek(0).t === 'nl') {
      this.next();
    }
  }
  // A bare `end`, or `end` and the Name or keyword of the block opened at
  // `at`.
  endSuffix(name: string, at: Token) {
    const t = this.peek(0);
    if (t.t === 'nl' || t.t === 'eof') {
      return;
    }
    if (!this.isWord(t, name)) {
      this.fail(t, endSuffixExpected(name, at));
    }
    this.next();
  }

  // Can this token, in operand position, start an expression?
  startsExpr(t: Token): boolean {
    if (['num', 'str', 'patopen', 'binopen'].includes(t.t)) {
      return true;
    }
    if (t.t === 'op') {
      return ['(', '[', '{', '-'].includes(t.v);
    }
    return t.t === 'word' && (this.isName(t) || OPERAND_WORDS.has(t.v));
  }

  // ---------------------------------------------------------------- top level

  source(): Node[] {
    const out: Node[] = [];
    this.skipNL();
    while (this.peek(0).t !== 'eof') {
      out.push(this.declaration());
      this.skipNL();
    }
    return out;
  }

  declaration(): Node {
    const t = this.peek(0);
    if (this.isWord(t, 'private')) {
      this.next();
      const u = this.peek(0);
      if (!this.isWord(u, 'on', 'function', 'constant')) {
        this.fail(u, '`on`, `function` or `constant` after `private`');
      }
      return { ...this.declaration(), private: true };
    }
    if (this.isWord(t, 'on')) {
      return this.handler();
    }
    if (this.isWord(t, 'function')) {
      return this.func();
    }
    if (this.isWord(t, 'use')) {
      return this.use();
    }
    if (this.isWord(t, 'constant')) {
      this.next();
      const name = this.name('a Constant name');
      this.expectOp('=');
      const value = this.expr();
      this.endOfStatement();
      return { k: 'Constant', name, value };
    }
    if (
      this.isWord(t, 'script') &&
      this.isWord(this.la2('script-variable'), 'variable')
    ) {
      this.next();
      this.next();
      const name = this.name('a Script Variable name');
      let init: Node | null = null;
      if (this.isOp(this.peek(0, 'operator'), '=')) {
        this.next('operator');
        init = this.expr();
      }
      this.endOfStatement();
      return { k: 'ScriptVariable', name, init };
    }
    this.fail(
      t,
      '`on`, `function`, `script variable`, `constant`, `use` or `private`',
    );
  }

  use(): Node {
    this.next();
    const names = [this.name('an imported name')];
    while (this.isOp(this.peek(0, 'operator'), ',')) {
      this.next('operator');
      names.push(this.name('an imported name'));
    }
    this.expectWord('from', 'operator');
    const library = this.name('a Library name');
    let rename: string | null = null;
    // `as` renames, so it follows a single imported name only.
    if (names.length === 1 && this.atOperatorWord('as')) {
      this.next('operator');
      rename = this.name('a name after `as`');
    }
    this.endOfStatement();
    return { k: 'Use', names, library, rename };
  }

  handler(): Node {
    const on = this.next();
    const name = this.messageName('a Handler name');
    const params: Node[] = [];
    let guard: Node | null = null;
    const suffixes: string[] = [];
    let during: string | null = null;
    const t = this.peek(0);
    if (!(
      t.t === 'nl' ||
      t.t === 'eof' ||
      this.isWord(t, 'where') ||
      this.isOp(t, ',')
    )) {
      params.push(this.pattern());
    }
    // Parameters, then a Guard, then suffixes. After a comma, a suffix word
    // is always a suffix, so it can't be a parameter name there.
    let inParams = params.length > 0;
    let canGuard = true;
    for (;;) {
      const c = this.peek(0, 'operator');
      if (canGuard && this.isWord(c, 'where')) {
        this.next('operator');
        guard = this.expr();
        inParams = canGuard = false;
        continue;
      }
      if (!this.isOp(c, ',')) {
        break;
      }
      this.next('operator');
      const w = this.peek(0);
      if (this.isWord(w) && HEAD_SUFFIXES.has(w.v)) {
        suffixes.push(this.next().v);
        inParams = canGuard = false;
      } else if (this.isWord(w, 'during') && this.isName(this.la2('during'))) {
        this.next();
        during = this.next().v;
        inParams = canGuard = false;
      } else if (inParams) {
        params.push(this.pattern());
      } else {
        this.fail(
          w,
          '`queued`, `dropping`, `replacing`, `deciding` or `during`',
        );
      }
    }
    this.endOfStatement();
    const body = this.block(['end', 'finally']);
    let fin: Node[] | null = null;
    if (this.atWord('finally')) {
      this.next();
      this.endOfStatement();
      fin = this.block(['end']);
    }
    const end = this.expectWord('end');
    this.endSuffix(name, on);
    this.endOfStatement();
    return {
      k: 'Handler',
      name,
      params,
      guard,
      suffixes,
      during,
      body,
      finally: fin,
      line: on.line,
      col: on.col,
      end: { line: end.line, col: end.col },
    };
  }

  func(): Node {
    const fn = this.next();
    const name = this.name('a function name');
    const params: { default: Node | null; name: string }[] = [];
    // A parameter is a name, then `=` and a default (ADR 0035).
    const param = () => {
      const name = this.name('a parameter name');
      let dflt: Node | null = null;
      if (this.isOp(this.peek(0, 'operator'), '=')) {
        this.next('operator');
        dflt = this.expr();
      }
      params.push({ name, default: dflt });
    };
    if (!this.atEnd('operand')) {
      param();
      while (this.isOp(this.peek(0, 'operator'), ',')) {
        this.next('operator');
        param();
      }
    }
    this.endOfStatement();
    const body = this.block(['end']);
    const end = this.expectWord('end');
    this.endSuffix(name, fn);
    this.endOfStatement();
    return {
      k: 'Function',
      name,
      params,
      body,
      line: fn.line,
      col: fn.col,
      end: { line: end.line, col: end.col },
    };
  }

  // ---------------------------------------------------------------- statements

  block(terms: string[]): Node[] {
    const out: Node[] = [];
    for (;;) {
      this.skipNL();
      const t = this.peek(0);
      if (t.t === 'eof') {
        this.fail(t, terms.map(w => `\`${w}\``).join(' or '));
      }
      if (this.isWord(t) && terms.includes(t.v)) {
        return out;
      }
      out.push(this.statement());
      this.endOfStatement();
    }
  }

  // A branch body: a newline and a block, or one simple statement on the line.
  body(terms: string[]): Node[] {
    if (this.atEnd()) {
      this.endOfStatement();
      return this.block(terms);
    }
    const s = [this.simpleStatement()];
    this.endOfStatement();
    return s;
  }

  statement(): Node {
    const t = this.peek(0);
    if (this.isWord(t, 'if')) {
      return this.at(t, this.ifStatement());
    }
    if (this.isWord(t, 'repeat')) {
      return this.at(t, this.repeat());
    }
    if (this.isWord(t, 'match')) {
      return this.at(t, this.match());
    }
    if (this.isWord(t, 'try')) {
      return this.at(t, this.tryStatement());
    }
    if (this.isWord(t, 'wait')) {
      return this.at(t, this.wait(true));
    }
    return this.simpleStatement();
  }

  // A statement that fits on one line: any but `if`, `repeat`, `match`, `try`
  // and the block forms of `wait for`.
  simpleStatement(): Node {
    const t = this.peek(0);
    return this.at(t, this.simpleStatementAt(t));
  }

  simpleStatementAt(t: Token): Node {
    if (t.t !== 'word') {
      this.fail(t, 'a statement');
    }
    switch (t.v) {
      case 'put': {
        this.next();
        let spread = false;
        if (this.isOp(this.peek(0), '...')) {
          this.next();
          spread = true;
        }
        const value = this.expr();
        const p = this.peek(0, 'operator');
        const preps = spread
          ? ['after', 'before']
          : ['into', 'after', 'before'];
        if (!this.isWord(p, ...preps)) {
          this.fail(p, preps.map(w => `\`${w}\``).join(' or '));
        }
        this.next('operator');
        return { k: 'Put', spread, value, prep: p.v, target: this.container() };
      }
      case 'let': {
        this.next();
        const pat = this.pattern();
        this.expectWord('be', 'operator');
        return { k: 'Let', pat, value: this.expr() };
      }
      case 'set': {
        this.next();
        const target = this.container();
        this.expectWord('to', 'operator');
        return { k: 'Set', target, value: this.expr() };
      }
      case 'add':
      case 'subtract': {
        this.next();
        const value = this.expr();
        this.expectWord(t.v === 'add' ? 'to' : 'from', 'operator');
        return { k: t.v, value, target: this.container() };
      }
      case 'multiply':
      case 'divide': {
        this.next();
        const target = this.container();
        this.expectWord('by', 'operator');
        return { k: t.v, target, value: this.expr() };
      }
      case 'delete':
        this.next();
        return { k: 'Delete', target: this.container() };
      case 'send':
        return this.send();
      case 'ask':
      case 'tell':
        return this.askTell();
      case 'wait':
        return this.wait(false);
      case 'return':
      case 'veto': {
        this.next();
        return {
          k: t.v,
          value: this.startsExpr(this.peek(0)) ? this.expr() : null,
        };
      }
      case 'pass':
        this.next();
        return {
          k: 'Pass',
          name: this.messageName('a message name after `pass`'),
        };
      case 'exit':
        this.next();
        this.expectWord('repeat');
        return { k: 'ExitRepeat' };
      case 'throw':
        this.next();
        return { k: 'Throw', value: this.expr() };
      case 'replace':
        return { ...this.replace(true), k: 'ReplaceStatement' };
      case 'next':
        if (this.isWord(this.la2('next-repeat'), 'repeat')) {
          this.next();
          this.next();
          return { k: 'NextRepeat' };
        }
    }
    if (RESERVED.has(t.v)) {
      this.fail(t, 'a statement');
    }
    if (t.v === '_') {
      this.fail(t, 'a statement');
    }
    // A Command Call, or a call statement `f(x)`.
    const name = this.next().v;
    const p = this.peek(0);
    if (this.isOp(p, '(') && !p.spaceBefore) {
      return {
        k: 'CallStatement',
        call: this.call(name),
        wait: this.andWait(),
      };
    }
    const args = this.startsExpr(p) ? this.exprList() : [];
    return { k: 'Command', name, args, wait: this.andWait() };
  }

  exprList(): Node[] {
    const out = [this.expr()];
    while (this.isOp(this.peek(0, 'operator'), ',')) {
      this.next('operator');
      out.push(this.expr());
    }
    return out;
  }

  // A Container: a name, or a Chunk Expression or key path rooted in one.
  container(): Node {
    const t = this.peek(0);
    if (!this.startsExpr(t)) {
      this.fail(t, 'a Container');
    }
    const e = this.chunkLevel();
    let root = e;
    while (root && root.k !== 'Name') {
      root = root.of ?? root.base;
    }
    if (!root) {
      throw new SyntaxError(
        t,
        'not a container',
        'a Container is a name, or a chunk or key rooted in one',
      );
    }
    return e;
  }

  andWait(): boolean {
    if (
      this.atOperatorWord('and') &&
      this.isWord(this.la2('and-wait'), 'wait')
    ) {
      this.next('operator');
      this.next();
      return true;
    }
    return false;
  }

  send(): Node {
    this.next();
    const msg = this.messageName('a message name');
    let args: Node[] = [];
    if (this.atWord('with')) {
      this.next();
      args = this.exprList();
    }
    this.expectWord('to', 'operator');
    const target = this.expr();
    return { k: 'Send', msg, args, target, wait: this.andWait() };
  }

  askTell(): Node {
    const verb = this.next().v;
    const target = this.expr();
    this.expectWord('to', 'operator');
    // The word after `to` is always an Operation name, reserved or not.
    const t = this.peek(0);
    if (t.t !== 'word' || t.v === '_') {
      this.fail(t, 'an Operation name');
    }
    const op = this.next().v;
    const args = this.startsExpr(this.peek(0)) ? this.exprList() : [];
    return {
      k: verb,
      target,
      op,
      args,
      wait: verb === 'ask' ? this.andWait() : false,
    };
  }

  // `wait d`, `wait for ev [or d]`, and, where a block may go, the block
  // `wait for` and the Join.
  wait(blockAllowed: boolean): Node {
    const w = this.next();
    if (!this.atWord('for')) {
      return { k: 'Wait', duration: this.expr() };
    }
    this.next();
    if (this.atWord('all') || this.atEnd('operand')) {
      if (!blockAllowed) {
        this.fail(
          this.peek(0),
          'an event (a block `wait for` needs a line of its own)',
        );
      }
    }
    if (this.atWord('all')) {
      this.next();
      const t = this.peek(0, 'operator');
      if (t.t !== 'nl') {
        this.fail(t, 'end of line after `wait for all`');
      }
      this.endOfStatement();
      const body = this.block(['end']);
      this.expectWord('end');
      this.endSuffix('wait', w);
      return { k: 'Join', body };
    }
    if (this.atEnd('operand')) {
      this.endOfStatement();
      const branches: Node[] = [];
      for (;;) {
        this.skipNL();
        const t = this.peek(0);
        if (this.isWord(t, 'when')) {
          this.next();
          const ev = this.event();
          let guard: Node | null = null;
          if (this.atOperatorWord('where')) {
            this.next('operator');
            guard = this.expr();
          }
          this.expectWord('then', 'operator');
          branches.push({
            ...ev,
            k: 'WhenEvent',
            guard,
            body: this.body(['when', 'after', 'end']),
          });
        } else if (this.isWord(t, 'after')) {
          this.next();
          const d = this.expr();
          this.expectWord('then', 'operator');
          branches.push({
            k: 'After',
            duration: d,
            body: this.body(['when', 'after', 'end']),
          });
        } else if (this.isWord(t, 'end')) {
          this.next();
          this.endSuffix('wait', w);
          return { k: 'WaitForBlock', branches };
        } else {
          this.fail(t, '`when`, `after` or `end wait`');
        }
      }
    }
    const ev = this.event();
    let timeout: Node | null = null;
    if (this.atOperatorWord('or')) {
      this.next('operator');
      timeout = this.expr();
    }
    return { ...ev, k: 'WaitFor', timeout };
  }

  // `paid {order: o}`, `click from okButton`
  event(): Node {
    const name = this.messageName('an event name');
    const pats: Node[] = [];
    let from: Node | null = null;
    const atFrom = () =>
      this.atOperatorWord('from') && this.startsExpr(this.la2('wait-from'));
    const t = this.peek(0);
    if (!(
      t.t === 'nl' ||
      t.t === 'eof' ||
      this.isWord(t, 'where', 'then', 'or') ||
      atFrom()
    )) {
      pats.push(this.pattern());
      while (this.isOp(this.peek(0, 'operator'), ',')) {
        this.next('operator');
        pats.push(this.pattern());
      }
    }
    if (atFrom()) {
      this.next('operator');
      // A postfix-level operand, so `… from okButton or 30 s` leaves `or` to the timeout.
      from = this.chunkLevel();
    }
    return { k: 'Event', name, pats, from };
  }

  ifStatement(): Node {
    const at = this.next();
    const cond = this.expr();
    this.expectWord('then', 'operator');
    if (!this.atEnd()) {
      const then = this.simpleStatement();
      let els: Node | null = null;
      if (this.atOperatorWord('else')) {
        this.next('operator');
        els = this.simpleStatement();
      }
      return {
        k: 'If',
        cond,
        then: [then],
        else: els ? [els] : null,
        block: false,
      };
    }
    this.endOfStatement();
    const then = this.block(['else', 'end']);
    const elses: Node[] = [];
    let els: Node[] | null = null;
    while (this.atWord('else')) {
      this.next();
      if (this.atWord('if')) {
        this.next();
        const c = this.expr();
        this.expectWord('then', 'operator');
        this.endOfStatement();
        elses.push({ k: 'ElseIf', cond: c, body: this.block(['else', 'end']) });
        continue;
      }
      this.endOfStatement();
      els = this.block(['end']);
      break;
    }
    this.expectWord('end');
    this.endSuffix('if', at);
    return { k: 'If', cond, then, elses, else: els, block: true };
  }

  repeat(): Node {
    const at = this.next();
    const t = this.peek(0);
    let head: Node;
    if (this.isWord(t, 'for')) {
      this.next();
      this.expectWord('each');
      const pat = this.pattern();
      this.expectWord('in', 'operator');
      head = { k: 'ForEach', pat, src: this.expr() };
    } else if (this.isWord(t, 'while', 'until')) {
      this.next();
      head = { k: t.v, cond: this.expr() };
    } else if (this.isWord(t, 'forever')) {
      this.next();
      head = { k: 'Forever' };
    } else {
      const n = this.expr();
      this.expectWord('times', 'operator');
      head = { k: 'Times', n };
    }
    this.endOfStatement();
    const body = this.block(['end']);
    this.expectWord('end');
    this.endSuffix('repeat', at);
    return { k: 'Repeat', head, body };
  }

  match(): Node {
    const at = this.next();
    const subject = this.expr();
    const ignoringCase = this.ignoringCase();
    this.endOfStatement();
    const branches: Node[] = [];
    let sawElse = false;
    for (;;) {
      this.skipNL();
      const t = this.peek(0);
      if (this.isWord(t, 'when') && !sawElse) {
        const wt = this.next();
        let search = false;
        if (
          this.atWord('contains') &&
          this.la2('when-contains').t === 'patopen'
        ) {
          this.next();
          search = true;
        }
        const pat = this.pattern();
        let guard: Node | null = null;
        if (this.atOperatorWord('where')) {
          this.next('operator');
          guard = this.expr();
        }
        this.expectWord('then', 'operator');
        branches.push({
          k: 'When',
          search,
          pat,
          guard,
          body: this.body(['when', 'else', 'end']),
          line: wt.line,
          col: wt.col,
        });
      } else if (this.isWord(t, 'else') && !sawElse) {
        this.next();
        sawElse = true;
        branches.push({ k: 'Else', body: this.body(['end']) });
      } else if (this.isWord(t, 'end')) {
        this.next();
        this.endSuffix('match', at);
        return { k: 'Match', subject, ignoringCase, branches };
      } else {
        this.fail(t, sawElse ? '`end match`' : '`when`, `else` or `end match`');
      }
    }
  }

  tryStatement(): Node {
    const at = this.next();
    this.endOfStatement();
    const body = this.block(['catch', 'finally', 'end']);
    const catches: Node[] = [];
    while (this.atWord('catch')) {
      const ct = this.next();
      const pat = this.pattern();
      let guard: Node | null = null;
      if (this.atOperatorWord('where')) {
        this.next('operator');
        guard = this.expr();
      }
      this.endOfStatement();
      catches.push({
        k: 'Catch',
        pat,
        guard,
        body: this.block(['catch', 'finally', 'end']),
        line: ct.line,
        col: ct.col,
      });
    }
    let fin: Node[] | null = null;
    if (this.atWord('finally')) {
      this.next();
      this.endOfStatement();
      fin = this.block(['end']);
    }
    this.expectWord('end');
    this.endSuffix('try', at);
    return { k: 'Try', body, catches, finally: fin };
  }

  // `replace [first] <p> in c with e`. As a statement `c` is a Container.
  replace(statement: boolean): Node {
    this.next();
    let first = false;
    if (this.atWord('first') && !this.isWord(this.la2('replace-first'), 'in')) {
      this.next();
      first = true;
    }
    const pat = this.chunkLevel();
    this.expectWord('in', 'operator');
    const target = statement ? this.container() : this.or();
    this.expectWord('with', 'operator');
    const value = statement ? this.expr() : this.concat();
    return { k: 'Replace', first, pat, target, value };
  }

  ignoringCase(mode: Mode = 'operator'): boolean {
    if (
      this.isWord(this.peek(0, mode), 'ignoring') &&
      this.isWord(this.la2('ignoring-case', mode), 'case')
    ) {
      this.next(mode);
      this.next(mode);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- expressions

  expr(): Node {
    if (this.atWord('given')) {
      return this.lambda();
    }
    return this.or();
  }

  // `given p1, p2: expr`, or `given p1, p2` at the end of a line, then
  // statements, then `end` with an optional `given`.
  lambda(): Node {
    const at = this.next();
    return this.at(at, this.lambdaAt(at));
  }

  lambdaAt(at: Token): Node {
    this.nlBase.push(this.brackets.length);
    const params: Node[] = [];
    const t0 = this.peek(0);
    if (!(this.isOp(t0, ':') || t0.t === 'nl' || t0.t === 'eof')) {
      params.push(this.pattern());
      while (this.isOp(this.peek(0, 'operator'), ',')) {
        this.next('operator');
        params.push(this.pattern());
      }
    }
    const t = this.peek(0, 'operator');
    if (this.isOp(t, ':')) {
      this.next('operator');
      this.nlBase.pop();
      return { k: 'Lambda', params, body: this.expr() };
    }
    if (t.t !== 'nl') {
      this.fail(t, '`,`, `:` or end of line after a Lambda parameter');
    }
    this.endOfStatement();
    const body = this.block(['end']);
    const end = this.expectWord('end');
    // Restore enclosing bracket continuations before peeking past a bare end.
    this.nlBase.pop();
    // The enclosing expression may continue after a bare `end` on its line,
    // but another block's keyword can't.
    const suffix = this.peek(0, 'operator');
    if (
      suffix.line === end.line &&
      this.isWord(suffix, 'given', ...BLOCK_KEYWORDS)
    ) {
      if (!this.isWord(suffix, 'given')) {
        this.fail(suffix, endSuffixExpected('given', at));
      }
      this.next('operator');
    }
    return {
      k: 'LambdaBlock',
      params,
      body,
      end: { line: end.line, col: end.col },
    };
  }

  or(): Node {
    let l = this.and();
    while (this.atOperatorWord('or')) {
      const op = this.next('operator');
      l = this.at(op, { k: 'or', l, r: this.and() });
    }
    return l;
  }

  and(): Node {
    let l = this.not();
    while (
      this.atOperatorWord('and') &&
      !this.isWord(this.la2('and-wait'), 'wait')
    ) {
      const op = this.next('operator');
      l = this.at(op, { k: 'and', l, r: this.not() });
    }
    return l;
  }

  not(): Node {
    if (this.atWord('not')) {
      const op = this.next();
      return this.at(op, { k: 'not', e: this.not() });
    }
    return this.comparison();
  }

  comparison(): Node {
    const l = this.concat();
    const t = this.peek(0, 'operator');
    let node: Node | null = null;
    if (t.t === 'op' && COMPARISONS.has(t.v)) {
      this.next('operator');
      node = { k: t.v, l, r: this.concat() };
    } else if (this.isWord(t, 'is')) {
      this.next('operator');
      let neg = false;
      if (this.atWord('not')) {
        this.next();
        neg = true;
      }
      const u = this.peek(0);
      if (this.isWord(u, 'in')) {
        this.next();
        node = { k: 'is in', neg, l, r: this.concat() };
      } else if (
        this.isWord(u, 'a', 'an') &&
        this.isKindWord(this.la2('is-a', 'operator'))
      ) {
        this.next();
        node = { k: 'is a', neg, l, kind: this.kind() };
      } else if (this.isWord(u, 'empty')) {
        this.next();
        node = { k: 'is empty', neg, l };
      } else {
        node = { k: 'is', neg, l, r: this.concat() };
      }
    } else if (
      this.isWord(t, 'can') &&
      this.isWord(this.la2('can-be', 'operator'), 'be')
    ) {
      this.next('operator');
      this.next('operator');
      if (this.atWord('a', 'an')) {
        this.next();
      }
      node = { k: 'can be', l, kind: this.kind() };
    } else if (this.isWord(t, 'contains', 'matches')) {
      this.next('operator');
      node = { k: t.v, l, r: this.concat() };
    } else if (
      this.isWord(t, 'begins', 'ends') &&
      this.isWord(this.la2('begins-with', 'operator'), 'with')
    ) {
      this.next('operator');
      this.next('operator');
      node = { k: `${t.v} with`, l, r: this.concat() };
    }
    if (!node) {
      return l;
    }
    this.at(t, node);
    if (this.ignoringCase()) {
      node.ignoringCase = true;
    }
    return node;
  }

  concat(): Node {
    let l = this.range();
    while (this.isOp(this.peek(0, 'operator'), '&')) {
      const op = this.next('operator');
      l = this.at(op, { k: '&', l, r: this.range() });
    }
    return l;
  }

  range(): Node {
    const l = this.additive();
    if (this.isOp(this.peek(0, 'operator'), '..')) {
      const op = this.next('operator');
      return this.at(op, { k: '..', l, r: this.additive() });
    }
    return l;
  }

  additive(): Node {
    let l = this.multiplicative();
    for (;;) {
      const t = this.peek(0, 'operator');
      if (!this.isOp(t, '+', '-')) {
        return l;
      }
      this.next('operator');
      l = this.at(t, { k: t.v, l, r: this.multiplicative() });
    }
  }

  multiplicative(): Node {
    let l = this.power();
    for (;;) {
      const t = this.peek(0, 'operator');
      if (!(this.isOp(t, '*', '/') || this.isWord(t, 'mod', 'div'))) {
        return l;
      }
      this.next('operator');
      l = this.at(t, { k: t.v, l, r: this.power() });
    }
  }

  power(): Node {
    const l = this.unary();
    if (this.isOp(this.peek(0, 'operator'), '^')) {
      const op = this.next('operator');
      return this.at(op, { k: '^', l, r: this.power() });
    }
    return l;
  }

  unary(): Node {
    if (this.isOp(this.peek(0), '-')) {
      const op = this.next();
      return this.at(op, { k: 'neg', e: this.unary() });
    }
    return this.conversion();
  }

  // Postfix `as`: tighter than every binary operator, looser than `of` and `'s`.
  conversion(): Node {
    let e = this.chunkLevel();
    for (;;) {
      if (!this.atOperatorWord('as')) {
        return e;
      }
      if (this.build) {
        // A field type starts with an integer type, or a size: no kind starts
        // with a number, `(` or `^`.
        const n = this.la2('as-in-build', 'type');
        if (INT_TYPES.has(n.v) || n.t === 'num' || this.isOp(n, '(', '^')) {
          return e;
        }
      }
      const op = this.next('operator');
      const t = this.peek(0, 'type');
      e = this.at(op, {
        k: 'as',
        e,
        type:
          t.t === 'unit' || t.t === 'error' ? this.next('type').v : this.kind(),
      });
    }
  }

  // A word that can start a kind: a Name, or `function`, the one Reserved
  // Word that names a kind.
  isKindWord(t: Token): boolean {
    return this.isName(t) || this.isWord(t, 'function');
  }

  // A kind or Unit name: any word but a Reserved Word, `function`, or `civil date`.
  kind(mode: Mode = 'operand'): string {
    const t = this.peek(0, mode);
    if (!this.isKindWord(t)) {
      this.fail(t, 'a kind or Unit');
    }
    if (
      this.isWord(t, 'civil') &&
      this.isWord(
        this.la2('kind', mode === 'operand' ? 'operator' : mode),
        'date',
      )
    ) {
      this.next(mode);
      this.next(mode);
      return 'civil date';
    }
    return this.next(mode).v;
  }

  // A postfix expression, and a `delimited by` for the outermost Chunk
  // Expression of an `of` chain.
  chunkLevel(): Node {
    const e = this.postfix(this.primary());
    if (
      this.atOperatorWord('delimited') &&
      this.isWord(this.la2('delimited-by', 'operator'), 'by')
    ) {
      if (
        !['Chunk', 'OrdinalChunk', 'Property'].includes(e.k) ||
        (e.k === 'Property' &&
          !PLURAL.has(e.key.split(' ')[0]) &&
          e.key !== 'code points')
      ) {
        this.fail(
          this.peek(0, 'operator'),
          'a Chunk Expression before `delimited by`',
        );
      }
      this.next('operator');
      this.next();
      return { ...e, delimiter: this.postfix(this.primary()) };
    }
    return e;
  }

  postfix(e: Node): Node {
    while (this.isOp(this.peek(0, 'operator'), "'s")) {
      const op = this.next('operator');
      const key = this.propertyOrKey("a key after `'s`");
      e = this.at(op, {
        k: PROPERTIES.has(key) ? 'Property' : 'Key',
        key,
        base: e,
      });
    }
    return e;
  }

  // After `'s` or `the`: any word, Reserved Words included, or `code points`.
  propertyOrKey(what: string): string {
    const t = this.peek(0);
    if (t.t !== 'word') {
      this.fail(t, what);
    }
    if (
      this.isWord(t, 'code') &&
      this.isWord(this.la2('code-point', 'operator'), 'points')
    ) {
      this.next();
      this.next();
      return 'code points';
    }
    return this.next().v;
  }

  call(name: string): Node {
    this.next('operator'); // the `(` straight after the name
    const args: Node[] = [];
    if (!this.isOp(this.peek(0), ')')) {
      args.push(...this.nested(() => this.exprList()));
    }
    this.expectOp(')');
    return { k: 'Call', fn: name, args };
  }

  // Brackets end a build value, so `as uint16` inside them is a conversion.
  nested<T>(f: () => T): T {
    const b = this.build;
    this.build = 0;
    try {
      return f();
    } finally {
      this.build = b;
    }
  }

  // After a chunk word: does the next token start its index?
  startsIndex(t: Token): boolean {
    if (t.t === 'num' || t.t === 'str') {
      return true;
    }
    if (t.t === 'op') {
      return ['-', '[', '('].includes(t.v) && !(t.v === '(' && !t.spaceBefore);
    }
    return (
      t.t === 'word' &&
      (this.isName(t) || ['the', 'it', 'me'].includes(t.v)) &&
      !FOLLOW.has(t.v)
    );
  }

  primary(): Node {
    const t = this.peek(0);
    return this.at(t, this.primaryAt(t));
  }

  primaryAt(t: Token): Node {
    switch (t.t) {
      case 'num': {
        this.next();
        const u = this.peek(0, 'unit');
        if (u.t === 'unit' || u.t === 'error') {
          return { k: 'Quantity', n: t.v, unit: this.next('unit').v };
        }
        return { k: 'Num', v: t.v };
      }
      case 'str':
        this.next();
        return { k: 'Text', v: t.v };
      case 'patopen':
        this.next();
        return this.textPattern();
      case 'binopen':
        this.next();
        return this.binaryBuild();
      case 'op':
        if (t.v === '(') {
          this.next();
          const e = this.nested(() => this.expr());
          this.expectOp(')');
          return { k: 'Group', e };
        }
        if (t.v === '[') {
          return this.listLiteral();
        }
        if (t.v === '{') {
          return this.mapLiteral();
        }
        if (t.v === '^' && this.size) {
          this.next();
          return { k: 'Pin', name: this.name() };
        }
        return this.fail(t, 'an expression');
      case 'word':
        return this.wordPrimary(t);
    }
    this.fail(t, 'an expression');
  }

  wordPrimary(t: Token): Node {
    const w = t.v;
    if (['true', 'false', 'nothing', 'it', 'me'].includes(w)) {
      this.next();
      return { k: 'Const', v: w };
    }
    if (w === 'the') {
      return this.the();
    }
    if (w === 'replace') {
      return this.replace(false);
    }
    if (!this.isName(t)) {
      this.fail(t, 'an expression');
    }
    if (w === 'every') {
      if (this.isWord(this.la2('every-match', 'operator'), 'match')) {
        this.next();
        this.next();
        this.expectWord('of', 'operator');
        const pat = this.chunkLevel();
        this.expectWord('in', 'operator');
        return { k: 'MatchSearch', pat, src: this.concat() };
      }
    } else if (w === 'code') {
      const n = this.la2('code-point', 'operator');
      if (this.isWord(n, 'point', 'points')) {
        this.next();
        this.next();
        return this.chunk(n.v === 'point' ? 'code point' : 'code points');
      }
    } else if (SINGULAR.has(w) || PLURAL.has(w)) {
      if (this.startsIndex(this.la2('chunk-word', 'operator'))) {
        this.next();
        return this.chunk(w);
      }
    }
    this.next();
    const p = this.peek(0, 'operator');
    if (this.isOp(p, '(') && !p.spaceBefore) {
      return this.call(w);
    }
    return { k: 'Name', name: w };
  }

  // `item 2 of x`, `characters 2..4 of w`
  chunk(kind: string): Node {
    const index = this.range();
    this.expectWord('of', 'operator');
    return { k: 'Chunk', kind, index, of: this.postfix(this.primary()) };
  }

  the(): Node {
    this.next();
    const t = this.peek(0);
    if (this.isOp(t, '(')) {
      this.next();
      const key = this.nested(() => this.expr());
      this.expectOp(')');
      this.expectWord('of', 'operator');
      return {
        k: 'Key',
        key,
        computed: true,
        base: this.postfix(this.primary()),
      };
    }
    if (t.t === 'str') {
      this.next();
      this.expectWord('of', 'operator');
      return { k: 'Key', key: t.v, base: this.postfix(this.primary()) };
    }
    if (this.isWord(t, 'target') || ORDINALS.has(t.v)) {
      const n = this.la2(t.v === 'target' ? 'target' : 'ordinal', 'operator');
      if (t.v === 'target' && !this.isWord(n, 'of')) {
        this.next();
        return { k: 'Target' };
      }
      if (
        ORDINALS.has(t.v) &&
        this.isWord(n) &&
        (SINGULAR.has(n.v) || n.v === 'code')
      ) {
        this.next();
        let kind = this.next().v;
        if (kind === 'code') {
          this.expectWord('point');
          kind = 'code point';
        }
        this.expectWord('of', 'operator');
        return {
          k: 'OrdinalChunk',
          ord: t.v,
          kind,
          of: this.postfix(this.primary()),
        };
      }
    }
    const key = this.propertyOrKey('a key or property name');
    this.expectWord('of', 'operator');
    return {
      k: PROPERTIES.has(key) ? 'Property' : 'Key',
      key,
      base: this.postfix(this.primary()),
    };
  }

  listLiteral(): Node {
    this.next();
    const items: Node[] = [];
    if (!this.isOp(this.peek(0), ']')) {
      do {
        if (items.length) {
          this.next('operator');
        }
        if (this.isOp(this.peek(0), '...')) {
          this.next();
          items.push({ k: 'Spread', e: this.nested(() => this.expr()) });
        } else {
          items.push(this.nested(() => this.expr()));
        }
      } while (this.isOp(this.peek(0, 'operator'), ','));
    }
    this.expectOp(']');
    return { k: 'List', items };
  }

  // A word or text followed by `:` is a key, Reserved Words included.
  mapKey(): string {
    const t = this.peek(0);
    if (
      (t.t === 'word' || t.t === 'str') &&
      this.isOp(this.la2('map-key', 'operator'), ':')
    ) {
      this.next();
      this.next('operator');
      return t.v;
    }
    this.fail(t, 'a key and `:`');
  }

  mapLiteral(): Node {
    this.next();
    const entries: Node[] = [];
    if (!this.isOp(this.peek(0), '}')) {
      do {
        if (entries.length) {
          this.next('operator');
        }
        const key = this.mapKey();
        entries.push({
          k: 'Entry',
          key,
          value: this.nested(() => this.expr()),
        });
      } while (this.isOp(this.peek(0, 'operator'), ','));
    }
    this.expectOp('}');
    return { k: 'Map', entries };
  }

  // ---------------------------------------------------------------- Destructuring

  pattern(): Node {
    const t = this.peek(0);
    let p = this.at(t, this.patternPrimary());
    if (this.atOperatorWord('as')) {
      this.next('operator');
      p = { k: 'BindAs', p, name: this.name('a name after `as`') };
    }
    return p;
  }

  patternPrimary(): Node {
    const t = this.peek(0);
    if (this.isOp(t, '[')) {
      this.next();
      const items: Node[] = [];
      if (!this.isOp(this.peek(0), ']')) {
        do {
          if (items.length) {
            this.next('operator');
          }
          if (this.isOp(this.peek(0), '...')) {
            this.next();
            const n = this.peek(0);
            items.push({
              k: 'Rest',
              name: this.isName(n) ? this.next().v : null,
            });
          } else {
            items.push(this.pattern());
          }
        } while (this.isOp(this.peek(0, 'operator'), ','));
      }
      this.expectOp(']');
      return { k: 'ListPattern', items };
    }
    if (this.isOp(t, '{')) {
      this.next();
      const entries: Node[] = [];
      if (!this.isOp(this.peek(0), '}')) {
        do {
          if (entries.length) {
            this.next('operator');
          }
          const k = this.peek(0);
          if (
            k.t === 'word' &&
            !this.isOp(this.la2('map-key', 'operator'), ':')
          ) {
            entries.push({
              k: 'Entry',
              key: this.name('a key'),
              value: { k: 'Bind', name: k.v },
            });
          } else {
            entries.push({
              k: 'Entry',
              key: this.mapKey(),
              value: this.pattern(),
            });
          }
        } while (this.isOp(this.peek(0, 'operator'), ','));
      }
      this.expectOp('}');
      return { k: 'MapPattern', entries };
    }
    if (t.t === 'patopen') {
      this.next();
      return this.textPattern();
    }
    if (t.t === 'binopen') {
      this.next();
      return this.binaryPattern();
    }
    if (this.isOp(t, '^')) {
      this.next();
      return { k: 'Pin', name: this.name() };
    }
    if (t.t === 'str') {
      this.next();
      return { k: 'Literal', v: t };
    }
    if (this.isOp(t, '-') || t.t === 'num') {
      const neg = this.isOp(t, '-');
      if (neg) {
        this.next();
      }
      const n = this.peek(0);
      if (n.t !== 'num') {
        this.fail(n, 'a number');
      }
      this.next();
      const u = this.peek(0, 'unit');
      return {
        k: 'Literal',
        neg,
        v: n.v,
        unit: u.t === 'unit' || u.t === 'error' ? this.next('unit').v : null,
      };
    }
    if (this.isWord(t, 'true', 'false', 'nothing')) {
      this.next();
      return { k: 'Literal', v: t.v };
    }
    if (this.isWord(t, '_')) {
      this.next();
      return { k: 'Wildcard' };
    }
    if (this.isName(t)) {
      this.next();
      return { k: 'Bind', name: t.v };
    }
    this.fail(t, 'a pattern');
  }

  // ---------------------------------------------------------------- Text Patterns

  textPattern(): Node {
    const els: Node[] = [];
    if (this.peek(0, 'pattern').t !== 'patclose') {
      els.push(this.patAlt());
      while (this.isOp(this.peek(0, 'pattern'), ',')) {
        this.next('pattern');
        els.push(this.patAlt());
      }
    }
    const c = this.peek(0, 'pattern');
    if (c.t !== 'patclose') {
      this.fail(c, '`,` or `>`');
    }
    this.next('pattern');
    return { k: 'TextPattern', els };
  }

  patAlt(): Node {
    let l = this.patPost();
    while (this.isWord(this.peek(0, 'pattern'), 'or')) {
      this.next('pattern');
      l = { k: 'or', l, r: this.patPost() };
    }
    return l;
  }

  patPost(): Node {
    let e = this.patAtom();
    for (;;) {
      const t = this.peek(0, 'pattern');
      if (this.isWord(t, 'as')) {
        this.next('pattern');
        e = { k: 'as', e, type: this.kind('pattern') };
      } else if (this.isWord(t, 'lazily')) {
        this.next('pattern');
        e = { k: 'lazily', e };
      } else if (this.ignoringCase('pattern')) {
        e = { k: 'ignoring case', e };
      } else {
        return e;
      }
    }
  }

  patAtom(): Node {
    const t = this.peek(0, 'pattern');
    if (t.t === 'str') {
      this.next('pattern');
      return { k: 'Text', v: t.v };
    }
    if (t.t === 'num') {
      this.next('pattern');
      return { k: 'Count', n: t.v, e: this.patAtom() };
    }
    if (t.t === 'patopen') {
      this.next('pattern');
      return { ...this.textPattern(), k: 'Group' };
    }
    if (this.isOp(t, '(')) {
      this.next('pattern');
      const e = this.nested(() => this.expr());
      this.expectOp(')');
      return { k: 'Splice', e };
    }
    if (t.t !== 'word') {
      this.fail(t, 'a Text Pattern element');
    }
    const n = this.la2('capture', 'pattern');
    if (this.isOp(n, ':')) {
      if (!this.isName(t)) {
        this.fail(t, "a Capture name (a Reserved Word can't name one)");
      }
      this.next('pattern');
      this.next('pattern');
      return {
        k: 'Capture',
        name: t.v,
        e: this.patAlt(),
        line: t.line,
        col: t.col,
      };
    }
    if (ANCHORS.has(t.v) && this.isWord(n) && ANCHORS.get(t.v)!.has(n.v)) {
      this.site = 'pattern-anchor';
      this.stats.sites.set(
        'pattern-anchor',
        (this.stats.sites.get('pattern-anchor') ?? 0) + 1,
      );
      this.next('pattern');
      this.next('pattern');
      return { k: 'Anchor', v: `${t.v} ${n.v}` };
    }
    if (PAT_CLASSES.has(t.v)) {
      this.next('pattern');
      const c = this.peek(0, 'pattern');
      if (!(this.isWord(c) && PAT_CLASSES.get(t.v)!.has(c.v))) {
        this.fail(c, `\`letter\` or \`letters\` after \`${t.v}\``);
      }
      this.next('pattern');
      return { k: 'Class', v: `${t.v} ${c.v}` };
    }
    if (this.isWord(t, 'one', 'zero')) {
      this.next('pattern');
      this.expectWord('or', 'pattern');
      this.expectWord('more', 'pattern');
      this.expectWord('of', 'pattern');
      return { k: `${t.v} or more of`, e: this.patAtom() };
    }
    if (this.isWord(t, 'optional')) {
      this.next('pattern');
      return { k: 'optional', e: this.patAtom() };
    }
    if (this.isWord(t, 'a', 'an')) {
      this.next('pattern');
      return { k: 'Typed', kind: this.kind('pattern') };
    }
    if (PAT_KEYWORDS.has(t.v)) {
      this.next('pattern');
      return { k: 'Keyword', v: t.v };
    }
    this.fail(
      t,
      'a Text Pattern element, a Capture (`name:`) or a splice (`(…)`)',
    );
  }

  // ---------------------------------------------------------------- Binary Patterns

  binaryPattern(): Node {
    const fields: Node[] = [];
    if (!this.isOp(this.peek(0, 'operator'), '>>')) {
      do {
        if (fields.length) {
          this.next('operator');
        }
        fields.push(this.binaryField());
      } while (this.isOp(this.peek(0, 'operator'), ','));
    }
    this.expectOp('>>');
    return { k: 'BinaryPattern', fields };
  }

  binaryField(): Node {
    const t = this.peek(0);
    return this.at(t, this.binaryFieldAt(t));
  }

  binaryFieldAt(t: Token): Node {
    if (this.isOp(t, '...')) {
      this.next();
      const n = this.peek(0, 'operator');
      const name =
        this.isName(n) && n.v !== 'as' ? this.next('operator').v : null;
      return { k: 'Rest', name, asText: this.asText() };
    }
    if (t.t === 'num' || t.t === 'str') {
      this.next();
      return { k: 'Literal', v: t.v };
    }
    if (
      t.t === 'word' &&
      this.isOp(this.la2('binary-field', 'operator'), ':')
    ) {
      if (!this.isName(t) && t.v !== '_') {
        this.fail(t, 'a field name');
      }
      this.next();
      this.next('operator');
      return { k: 'Field', name: t.v, type: this.binaryType() };
    }
    this.fail(t, 'a Binary Pattern field (`name: type`, a literal or `...`)');
  }

  asText(): boolean {
    if (!this.atOperatorWord('as')) {
      return false;
    }
    this.next('operator');
    this.expectWord('text');
    return true;
  }

  binaryType(): Node {
    const t = this.peek(0);
    if (this.isWord(t) && INT_TYPES.has(t.v)) {
      this.next();
      const o = this.peek(0, 'operator');
      return {
        k: 'Int',
        type: t.v,
        order:
          this.isWord(o) && BYTE_ORDERS.has(o.v)
            ? this.next('operator').v
            : null,
      };
    }
    let size: Node;
    if (t.t === 'num') {
      size = { k: 'Num', v: this.next().v };
    } else if (this.isOp(t, '^')) {
      this.next();
      size = { k: 'Pin', name: this.name() };
    } else if (this.isOp(t, '(')) {
      this.next();
      this.size++;
      try {
        size = this.expr();
      } finally {
        this.size--;
      }
      this.expectOp(')');
    } else if (this.isName(t)) {
      size = { k: 'Name', name: this.next().v };
    } else {
      this.fail(t, 'a field type (`uint16`, `n bytes` or `n bits`)');
    }
    const u = this.peek(0, 'operator');
    if (!(this.isWord(u) && SIZE_UNITS.has(u.v))) {
      this.fail(u, '`bytes` or `bits` after a field size');
    }
    this.next('operator');
    return { k: 'Sized', size, unit: u.v, asText: this.asText() };
  }

  binaryBuild(): Node {
    const fields: Node[] = [];
    // A field starts in operand position, so a nested `<<` opens a build.
    if (!this.isOp(this.peek(0, 'operand'), '>>')) {
      do {
        if (fields.length) {
          this.next('operator');
        }
        this.build++;
        let value: Node;
        try {
          value = this.concat();
        } finally {
          this.build--;
        }
        let type: Node | null = null;
        if (this.atOperatorWord('as')) {
          this.next('operator');
          type = this.binaryType();
        }
        fields.push({ k: 'BuildField', value, type });
      } while (this.isOp(this.peek(0, 'operator'), ','));
    }
    this.expectOp('>>');
    return { k: 'BinaryBuild', fields };
  }
}

export const parse = (
  src: string,
  stats: Stats = newStats(),
): { ast: Node[] | null; error: SyntaxError | null; stats: Stats } => {
  const p = new Parser(src, stats);
  try {
    return { ast: p.source(), error: null, stats };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ast: null, error, stats };
    }
    throw error;
  }
};
