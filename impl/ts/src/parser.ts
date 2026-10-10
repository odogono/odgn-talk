/* eslint require-yield: "off" -- Leaf productions share the same work-stack protocol as suspending productions. */
// Spec chapter 2: predictive parsing, two-token lookahead and no backtracking.
// Production recognition started from tools/grammar; Core tests establish its behavior.
import { grammar } from './generated/syntax';
import type {
  SyntaxElement,
  SyntaxErrorCode,
  SyntaxNode,
  SyntaxRule,
  Trivia,
} from './syntax';
import { Lexer, RESERVED, type Mode, type Token } from './lexer';
import { runTask, type Task } from './tasks';

// Recognition shapes are private. The public tree contains grammar productions
// and their original tokens, including fields the eventual checker must inspect.
type Node = {
  [key: string]: unknown;
  base?: Node;
  col?: number;
  k: string;
  key?: string | Node;
  line?: number;
  of?: Node;
};

export class ParseError extends Error {
  /** A complete Session Entry was followed by additional input. */
  trailingEntry = false;

  constructor(
    readonly tok: Token,
    readonly code: SyntaxErrorCode,
    msg: string,
  ) {
    super(msg);
    this.name = 'ParseError';
  }
}

/** Only the first diagnostic is normative; later ones describe recovery. */
export type RecoveryDiagnostic = { error: ParseError; recovery: boolean };

const words = (list: string[]) => new Set(list.filter(w => !w.includes(' ')));
const SINGULAR = words(grammar.chunk.map(c => c.singular));
const PLURAL = words(grammar.chunk.map(c => c.plural));
const ORDINALS = new Set<string>(grammar.ordinals);
const PROPERTIES = new Set<string>(grammar.properties);
const LABEL_RESERVED = new Set<string>(grammar.labels.reserved);
const LABEL_EXCLUDED = new Set<string>(grammar.labels.excluded);
const FOLLOW = new Set<string>(grammar.follow);
const DECISIONS = new Set<string>(grammar.decision);
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
// The English comparison words (ADR 0075), as the operators they spell.
const ORDERING_WORDS: Record<string, string> = {
  'greater than': '>',
  'less than': '<',
  'at least': '>=',
  'at most': '<=',
};
const NEGATED_WORDS: Record<string, string> = {
  contain: 'contains',
  begin: 'begins with',
  end: 'ends with',
  match: 'matches',
};
// Statement blocks' ending keywords, which never follow a Lambda's `end`.
const BLOCK_KEYWORDS = [
  'if',
  'repeat',
  'match',
  'try',
  'wait',
  'tell',
  'timeout',
];
// The Fallback Handler's name, in its body table and its `pass` (ADR 0064).
const FALLBACK = 'any message';
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
  // The last words of `does not contain`, `does not match`, `is greater
  // than`, `is less than`, `is at least` and `is at most` (ADR 0075).
  'contain',
  'match',
  'than',
  'least',
  'most',
]);

// Chapter 2, Entries: the words that start a declaration, and the Reserved
// Words that start a statement.
const DECLARATION_WORDS = ['on', 'function', 'private', 'use', 'constant'];
const STATEMENT_WORDS = new Set([
  ...BLOCK_KEYWORDS,
  'add',
  'ask',
  'delete',
  'divide',
  'exit',
  'let',
  'multiply',
  'pass',
  'put',
  'replace',
  'return',
  'send',
  'set',
  'subtract',
  'tell',
  'throw',
  'veto',
]);

/** What an Entry is, decided on its first token (chapter 2, Entries). */
export type EntryKind = 'declaration' | 'statement' | 'expression';

type ParseFrame = {
  children: SyntaxElement[];
  rule: SyntaxRule;
  start: number;
};
// Each yield asks the driver to run a child production. Unlike yield*, it
// never delegates through the native stack, so syntax depth has no JS limit.
type ParseTask<T> = Task<T>;

class Parser {
  lx: Lexer;
  tree!: SyntaxNode;
  private frames: ParseFrame[] = [];
  readonly diagnostics: RecoveryDiagnostic[] = [];

  private enter(rule: SyntaxRule, prefix = 0): ParseFrame {
    // Calls and chunks decide their production after consuming its name.
    // Move that prefix into the chosen production, retaining one owner.
    const children = prefix ? this.frames.at(-1)!.children.splice(-prefix) : [];
    const first = children[0];
    const start =
      first?.kind === 'token'
        ? (first.leadingTrivia[0]?.pos ?? first.pos)
        : (first?.start ?? this.offset);
    const frame = { rule, children, start };
    this.frames.push(frame);
    return frame;
  }

  private leave(frame: ParseFrame): void {
    this.frames.pop();
    const node: SyntaxNode = {
      kind: 'node',
      rule: frame.rule,
      children: frame.children,
      start: frame.start,
      end: this.offset,
    };
    if (this.frames.length) {
      this.frames.at(-1)!.children.push(node);
    } else {
      this.tree = node;
    }
  }

  buf: Token[] = [];
  offset = 0; // the source offset after the last consumed token
  prev: Token | null = null;
  brackets: string[] = []; // the open brackets, innermost last
  build = 0; // inside a `<< … >>` build value, where `as uint16` is a field type
  size = 0; // inside a parenthesised Binary Pattern size, where `^n` is allowed
  whoseKeyAt = -1; // the offset of a Whose Clause condition's first token
  // A newline is skipped only while more brackets are open than the top of
  // this stack. A Lambda head and a block Lambda body push their own depth.
  nlBase: number[] = [0];
  site = '';

  constructor(
    src: string | Lexer,
    private readonly recovering = false,
  ) {
    this.lx = typeof src === 'string' ? new Lexer(src) : src;
  }

  private record(error: ParseError): void {
    this.diagnostics.push({ error, recovery: this.diagnostics.length > 0 });
  }

  // Unwind only the failed production. Its partial children and skipped tokens
  // remain lossless under Error, while the caller keeps its grammar context.
  private *recover<T>(
    task: ParseTask<T>,
    expression = false,
  ): ParseTask<T | Node> {
    if (!this.recovering) {
      return (yield task) as T;
    }
    const frame = this.frames.at(-1)!;
    const index = frame.children.length;
    const start = this.offset;
    // A production owns only brackets and newline bases above its entry depth.
    // Save depths rather than copying enclosing stacks at every nested operand.
    const brackets = this.brackets.length;
    const nlBase = this.nlBase.length;
    const { build, size } = this;
    try {
      return (yield task) as T;
    } catch (error) {
      if (!(error instanceof ParseError)) {
        throw error;
      }
      this.record(error);
      const children = frame.children.splice(index);
      // After the first error, scan physical tokens so a broken delimiter or
      // trailing operator cannot swallow the next statement as continuation.
      this.buf = [];
      this.prev = null;
      this.brackets.length = brackets;
      this.nlBase.length = nlBase;
      this.build = build;
      this.size = size;
      let depth = 0;
      for (;;) {
        let token = this.lx.lex(this.offset, 'operand');
        if (token.t === 'error') {
          token = {
            ...token,
            ...this.lx.tok(
              'error',
              token.v,
              this.offset,
              Math.max(this.offset + 1, token.end),
              false,
              'operand',
              token.code,
            ),
          };
        }
        if (token.t === 'eof' || token.t === 'nl') {
          break;
        }
        if (
          expression &&
          depth === 0 &&
          (this.isOp(token, ',', ')', ']', '}', '>>') ||
            this.isWord(
              token,
              'into',
              'after',
              'before',
              'to',
              'be',
              'then',
              'where',
              'in',
              'else',
              'end',
            ))
        ) {
          break;
        }
        children.push(token);
        this.offset = token.end;
        if (this.opens(token)) {
          depth++;
        } else if (this.isOp(token, ')', ']', '}', '>>')) {
          depth = Math.max(0, depth - 1);
        }
      }
      frame.children.push({
        kind: 'node',
        rule: 'Error',
        children,
        start,
        end: this.offset,
      });
      return { k: 'Error' };
    }
  }

  private blockBoundary(t: Token): boolean {
    // Only Reserved Words can stop a statement without changing the first
    // error. `constant`, `use`, `private` and `script` can be command names.
    return (
      t.t === 'eof' ||
      this.isWord(
        t,
        'on',
        'function',
        'else',
        'offer',
        'catch',
        'finally',
        'when',
      )
    );
  }

  private endBlock(name: string, at: Token, line = false): Token {
    const t = this.peek(0);
    // block() already reported the missing ending and left this token to its
    // enclosing block or the source. No invented token enters the tree.
    if (this.recovering && this.blockBoundary(t)) {
      return t;
    }
    const end = this.expectWord('end');
    this.endSuffix(name, at);
    if (line) {
      this.endOfStatement();
    }
    return end;
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
  ): Token {
    const trivia: Trivia[] = [];
    for (;;) {
      const tok = this.lx.lex(start, mode);
      if (
        tok.t === 'nl' &&
        (depth > this.nlBase.at(-1)! || this.continues(before))
      ) {
        trivia.push(...tok.leadingTrivia, {
          kind: 'continuation',
          pos: tok.pos,
          end: tok.end,
          raw: tok.raw,
          line: tok.line,
          col: tok.col,
        });
        start = tok.end;
        continue;
      }
      return { ...tok, leadingTrivia: [...trivia, ...tok.leadingTrivia] };
    }
  }

  peek(k: 0 | 1 | 2, mode: Mode = 'operand'): Token {
    if (k > 1) {
      throw new Error(`a third token of lookahead at ${this.site}`);
    }
    while (this.buf.length <= k) {
      this.fill(this.buf.length, mode);
    }
    // The first request fixes a token's lexical interpretation. Consuming it
    // may use another grammatical position; that never scans source again.
    return this.buf[k]!;
  }

  private depthAt(i: number): number {
    let d = this.brackets.length;
    if (i === 1) {
      const t0 = this.buf[0]!;
      if (this.opens(t0)) {
        d++;
      } else if (this.closes(t0, this.brackets.at(-1))) {
        d--;
      }
    }
    return d;
  }

  private fill(i: number, mode: Mode) {
    const start = i === 0 ? this.offset : this.buf[0]!.end;
    const before = i === 0 ? this.prev : this.buf[0]!;
    this.buf.push(this.lexAt(start, mode, before, this.depthAt(i)));
  }

  next(mode: Mode = 'operand'): Token {
    const t = this.peek(0, mode);
    if (t.t === 'error') {
      this.lexicalFailure(t);
    }
    this.frames.at(-1)!.children.push(t);
    this.buf.shift();
    this.offset = t.end;
    this.prev = { ...t, mode }; // continuation depends on consumption position
    const o = this.opens(t);
    if (o) {
      this.brackets.push(o);
    } else if (this.closes(t, this.brackets.at(-1))) {
      this.brackets.pop();
    }
    return t;
  }

  // Each grammatical decision that reads the second token names its Spec rule.
  la2(site: string, mode: Mode = 'operand'): Token {
    if (!DECISIONS.has(site)) {
      throw new Error(`decision \`${site}\` isn't in grammar.toml`);
    }
    this.site = site;
    return this.peek(1, mode);
  }

  private lexicalFailure(t: Token): never {
    // Fences need their closing margin before decoding. Validate completed
    // holes before reporting a later lexical error found by that lookahead.
    for (const part of t.parts ?? []) {
      const hole = part.hole!;
      const inner = new Parser(this.lx);
      inner.offset = hole.start;
      inner.brackets = ['{'];
      if (inner.peek(0).pos === hole.end) {
        throw new ParseError(
          this.lx.tok('error', '', hole.at, hole.start, false, 'operand'),
          'empty interpolation',
          'empty interpolation',
        );
      }
      runTask(inner.expr());
      if (inner.peek(0, 'operator').pos !== hole.end) {
        inner.fail(inner.peek(0, 'operator'), 'the end of the interpolation');
      }
    }
    throw new ParseError(t, t.code!, t.v);
  }

  fail(t: Token, expected: string): never {
    if (t.t === 'error') {
      this.lexicalFailure(t);
    }
    const got =
      t.t === 'nl'
        ? 'end of line'
        : t.t === 'eof'
          ? 'end of source'
          : `\`${t.v}\``;
    throw new ParseError(
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
  isLabel(t: Token) {
    return (
      t.t === 'word' &&
      (this.isName(t) || LABEL_RESERVED.has(t.v)) &&
      !LABEL_EXCLUDED.has(t.v)
    );
  }
  label(): string {
    const frame = this.enter('Label');
    // A label is not a continuing expression operator, even when spelled `mod`.
    try {
      return this.next('operand').v;
    } finally {
      this.leave(frame);
    }
  }
  selector(name: string, labels: string[]): string {
    return labels.length ? `${[name, ...labels].join(':')}:` : name;
  }
  *labelled(
    item: () => ParseTask<Node>,
    labels: string[],
    items: Node[],
  ): ParseTask<void> {
    while (this.isLabel(this.peek(0, 'operator'))) {
      labels.push(this.label());
      items.push((yield item()) as Node);
    }
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
  *name(what = 'a name', mode: Mode = 'operand'): ParseTask<string> {
    const frame = this.enter('Name');
    try {
      const t = this.peek(0, mode);
      if (!this.isName(t)) {
        this.fail(t, what);
      }
      return this.next(mode).v;
    } finally {
      this.leave(frame);
    }
  }
  // A Handler, message or event name: any name but `all` (a Join).
  *messageName(what: string): ParseTask<string> {
    const frame = this.enter('MessageName');
    try {
      const t = this.peek(0);
      if (this.isWord(t, 'all')) {
        this.fail(t, `${what} (\`all\` can't name a message)`);
      }
      return (yield this.name(what)) as string;
    } finally {
      this.leave(frame);
    }
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
    // A Fallback Handler's end names it in full, and closes nothing else.
    if (name === FALLBACK) {
      if (!this.atAnyMessage()) {
        this.fail(t, endSuffixExpected(name, at));
      }
      this.next();
      this.next();
      return;
    }
    if (!this.isWord(t, name)) {
      this.fail(t, endSuffixExpected(name, at));
    }
    this.next();
  }

  // `any message` after `on`, `pass` or a Handler's `end` names the Fallback
  // Handler; otherwise `any` is a Name (ADR 0064).
  atAnyMessage(): boolean {
    return (
      this.atWord('any') && this.isWord(this.la2('any-message'), 'message')
    );
  }

  // Can this token, in operand position, start an expression?
  startsExpr(t: Token): boolean {
    if (['num', 'str', 'template', 'patopen', 'binopen'].includes(t.t)) {
      return true;
    }
    if (t.t === 'op') {
      return ['(', '[', '{', '-'].includes(t.v);
    }
    return t.t === 'word' && (this.isName(t) || OPERAND_WORDS.has(t.v));
  }

  // ---------------------------------------------------------------- top level

  *source(): ParseTask<Node[]> {
    const frame = this.enter('Source');
    try {
      const out: Node[] = [];
      this.skipNL();
      while (this.peek(0).t !== 'eof') {
        out.push((yield this.recover(this.declaration())) as Node);
        this.skipNL();
      }
      this.next(); // EOF owns any trailing trivia.
      return out;
    } finally {
      this.leave(frame);
    }
  }

  // An Entry at a Session prompt. A Name starts a Command Call only if it
  // names one of the Session Script's Handlers, or is `say`.
  *entry(isHandler: (name: string) => boolean): ParseTask<EntryKind | null> {
    const frame = this.enter('Entry');
    let complete = false;
    try {
      this.skipNL();
      const t = this.peek(0);
      let kind: EntryKind | null = null;
      if (t.t === 'eof') {
        // Nothing but blank lines and comments.
      } else if (
        this.isWord(t, ...DECLARATION_WORDS) ||
        (this.isWord(t, 'script') &&
          this.isWord(this.la2('script-variable'), 'variable'))
      ) {
        kind = 'declaration';
        yield this.declaration();
      } else if (
        t.t === 'word' &&
        (STATEMENT_WORDS.has(t.v) ||
          (t.v === 'next' && this.isWord(this.la2('next-repeat'), 'repeat')) ||
          (t.v === 'with' &&
            this.isWord(this.la2('with-timeout'), 'timeout')) ||
          (this.isName(t) && (t.v === 'say' || isHandler(t.v))))
      ) {
        kind = 'statement';
        yield this.statement();
        complete = true;
        this.endOfStatement();
      } else {
        kind = 'expression';
        yield this.expr();
        complete = true;
        this.endOfStatement();
      }
      complete = true;
      this.skipNL();
      const end = this.peek(0);
      if (end.t !== 'eof') {
        this.fail(end, 'the end of the Entry');
      }
      this.next(); // EOF owns any trailing trivia.
      return kind;
    } catch (error) {
      if (error instanceof ParseError) {
        error.trailingEntry = complete;
      }
      throw error;
    } finally {
      this.leave(frame);
    }
  }

  *declaration(): ParseTask<Node> {
    const frame = this.enter('Declaration');
    try {
      const t = this.peek(0);
      if (this.isWord(t, 'private')) {
        this.next();
        const u = this.peek(0);
        if (!this.isWord(u, 'on', 'function', 'constant')) {
          this.fail(u, '`on`, `function` or `constant` after `private`');
        }
        return { ...((yield this.declaration()) as Node), private: true };
      }
      if (this.isWord(t, 'on')) {
        return (yield this.handler()) as Node;
      }
      if (this.isWord(t, 'function')) {
        return (yield this.func()) as Node;
      }
      if (this.isWord(t, 'use')) {
        return (yield this.use()) as Node;
      }
      if (this.isWord(t, 'constant')) {
        this.next();
        const name = (yield this.name('a Constant name')) as string;
        this.expectOp('=');
        const value = (yield this.expr()) as Node;
        this.endOfStatement();
        return { k: 'Constant', name, value };
      }
      if (
        this.isWord(t, 'script') &&
        this.isWord(this.la2('script-variable'), 'variable')
      ) {
        this.next();
        this.next();
        const name = (yield this.name('a Script Variable name')) as string;
        let init: Node | null = null;
        if (this.isOp(this.peek(0, 'operator'), '=')) {
          this.next('operator');
          init = (yield this.expr()) as Node;
        }
        this.endOfStatement();
        return { k: 'ScriptVariable', name, init };
      }
      this.fail(
        t,
        '`on`, `function`, `script variable`, `constant`, `use` or `private`',
      );
    } finally {
      this.leave(frame);
    }
  }

  *use(): ParseTask<Node> {
    const frame = this.enter('Use');
    try {
      this.next();
      const names = [(yield this.name('an imported name')) as string];
      while (this.isOp(this.peek(0, 'operator'), ',')) {
        this.next('operator');
        names.push((yield this.name('an imported name')) as string);
      }
      this.expectWord('from', 'operator');
      const library = (yield this.name('a Library name')) as string;
      let rename: string | null = null;
      // `as` renames, so it follows a single imported name only.
      if (names.length === 1 && this.atOperatorWord('as')) {
        this.next('operator');
        rename = (yield this.name('a name after `as`')) as string;
      }
      this.endOfStatement();
      return { k: 'Use', names, library, rename };
    } finally {
      this.leave(frame);
    }
  }

  *handler(): ParseTask<Node> {
    const frame = this.enter('Handler');
    try {
      const on = this.next();
      // `on any message m`: the Fallback Handler, whose head is exactly one
      // pattern. `any` and `message` are leaves of the Handler, which has no
      // MessageName (ADR 0064).
      const fallback = this.atAnyMessage();
      if (fallback) {
        this.next();
        this.next();
      }
      const name = fallback
        ? FALLBACK
        : ((yield this.messageName('a Handler name')) as string);
      const params: Node[] = [];
      let guard: Node | null = null;
      const suffixes: string[] = [];
      let during: string | null = null;
      const t = this.peek(0);
      const labels: string[] = [];
      if (fallback) {
        params.push((yield this.pattern()) as Node);
      } else if (!(
        t.t === 'nl' ||
        t.t === 'eof' ||
        this.isWord(t, 'where') ||
        this.isOp(t, ',')
      )) {
        params.push((yield this.pattern()) as Node);
        yield this.labelled(() => this.pattern(), labels, params);
      }
      // Parameters, then a Guard, then suffixes. After a comma, a suffix word
      // is always a suffix, so it can't be a parameter name there.
      let inParams = params.length > 0 && !fallback;
      let canGuard = true;
      for (;;) {
        const c = this.peek(0, 'operator');
        if (inParams && this.isLabel(c)) {
          this.fail(c, 'an Argument Label after one leading parameter only');
        }
        if (canGuard && this.isWord(c, 'where')) {
          this.next('operator');
          guard = (yield this.expr()) as Node;
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
        } else if (
          this.isWord(w, 'during') &&
          this.isName(this.la2('during'))
        ) {
          this.next();
          during = this.next().v;
          inParams = canGuard = false;
        } else if (inParams && labels.length) {
          this.fail(w, 'a suffix (no commas between labelled parameters)');
        } else if (inParams) {
          params.push((yield this.pattern()) as Node);
        } else {
          this.fail(
            w,
            '`queued`, `dropping`, `replacing`, `deciding` or `during`',
          );
        }
      }
      this.endOfStatement();
      const body = (yield this.block(['end', 'finally'])) as Node[];
      let fin: Node[] | null = null;
      if (this.atWord('finally')) {
        this.next();
        this.endOfStatement();
        fin = (yield this.block(['end'])) as Node[];
      }
      const end = this.endBlock(name, on, true);
      return {
        k: 'Handler',
        fallback,
        name: fallback ? FALLBACK : this.selector(name, labels),
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
    } finally {
      this.leave(frame);
    }
  }

  private *parameter(): ParseTask<{ default: Node | null; name: string }> {
    const frame = this.enter('Parameter');
    try {
      const name = (yield this.name('a parameter name')) as string;
      let dflt: Node | null = null;
      if (this.isOp(this.peek(0, 'operator'), '=')) {
        this.next('operator');
        dflt = (yield this.expr()) as Node;
      }
      return { name, default: dflt };
    } finally {
      this.leave(frame);
    }
  }

  *func(): ParseTask<Node> {
    const frame = this.enter('Function');
    try {
      const fn = this.next();
      const name = (yield this.name('a function name')) as string;
      const params: { default: Node | null; name: string }[] = [];
      if (!this.atEnd('operand')) {
        params.push(
          (yield this.parameter()) as { default: Node | null; name: string },
        );
        while (this.isOp(this.peek(0, 'operator'), ',')) {
          this.next('operator');
          params.push(
            (yield this.parameter()) as { default: Node | null; name: string },
          );
        }
      }
      this.endOfStatement();
      const body = (yield this.block(['end'])) as Node[];
      const end = this.endBlock(name, fn, true);
      return {
        k: 'Function',
        name,
        params,
        body,
        line: fn.line,
        col: fn.col,
        end: { line: end.line, col: end.col },
      };
    } finally {
      this.leave(frame);
    }
  }

  // ---------------------------------------------------------------- statements

  *block(terms: string[]): ParseTask<Node[]> {
    const frame = this.enter('Block');
    try {
      const out: Node[] = [];
      for (;;) {
        this.skipNL();
        const t = this.peek(0);
        if (this.isWord(t) && terms.includes(t.v)) {
          return out;
        }
        if (t.t === 'eof' || (this.recovering && this.blockBoundary(t))) {
          try {
            this.fail(
              t,
              t.t === 'eof'
                ? terms.map(w => `\`${w}\``).join(' or ')
                : 'a statement',
            );
          } catch (error) {
            if (!this.recovering || !(error instanceof ParseError)) {
              throw error;
            }
            this.record(error);
            frame.children.push({
              kind: 'node',
              rule: 'Error',
              children: [],
              start: this.offset,
              end: this.offset,
            });
            return out;
          }
        }
        out.push((yield this.recover(this.statementLine())) as Node);
      }
    } finally {
      this.leave(frame);
    }
  }

  private *statementLine(): ParseTask<Node> {
    const statement = (yield this.statement()) as Node;
    this.endOfStatement();
    return statement;
  }

  // A branch body: a newline and a block, or one simple statement on the line.
  *body(terms: string[]): ParseTask<Node[]> {
    const frame = this.enter('Body');
    try {
      if (this.atEnd()) {
        this.endOfStatement();
        return (yield this.block(terms)) as Node[];
      }
      const s = [(yield this.simpleStatement()) as Node];
      this.endOfStatement();
      return s;
    } finally {
      this.leave(frame);
    }
  }

  *statement(): ParseTask<Node> {
    const frame = this.enter('Statement');
    try {
      const t = this.peek(0);
      if (this.isWord(t, 'if')) {
        return this.at(t, (yield this.ifStatement()) as Node);
      }
      if (this.isWord(t, 'repeat')) {
        return this.at(t, (yield this.repeat()) as Node);
      }
      if (this.isWord(t, 'match')) {
        return this.at(t, (yield this.match()) as Node);
      }
      if (this.isWord(t, 'try')) {
        return this.at(t, (yield this.tryStatement()) as Node);
      }
      if (this.isWord(t, 'wait')) {
        return this.at(t, (yield this.wait(true)) as Node);
      }
      if (this.isWord(t, 'tell')) {
        return (yield this.tell()) as Node;
      }
      if (
        this.isWord(t, 'with') &&
        this.isWord(this.la2('with-timeout'), 'timeout')
      ) {
        return this.at(t, (yield this.timeoutBlock()) as Node);
      }
      return (yield this.simpleStatement()) as Node;
    } finally {
      this.leave(frame);
    }
  }

  // A statement that fits on one line: any but `if`, `repeat`, `match`, `try`
  // and the block forms of `wait for`.
  *simpleStatement(): ParseTask<Node> {
    const frame = this.enter('SimpleStatement');
    try {
      const t = this.peek(0);
      return this.at(t, (yield this.simpleStatementAt(t)) as Node);
    } finally {
      this.leave(frame);
    }
  }

  *simpleStatementAt(t: Token): ParseTask<Node> {
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
        const value = (yield this.expr()) as Node;
        const p = this.peek(0, 'operator');
        const preps = spread
          ? ['after', 'before']
          : ['into', 'after', 'before'];
        if (!this.isWord(p, ...preps)) {
          this.fail(p, preps.map(w => `\`${w}\``).join(' or '));
        }
        this.next('operator');
        return {
          k: 'Put',
          spread,
          value,
          prep: p.v,
          target: (yield this.container()) as Node,
        };
      }
      case 'let': {
        this.next();
        const pat = (yield this.pattern()) as Node;
        this.expectWord('be', 'operator');
        return { k: 'Let', pat, value: (yield this.expr()) as Node };
      }
      case 'set': {
        this.next();
        const target = (yield this.container()) as Node;
        this.expectWord('to', 'operator');
        return { k: 'Set', target, value: (yield this.expr()) as Node };
      }
      case 'add':
      case 'subtract': {
        this.next();
        const value = (yield this.expr()) as Node;
        this.expectWord(t.v === 'add' ? 'to' : 'from', 'operator');
        return { k: t.v, value, target: (yield this.container()) as Node };
      }
      case 'multiply':
      case 'divide': {
        this.next();
        const target = (yield this.container()) as Node;
        this.expectWord('by', 'operator');
        return { k: t.v, target, value: (yield this.expr()) as Node };
      }
      case 'delete':
        this.next();
        return { k: 'Delete', target: (yield this.container()) as Node };
      case 'send':
        return (yield this.send()) as Node;
      case 'ask':
      case 'tell':
        return (yield this.askTell()) as Node;
      case 'wait':
        return (yield this.wait(false)) as Node;
      case 'return':
      case 'veto': {
        this.next();
        return {
          k: t.v,
          value: this.startsExpr(this.peek(0))
            ? ((yield this.expr()) as Node)
            : null,
        };
      }
      case 'pass': {
        this.next();
        // A Fallback Handler's pass (ADR 0064).
        if (this.atAnyMessage()) {
          this.next();
          this.next();
          return { k: 'Pass', name: FALLBACK, fallback: true };
        }
        const name = (yield this.messageName(
          'a message name after `pass`',
        )) as string;
        const labels: string[] = [];
        while (this.isLabel(this.peek(0, 'operator'))) {
          labels.push(this.label());
        }
        return { k: 'Pass', name: this.selector(name, labels) };
      }
      case 'exit':
        this.next();
        this.expectWord('repeat');
        return { k: 'ExitRepeat' };
      case 'throw':
        this.next();
        return { k: 'Throw', value: (yield this.expr()) as Node };
      case 'replace':
        return {
          ...((yield this.replace(true)) as Node),
          k: 'ReplaceStatement',
        };
      case 'choose':
        if (this.isWord(this.la2('choose-offer'), 'offer')) {
          return (yield this.chooseOffer()) as Node;
        }
        break;
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
        call: (yield this.call(name)) as Node,
        wait: (yield this.andWait()) as boolean,
      };
    }
    return {
      ...((yield this.commandPhrase(name)) as Node),
      wait: (yield this.andWait()) as boolean,
    };
  }

  *commandPhrase(name: string): ParseTask<Node> {
    const args: Node[] = [];
    const labels: string[] = [];
    if (this.startsExpr(this.peek(0))) {
      const frame = this.enter('ExpressionList');
      try {
        args.push((yield this.expr()) as Node);
        if (this.isOp(this.peek(0, 'operator'), ',')) {
          while (this.isOp(this.peek(0, 'operator'), ',')) {
            this.next('operator');
            args.push((yield this.expr()) as Node);
          }
        } else {
          yield this.labelled(() => this.expr(), labels, args);
        }
      } finally {
        this.leave(frame);
      }
    }
    return { k: 'Command', name: this.selector(name, labels), args };
  }

  *exprList(): ParseTask<Node[]> {
    const frame = this.enter('ExpressionList');
    try {
      const out = [(yield this.expr()) as Node];
      while (this.isOp(this.peek(0, 'operator'), ',')) {
        this.next('operator');
        out.push((yield this.expr()) as Node);
      }
      return out;
    } finally {
      this.leave(frame);
    }
  }

  // A receiver-last `send`'s `with` list, whose items may spread a list as a
  // list literal's do: a `...` leaf before the item's Expression (ADR 0064).
  *sendList(): ParseTask<Node[]> {
    const frame = this.enter('ExpressionList');
    try {
      const out: Node[] = [];
      do {
        if (out.length) {
          this.next('operator');
        }
        if (this.isOp(this.peek(0), '...')) {
          this.next();
          out.push({ k: 'Spread', e: (yield this.expr()) as Node });
        } else {
          out.push((yield this.expr()) as Node);
        }
      } while (this.isOp(this.peek(0, 'operator'), ','));
      return out;
    } finally {
      this.leave(frame);
    }
  }

  // A Container: a name, or a Chunk Expression or key path rooted in one.
  *container(): ParseTask<Node> {
    const frame = this.enter('Container');
    try {
      const t = this.peek(0);
      if (!this.startsExpr(t)) {
        this.fail(t, 'a Container');
      }
      const e = (yield this.chunkLevel()) as Node;
      let root: Node | undefined = e;
      while (root && root.k !== 'Name') {
        root = root.of ?? root.base;
      }
      if (!root) {
        throw new ParseError(
          t,
          'not a container',
          'a Container is a name, or a chunk or key rooted in one',
        );
      }
      return e;
    } finally {
      this.leave(frame);
    }
  }

  *andWait(): ParseTask<boolean> {
    const frame = this.enter('AndWait');
    try {
      if (
        this.atOperatorWord('and') &&
        this.isWord(this.la2('and-wait'), 'wait')
      ) {
        this.next('operator');
        this.next();
        return true;
      }
      return false;
    } finally {
      this.leave(frame);
    }
  }

  *send(): ParseTask<Node> {
    const frame = this.enter('Send');
    try {
      this.next();
      if (this.atWord('to')) {
        this.next();
        const target = (yield this.expr()) as Node;
        this.expectOp(':');
        const msg = (yield this.messageName('a message name')) as string;
        const phrase = (yield this.commandPhrase(msg)) as Node;
        return {
          k: 'Send',
          msg: phrase.name,
          args: phrase.args,
          target,
          wait: (yield this.andWait()) as boolean,
        };
      }
      // `send (<name>) with …`: a computed message name. `(` can't start a
      // Name, so one token decides (ADR 0057).
      let msg: string | null = null;
      let name: Node | null = null;
      if (this.isOp(this.peek(0), '(')) {
        this.next();
        name = (yield this.nested(() => this.expr())) as Node;
        this.expectOp(')');
      } else {
        msg = (yield this.messageName('a message name')) as string;
      }
      let args: Node[] = [];
      if (this.atWord('with')) {
        this.next();
        args = (yield this.sendList()) as Node[];
      }
      this.expectWord('to', 'operator');
      const target = (yield this.expr()) as Node;
      return {
        k: 'Send',
        msg,
        name,
        args,
        target,
        wait: (yield this.andWait()) as boolean,
      };
    } finally {
      this.leave(frame);
    }
  }

  *askTell(): ParseTask<Node> {
    const frame = this.enter('AskTell');
    try {
      const verb = this.next().v;
      const target = (yield this.expr()) as Node;
      return (yield this.askTellRest(verb, target)) as Node;
    } finally {
      this.leave(frame);
    }
  }

  *askTellRest(verb: string, target: Node): ParseTask<Node> {
    this.expectWord('to', 'operator');
    // The word after `to` is always an Operation name, reserved or not.
    const call = (yield this.operation(verb === 'ask')) as Node;
    return { ...call, k: verb, target };
  }

  // An Operation name, which may be any word, even a Reserved Word, then its
  // arguments, and `and wait` where `waits` allows it.
  *operation(waits: boolean): ParseTask<Node> {
    const t = this.peek(0);
    if (t.t !== 'word' || t.v === '_') {
      this.fail(t, 'an Operation name');
    }
    const op = this.next().v;
    const args = this.startsExpr(this.peek(0))
      ? ((yield this.exprList()) as Node[])
      : [];
    return {
      k: 'Operation',
      op,
      args,
      wait: waits ? ((yield this.andWait()) as boolean) : false,
    };
  }

  // `tell g to op args`, or, where a block may go, a `tell g` block of
  // Operation lines (ADR 0063). `tell` and its receiver are read first, then
  // moved into the production that the next token chooses: `to` gives the
  // one-line form, with its usual SimpleStatement and AskTell nodes, and the
  // end of the line a TellBlock.
  *tell(): ParseTask<Node> {
    const at = this.peek(0);
    this.next();
    const target = (yield this.expr()) as Node;
    if (!this.atEnd()) {
      const simple = this.enter('SimpleStatement', 2);
      try {
        const frame = this.enter('AskTell', 2);
        try {
          return this.at(at, (yield this.askTellRest('tell', target)) as Node);
        } finally {
          this.leave(frame);
        }
      } finally {
        this.leave(simple);
      }
    }
    const frame = this.enter('TellBlock', 2);
    try {
      this.endOfStatement();
      const lines: Node[] = [];
      for (;;) {
        this.skipNL();
        const t = this.peek(0);
        // `end` always closes the block, so it is never an Operation here.
        if (this.isWord(t, 'end')) {
          break;
        }
        if (t.t === 'eof' || (this.recovering && this.blockBoundary(t))) {
          // As block() does, recovery records the missing ending here and
          // leaves the token to the enclosing block or the source.
          try {
            this.fail(t, t.t === 'eof' ? '`end`' : 'an Operation name');
          } catch (error) {
            if (!this.recovering || !(error instanceof ParseError)) {
              throw error;
            }
            this.record(error);
            frame.children.push({
              kind: 'node',
              rule: 'Error',
              children: [],
              start: this.offset,
              end: this.offset,
            });
          }
          break;
        }
        const line = this.enter('OperationLine');
        try {
          lines.push(
            this.at(t, {
              ...((yield this.operation(true)) as Node),
              k: 'OperationLine',
            }),
          );
        } finally {
          this.leave(line);
        }
        this.endOfStatement();
      }
      this.endBlock('tell', at);
      return this.at(at, { k: 'TellBlock', target, lines });
    } finally {
      this.leave(frame);
    }
  }

  // `with timeout of d`, then a block, closed by `end` or `end timeout`
  // (ADR 0073). There is no one-line form.
  *timeoutBlock(): ParseTask<Node> {
    const frame = this.enter('TimeoutBlock');
    try {
      const at = this.next();
      this.next();
      this.expectWord('of');
      const duration = (yield this.expr()) as Node;
      const t = this.peek(0, 'operator');
      if (t.t !== 'nl' && t.t !== 'eof') {
        this.fail(t, 'end of line after the duration of `with timeout of`');
      }
      this.endOfStatement();
      const body = (yield this.block(['end'])) as Node[];
      this.endBlock('timeout', at);
      return { k: 'TimeoutBlock', duration, body };
    } finally {
      this.leave(frame);
    }
  }

  // `wait d`, `wait for ev [or d]`, and, where a block may go, the block
  // `wait for` and the Join.
  *wait(blockAllowed: boolean): ParseTask<Node> {
    const frame = this.enter('Wait');
    try {
      const w = this.next();
      if (!this.atWord('for')) {
        return { k: 'Wait', duration: (yield this.expr()) as Node };
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
        const body = (yield this.block(['end'])) as Node[];
        this.endBlock('wait', w);
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
            const ev = (yield this.event()) as Node;
            let guard: Node | null = null;
            if (this.atOperatorWord('where')) {
              this.next('operator');
              guard = (yield this.expr()) as Node;
            }
            this.expectWord('then', 'operator');
            branches.push({
              ...ev,
              k: 'WhenEvent',
              guard,
              body: (yield this.body(['when', 'after', 'end'])) as Node[],
            });
          } else if (this.isWord(t, 'after')) {
            this.next();
            const d = (yield this.expr()) as Node;
            this.expectWord('then', 'operator');
            branches.push({
              k: 'After',
              duration: d,
              body: (yield this.body(['when', 'after', 'end'])) as Node[],
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
      const ev = (yield this.event()) as Node;
      let timeout: Node | null = null;
      if (this.atOperatorWord('or')) {
        this.next('operator');
        timeout = (yield this.expr()) as Node;
      }
      return { ...ev, k: 'WaitFor', timeout };
    } finally {
      this.leave(frame);
    }
  }

  // `paid {order: o}`, `click from okButton`
  private atEventFrom(): boolean {
    return (
      this.atOperatorWord('from') && this.startsExpr(this.la2('wait-from'))
    );
  }

  *event(): ParseTask<Node> {
    const frame = this.enter('Event');
    try {
      const name = (yield this.messageName('an event name')) as string;
      const pats: Node[] = [];
      const labels: string[] = [];
      let from: Node | null = null;

      const t = this.peek(0);
      if (!(
        t.t === 'nl' ||
        t.t === 'eof' ||
        this.isWord(t, 'where', 'then', 'or') ||
        this.atEventFrom()
      )) {
        pats.push((yield this.pattern()) as Node);
        yield this.labelled(() => this.pattern(), labels, pats);
        while (!labels.length && this.isOp(this.peek(0, 'operator'), ',')) {
          this.next('operator');
          pats.push((yield this.pattern()) as Node);
        }
      }
      if (this.atEventFrom()) {
        this.next('operator');
        // A postfix-level operand, so `… from okButton or 30 s` leaves `or` to the timeout.
        from = (yield this.chunkLevel()) as Node;
      }
      return { k: 'Event', name: this.selector(name, labels), pats, from };
    } finally {
      this.leave(frame);
    }
  }

  *ifStatement(): ParseTask<Node> {
    const frame = this.enter('If');
    try {
      const at = this.next();
      const cond = (yield this.expr()) as Node;
      this.expectWord('then', 'operator');
      if (!this.atEnd()) {
        const then = (yield this.simpleStatement()) as Node;
        let els: Node | null = null;
        if (this.atOperatorWord('else')) {
          this.next('operator');
          els = (yield this.simpleStatement()) as Node;
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
      const then = (yield this.block(['else', 'end'])) as Node[];
      const elses: Node[] = [];
      let els: Node[] | null = null;
      while (this.atWord('else')) {
        this.next();
        if (this.atWord('if')) {
          this.next();
          const c = (yield this.expr()) as Node;
          this.expectWord('then', 'operator');
          this.endOfStatement();
          elses.push({
            k: 'ElseIf',
            cond: c,
            body: (yield this.block(['else', 'end'])) as Node[],
          });
          continue;
        }
        this.endOfStatement();
        els = (yield this.block(['end'])) as Node[];
        break;
      }
      this.endBlock('if', at);
      return { k: 'If', cond, then, elses, else: els, block: true };
    } finally {
      this.leave(frame);
    }
  }

  *repeat(): ParseTask<Node> {
    const frame = this.enter('Repeat');
    try {
      const at = this.next();
      const t = this.peek(0);
      let head: Node;
      if (this.isWord(t, 'for')) {
        this.next();
        this.expectWord('each');
        const pat = (yield this.pattern()) as Node;
        this.expectWord('in', 'operator');
        head = { k: 'ForEach', pat, src: (yield this.expr()) as Node };
      } else if (this.isWord(t, 'while', 'until')) {
        this.next();
        head = { k: t.v, cond: (yield this.expr()) as Node };
      } else if (this.isWord(t, 'forever')) {
        this.next();
        head = { k: 'Forever' };
      } else {
        const n = (yield this.expr()) as Node;
        this.expectWord('times', 'operator');
        head = { k: 'Times', n };
      }
      let collect: Node | null = null;
      if (this.atOperatorWord('collecting')) {
        const clause = this.enter('Collecting');
        try {
          const at = this.next('operator');
          const value = (yield this.expr()) as Node;
          this.expectWord('into', 'operator');
          collect = this.at(at, {
            k: 'Collecting',
            value,
            into: (yield this.name('a name')) as string,
          });
        } finally {
          this.leave(clause);
        }
      }
      this.endOfStatement();
      const body = (yield this.block(['end'])) as Node[];
      this.endBlock('repeat', at);
      return { k: 'Repeat', head, collect, body };
    } finally {
      this.leave(frame);
    }
  }

  *match(): ParseTask<Node> {
    const frame = this.enter('Match');
    try {
      const at = this.next();
      const subject = (yield this.expr()) as Node;
      const ignoringCase = (yield this.ignoringCase()) as boolean;
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
          const pat = (yield this.pattern()) as Node;
          let guard: Node | null = null;
          if (this.atOperatorWord('where')) {
            this.next('operator');
            guard = (yield this.expr()) as Node;
          }
          this.expectWord('then', 'operator');
          branches.push({
            k: 'When',
            search,
            pat,
            guard,
            body: (yield this.body(['when', 'else', 'end'])) as Node[],
            line: wt.line,
            col: wt.col,
          });
        } else if (this.isWord(t, 'else') && !sawElse) {
          this.next();
          sawElse = true;
          branches.push({
            k: 'Else',
            body: (yield this.body(['end'])) as Node[],
          });
        } else if (this.isWord(t, 'end')) {
          this.next();
          this.endSuffix('match', at);
          return { k: 'Match', subject, ignoringCase, branches };
        } else {
          this.fail(
            t,
            sawElse ? '`end match`' : '`when`, `else` or `end match`',
          );
        }
      }
    } finally {
      this.leave(frame);
    }
  }

  *tryStatement(): ParseTask<Node> {
    const frame = this.enter('Try');
    try {
      const at = this.next();
      this.endOfStatement();
      const body = (yield this.block([
        'offer',
        'catch',
        'finally',
        'end',
      ])) as Node[];
      const offers: Node[] = [];
      while (this.atWord('offer')) {
        offers.push((yield this.offerClause()) as Node);
      }
      const catches: Node[] = [];
      while (this.atWord('catch')) {
        const ct = this.next();
        const pat = (yield this.pattern()) as Node;
        let recovery = false;
        if (this.atOperatorWord('before')) {
          yield this.recoveryMarker();
          recovery = true;
        }
        let guard: Node | null = null;
        if (this.atOperatorWord('where')) {
          this.next('operator');
          guard = (yield this.expr()) as Node;
        }
        this.endOfStatement();
        catches.push({
          k: 'Catch',
          recovery,
          pat,
          guard,
          body: (yield this.block(['catch', 'finally', 'end'])) as Node[],
          line: ct.line,
          col: ct.col,
        });
      }
      let fin: Node[] | null = null;
      if (this.atWord('finally')) {
        this.next();
        this.endOfStatement();
        fin = (yield this.block(['end'])) as Node[];
      }
      this.endBlock('try', at);
      return { k: 'Try', body, offers, catches, finally: fin };
    } finally {
      this.leave(frame);
    }
  }

  *offerClause(): ParseTask<Node> {
    const frame = this.enter('OfferClause');
    try {
      this.expectWord('offer');
      const name = (yield this.name()) as string;
      const params: string[] = [];
      if (!['nl', 'eof'].includes(this.peek(0).t)) {
        for (;;) {
          const parameter = this.enter('OfferParameter');
          try {
            params.push((yield this.name()) as string);
          } finally {
            this.leave(parameter);
          }
          if (!this.isOp(this.peek(0, 'operator'), ',')) {
            break;
          }
          this.next('operator');
        }
      }
      this.endOfStatement();
      const body = (yield this.block([
        'offer',
        'catch',
        'finally',
        'end',
      ])) as Node[];
      return { k: 'Offer', name, params, body };
    } finally {
      this.leave(frame);
    }
  }

  *recoveryMarker(): ParseTask<void> {
    const frame = this.enter('RecoveryMarker');
    try {
      this.expectWord('before', 'operator');
      this.expectWord('unwind');
    } finally {
      this.leave(frame);
    }
  }

  *chooseOffer(): ParseTask<Node> {
    const frame = this.enter('ChooseOffer');
    try {
      this.expectWord('choose');
      this.expectWord('offer');
      const name = (yield this.name()) as string;
      let args: Node[] = [];
      const open = this.peek(0, 'operator');
      if (this.isOp(open, '(') && !open.spaceBefore) {
        this.next('operator');
        if (!this.isOp(this.peek(0), ')')) {
          args = (yield this.exprList()) as Node[];
        }
        this.expectOp(')', 'operator');
      }
      return { k: 'ChooseOffer', name, args };
    } finally {
      this.leave(frame);
    }
  }

  // `replace [first] <p> in c with e`. As a statement `c` is a Container.
  *replace(statement: boolean): ParseTask<Node> {
    const frame = this.enter('Replace');
    try {
      this.next();
      let first = false;
      if (
        this.atWord('first') &&
        !this.isWord(this.la2('replace-first'), 'in')
      ) {
        this.next();
        first = true;
      }
      const pat = (yield this.chunkLevel()) as Node;
      this.expectWord('in', 'operator');
      const target = statement
        ? ((yield this.container()) as Node)
        : ((yield this.or()) as Node);
      this.expectWord('with', 'operator');
      const value = statement
        ? ((yield this.expr()) as Node)
        : ((yield this.concat()) as Node);
      return { k: 'Replace', first, pat, target, value };
    } finally {
      this.leave(frame);
    }
  }

  *ignoringCase(mode: Mode = 'operator'): ParseTask<boolean> {
    const frame = this.enter('IgnoringCase');
    try {
      if (
        this.isWord(this.peek(0, mode), 'ignoring') &&
        this.isWord(this.la2('ignoring-case', mode), 'case')
      ) {
        this.next(mode);
        this.next(mode);
        return true;
      }
      return false;
    } finally {
      this.leave(frame);
    }
  }

  // ---------------------------------------------------------------- expressions

  *expr(): ParseTask<Node> {
    const frame = this.enter('Expression');
    try {
      return (yield this.recover(this.expressionValue(), true)) as Node;
    } finally {
      this.leave(frame);
    }
  }

  private *expressionValue(): ParseTask<Node> {
    if (this.atWord('given')) {
      return (yield this.lambda()) as Node;
    }
    // A Whose Clause is a whole Expression, as a Lambda is (ADR 0074): an
    // Every Head is decided at the start of one, and an ordinal Chunk
    // Expression takes `whose` only when it is the whole operand.
    const t = this.peek(0);
    if (this.isWord(t, 'every')) {
      const n = this.la2('every-chunk', 'operator');
      if (this.isWord(n) && (SINGULAR.has(n.v) || n.v === 'code')) {
        const frame = this.enter('Whose');
        try {
          const head = (yield this.everyHead()) as Node;
          const op = this.expectWord('whose', 'operator');
          return this.at(op, {
            ...head,
            k: 'Whose',
            every: true,
            cond: (yield this.whoseCondition()) as Node,
          });
        } finally {
          this.leave(frame);
        }
      }
    }
    const e = (yield this.or()) as Node;
    if (e.k === 'OrdinalChunk' && this.atOperatorWord('whose')) {
      const frame = this.enter('Whose', 1);
      try {
        const op = this.next('operator');
        return this.at(op, {
          k: 'Whose',
          of: e,
          cond: (yield this.whoseCondition()) as Node,
        });
      } finally {
        this.leave(frame);
      }
    }
    return e;
  }

  // `every item of xs`, which a Whose Clause must follow (ADR 0074). The head
  // is the outermost Chunk Expression, so it takes the chain's `delimited by`.
  *everyHead(): ParseTask<Node> {
    const frame = this.enter('EveryHead');
    try {
      this.next();
      let kind = this.next().v;
      if (kind === 'code') {
        this.expectWord('point');
        kind = 'code point';
      }
      this.expectWord('of', 'operator');
      const src = (yield this.postfix()) as Node;
      let delimiter: Node | undefined;
      if (
        this.atOperatorWord('delimited') &&
        this.isWord(this.la2('delimited-by', 'operator'), 'by')
      ) {
        this.next('operator');
        this.next();
        delimiter = (yield this.postfix()) as Node;
      }
      return { k: 'EveryHead', kind, src, delimiter };
    } finally {
      this.leave(frame);
    }
  }

  // A Name operand that is the condition's first token is a Whose Key, a key
  // or property of `it`: `whose amount > 100 GBP` (ADR 0074).
  *whoseCondition(): ParseTask<Node> {
    this.whoseKeyAt = this.peek(0).pos;
    return (yield this.expr()) as Node;
  }

  // `given p1, p2: expr`, or `given p1, p2` at the end of a line, then
  // statements, then `end` with an optional `given`.
  *lambda(): ParseTask<Node> {
    const frame = this.enter('Lambda');
    try {
      const at = this.next();
      return this.at(at, (yield this.lambdaAt(at)) as Node);
    } finally {
      this.leave(frame);
    }
  }

  *lambdaAt(at: Token): ParseTask<Node> {
    this.nlBase.push(this.brackets.length);
    const params: Node[] = [];
    const t0 = this.peek(0);
    if (!(this.isOp(t0, ':') || t0.t === 'nl' || t0.t === 'eof')) {
      params.push((yield this.pattern()) as Node);
      while (this.isOp(this.peek(0, 'operator'), ',')) {
        this.next('operator');
        params.push((yield this.pattern()) as Node);
      }
    }
    const t = this.peek(0, 'operator');
    if (this.isOp(t, ':')) {
      this.next('operator');
      this.nlBase.pop();
      return { k: 'Lambda', params, body: (yield this.expr()) as Node };
    }
    if (t.t !== 'nl') {
      this.fail(t, '`,`, `:` or end of line after a Lambda parameter');
    }
    this.endOfStatement();
    const body = (yield this.block(['end'])) as Node[];
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

  *or(): ParseTask<Node> {
    const frame = this.enter('Or');
    try {
      let l = (yield this.and()) as Node;
      while (this.atOperatorWord('or')) {
        const op = this.next('operator');
        l = this.at(op, { k: 'or', l, r: (yield this.and()) as Node });
      }
      return l;
    } finally {
      this.leave(frame);
    }
  }

  *and(): ParseTask<Node> {
    const frame = this.enter('And');
    try {
      let l = (yield this.not()) as Node;
      while (
        this.atOperatorWord('and') &&
        !this.isWord(this.la2('and-wait'), 'wait')
      ) {
        const op = this.next('operator');
        l = this.at(op, { k: 'and', l, r: (yield this.not()) as Node });
      }
      return l;
    } finally {
      this.leave(frame);
    }
  }

  *not(): ParseTask<Node> {
    const frame = this.enter('Not');
    try {
      if (this.atWord('not')) {
        const op = this.next();
        return this.at(op, { k: 'not', e: (yield this.not()) as Node });
      }
      return (yield this.comparison()) as Node;
    } finally {
      this.leave(frame);
    }
  }

  *comparison(): ParseTask<Node> {
    const frame = this.enter('Comparison');
    try {
      const l = (yield this.concat()) as Node;
      const t = this.peek(0, 'operator');
      let node: Node | null = null;
      if (t.t === 'op' && COMPARISONS.has(t.v)) {
        this.next('operator');
        node = { k: t.v, l, r: (yield this.concat()) as Node };
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
          node = { k: 'is in', neg, l, r: (yield this.concat()) as Node };
        } else if (
          this.isWord(u, 'a', 'an') &&
          this.isKindWord(this.la2('is-a', 'operator'))
        ) {
          this.next();
          node = { k: 'is a', neg, l, kind: (yield this.kind()) as string };
        } else if (this.isWord(u, 'empty')) {
          this.next();
          node = { k: 'is empty', neg, l };
        } else if (
          this.isWord(u, 'greater', 'less', 'at') &&
          this.isWord(
            this.la2('ordering-words', 'operator'),
            ...(u.v === 'at' ? ['least', 'most'] : ['than']),
          )
        ) {
          this.next('operator');
          const w = this.next('operator');
          node = {
            k: ORDERING_WORDS[`${u.v} ${w.v}`]!,
            neg,
            l,
            r: (yield this.concat()) as Node,
          };
        } else {
          node = { k: 'is', neg, l, r: (yield this.concat()) as Node };
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
        node = { k: 'can be', l, kind: (yield this.kind()) as string };
      } else if (this.isWord(t, 'contains', 'matches')) {
        this.next('operator');
        node = { k: t.v, l, r: (yield this.concat()) as Node };
      } else if (
        this.isWord(t, 'begins', 'ends') &&
        this.isWord(this.la2('begins-with', 'operator'), 'with')
      ) {
        this.next('operator');
        this.next('operator');
        node = { k: `${t.v} with`, l, r: (yield this.concat()) as Node };
      } else if (
        this.isWord(t, 'comes') &&
        this.isWord(this.la2('comes', 'operator'), 'before', 'after')
      ) {
        this.next('operator');
        const w = this.next('operator');
        node = {
          k: w.v === 'before' ? '<' : '>',
          l,
          r: (yield this.concat()) as Node,
        };
      } else if (
        this.isWord(t, 'does') &&
        this.isWord(this.la2('does-not', 'operator'), 'not')
      ) {
        this.next('operator');
        this.next('operator');
        const w = this.peek(0, 'operator');
        if (!this.isWord(w, 'contain', 'begin', 'end', 'match')) {
          this.fail(w, '`contain`, `begin with`, `end with` or `match`');
        }
        this.next('operator');
        if (w.v === 'begin' || w.v === 'end') {
          this.expectWord('with', 'operator');
        }
        node = {
          k: NEGATED_WORDS[w.v]!,
          neg: true,
          l,
          r: (yield this.concat()) as Node,
        };
      }
      if (!node) {
        return l;
      }
      this.at(t, node);
      if ((yield this.ignoringCase()) as boolean) {
        node.ignoringCase = true;
      }
      return node;
    } finally {
      this.leave(frame);
    }
  }

  *concat(): ParseTask<Node> {
    const frame = this.enter('Concat');
    try {
      let l = (yield this.range()) as Node;
      while (this.isOp(this.peek(0, 'operator'), '&')) {
        const op = this.next('operator');
        l = this.at(op, { k: '&', l, r: (yield this.range()) as Node });
      }
      return l;
    } finally {
      this.leave(frame);
    }
  }

  *range(): ParseTask<Node> {
    const frame = this.enter('Range');
    try {
      const l = (yield this.additive()) as Node;
      if (this.isOp(this.peek(0, 'operator'), '..')) {
        const op = this.next('operator');
        return this.at(op, { k: '..', l, r: (yield this.additive()) as Node });
      }
      return l;
    } finally {
      this.leave(frame);
    }
  }

  *additive(): ParseTask<Node> {
    const frame = this.enter('Additive');
    try {
      let l = (yield this.multiplicative()) as Node;
      for (;;) {
        const t = this.peek(0, 'operator');
        if (!this.isOp(t, '+', '-')) {
          return l;
        }
        this.next('operator');
        l = this.at(t, { k: t.v, l, r: (yield this.multiplicative()) as Node });
      }
    } finally {
      this.leave(frame);
    }
  }

  *multiplicative(): ParseTask<Node> {
    const frame = this.enter('Multiplicative');
    try {
      let l = (yield this.power()) as Node;
      for (;;) {
        const t = this.peek(0, 'operator');
        if (!(this.isOp(t, '*', '/') || this.isWord(t, 'mod', 'div'))) {
          return l;
        }
        this.next('operator');
        l = this.at(t, { k: t.v, l, r: (yield this.power()) as Node });
      }
    } finally {
      this.leave(frame);
    }
  }

  *power(): ParseTask<Node> {
    const frame = this.enter('Power');
    try {
      const l = (yield this.unary()) as Node;
      if (this.isOp(this.peek(0, 'operator'), '^')) {
        const op = this.next('operator');
        return this.at(op, { k: '^', l, r: (yield this.power()) as Node });
      }
      return l;
    } finally {
      this.leave(frame);
    }
  }

  *unary(): ParseTask<Node> {
    const frame = this.enter('Unary');
    try {
      if (this.isOp(this.peek(0), '-')) {
        const op = this.next();
        return this.at(op, { k: 'neg', e: (yield this.unary()) as Node });
      }
      return (yield this.conversion()) as Node;
    } finally {
      this.leave(frame);
    }
  }

  // Postfix `as`: tighter than every binary operator, looser than `of` and `'s`.
  *conversion(): ParseTask<Node> {
    const frame = this.enter('Conversion');
    try {
      let e = (yield this.chunkLevel()) as Node;
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
            t.t === 'unit' || t.t === 'error'
              ? this.next('type').v
              : ((yield this.kind()) as string),
        });
      }
    } finally {
      this.leave(frame);
    }
  }

  // A word that can start a kind: a Name, or `function`, the one Reserved
  // Word that names a kind.
  isKindWord(t: Token): boolean {
    return this.isName(t) || this.isWord(t, 'function');
  }

  // A kind or Unit name: any word but a Reserved Word, `function`, or `civil date`.
  *kind(mode: Mode = 'operand'): ParseTask<string> {
    const frame = this.enter('Kind');
    try {
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
    } finally {
      this.leave(frame);
    }
  }

  // A postfix expression, and a `delimited by` for the outermost Chunk
  // Expression of an `of` chain.
  *chunkLevel(): ParseTask<Node> {
    const frame = this.enter('ChunkLevel');
    try {
      const e = (yield this.postfix()) as Node;
      if (
        this.atOperatorWord('delimited') &&
        this.isWord(this.la2('delimited-by', 'operator'), 'by')
      ) {
        if (
          !['Chunk', 'OrdinalChunk', 'Property'].includes(e.k) ||
          (e.k === 'Property' &&
            !(typeof e.key === 'string' && PLURAL.has(e.key.split(' ')[0]!)) &&
            e.key !== 'code points')
        ) {
          this.fail(
            this.peek(0, 'operator'),
            'a Chunk Expression before `delimited by`',
          );
        }
        this.next('operator');
        this.next();
        return { ...e, delimiter: (yield this.postfix()) as Node };
      }
      return e;
    } finally {
      this.leave(frame);
    }
  }

  *postfix(): ParseTask<Node> {
    const frame = this.enter('Postfix');
    try {
      let e = (yield this.primary()) as Node;
      while (this.isOp(this.peek(0, 'operator'), "'s")) {
        const op = this.next('operator');
        const key = (yield this.propertyOrKey("a key after `'s`")) as string;
        e = this.at(op, {
          k: PROPERTIES.has(key) ? 'Property' : 'Key',
          key,
          base: e,
        });
      }
      return e;
    } finally {
      this.leave(frame);
    }
  }

  // After `'s` or `the`: any word, Reserved Words included, or `code points`.
  *propertyOrKey(what: string): ParseTask<string> {
    const frame = this.enter('Key');
    try {
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
    } finally {
      this.leave(frame);
    }
  }

  *call(name: string): ParseTask<Node> {
    const frame = this.enter('Call', 1);
    try {
      this.next('operator'); // the `(` straight after the name
      const args: Node[] = [];
      if (!this.isOp(this.peek(0), ')')) {
        args.push(...((yield this.nested(() => this.exprList())) as Node[]));
      }
      this.expectOp(')');
      return { k: 'Call', fn: name, args };
    } finally {
      this.leave(frame);
    }
  }

  // Brackets end a build value, so `as uint16` inside them is a conversion.
  *nested<T>(f: () => ParseTask<T>): ParseTask<T> {
    const b = this.build;
    this.build = 0;
    try {
      return (yield f()) as T;
    } finally {
      this.build = b;
    }
  }

  // After a chunk word: does the next token start its index?
  startsIndex(t: Token): boolean {
    if (t.t === 'num' || t.t === 'str' || t.t === 'template') {
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

  *primary(): ParseTask<Node> {
    const frame = this.enter('Primary');
    try {
      const t = this.peek(0);
      return this.at(t, (yield this.primaryAt(t)) as Node);
    } finally {
      this.leave(frame);
    }
  }

  *primaryAt(t: Token): ParseTask<Node> {
    switch (t.t) {
      case 'num': {
        this.next();
        const u = this.peek(0, 'unit');
        if (u.t === 'unit' || u.t === 'error') {
          return { k: 'Quantity', n: t.v, unit: this.next('unit').v };
        }
        return { k: 'Num', v: t.v };
      }
      case 'template':
        return (yield this.interpolated(t)) as Node;
      case 'str':
        this.next();
        return { k: 'Text', v: t.v };
      case 'patopen':
        return (yield this.textPattern()) as Node;
      case 'binopen':
        return (yield this.binaryBuild()) as Node;
      case 'op':
        if (t.v === '(') {
          this.next();
          const e = (yield this.nested(() => this.expr())) as Node;
          this.expectOp(')');
          return { k: 'Group', e };
        }
        if (t.v === '[') {
          return (yield this.listLiteral()) as Node;
        }
        if (t.v === '{') {
          return (yield this.mapLiteral()) as Node;
        }
        if (t.v === '^' && this.size) {
          this.next();
          return { k: 'Pin', name: (yield this.name()) as string };
        }
        return this.fail(t, 'an expression');
      case 'word':
        return (yield this.wordPrimary(t)) as Node;
    }
    this.fail(t, 'an expression');
  }

  *interpolated(t: Token): ParseTask<Node> {
    this.next();
    this.frames.at(-1)!.children.pop();
    const children: SyntaxElement[] = [];
    try {
      let cursor = t.pos;
      for (const [index, part] of t.parts!.entries()) {
        const end = part.hole?.at ?? t.end;
        const literal = this.lx.tok(
          'str',
          part.value,
          cursor,
          end,
          t.spaceBefore,
          'operand',
        );
        if (index === 0) {
          literal.leadingTrivia = t.leadingTrivia;
        }
        children.push(literal);
        if (part.hole) {
          const { at, start, end: holeEnd } = part.hole;
          children.push(this.lx.tok('op', '${', at, start, false, 'operand'));
          const inner = new Parser(this.lx);
          inner.offset = start;
          inner.brackets = ['{'];
          if (inner.peek(0).pos === holeEnd) {
            throw new ParseError(
              this.lx.tok('error', '', at, start, false, 'operand'),
              'empty interpolation',
              'empty interpolation',
            );
          }
          yield inner.expr();
          if (inner.peek(0, 'operator').pos !== holeEnd) {
            inner.fail(
              inner.peek(0, 'operator'),
              'the end of the interpolation',
            );
          }
          children.push(inner.tree);
          cursor = inner.offset;
        }
      }
      this.frames.at(-1)!.children.push({
        kind: 'node',
        rule: 'Interpolated',
        children,
        start: t.leadingTrivia[0]?.pos ?? t.pos,
        end: t.end,
      });
      return { k: 'Interpolated' };
    } catch (error) {
      this.frames.at(-1)!.children.push(t);
      throw error;
    }
  }

  *wordPrimary(t: Token): ParseTask<Node> {
    const w = t.v;
    if (['true', 'false', 'nothing', 'it', 'me'].includes(w)) {
      this.next();
      return { k: 'Const', v: w };
    }
    if (w === 'the') {
      return (yield this.the()) as Node;
    }
    if (w === 'replace') {
      return (yield this.replace(false)) as Node;
    }
    if (!this.isName(t)) {
      this.fail(t, 'an expression');
    }
    if (w === 'every') {
      if (this.isWord(this.la2('every-match', 'operator'), 'match')) {
        this.next();
        this.next();
        this.expectWord('of', 'operator');
        const pat = (yield this.chunkLevel()) as Node;
        this.expectWord('in', 'operator');
        return { k: 'MatchSearch', pat, src: (yield this.concat()) as Node };
      }
    } else if (w === 'code') {
      const n = this.la2('code-point', 'operator');
      if (this.isWord(n, 'point', 'points')) {
        this.next();
        this.next();
        return (yield this.chunk(
          n.v === 'point' ? 'code point' : 'code points',
        )) as Node;
      }
    } else if (SINGULAR.has(w) || PLURAL.has(w)) {
      if (this.startsIndex(this.la2('chunk-word', 'operator'))) {
        this.next();
        return (yield this.chunk(w)) as Node;
      }
    }
    this.next();
    const p = this.peek(0, 'operator');
    if (this.isOp(p, '(') && !p.spaceBefore) {
      return (yield this.call(w)) as Node;
    }
    if (t.pos === this.whoseKeyAt) {
      this.leave(this.enter('WhoseKey', 1));
      return {
        k: PROPERTIES.has(w) ? 'Property' : 'Key',
        key: w,
        base: { k: 'Const', v: 'it' },
      };
    }
    return { k: 'Name', name: w };
  }

  // `item 2 of x`, `characters 2..4 of w`
  *chunk(kind: string): ParseTask<Node> {
    const frame = this.enter('Chunk', kind.startsWith('code ') ? 2 : 1);
    try {
      const index = (yield this.range()) as Node;
      this.expectWord('of', 'operator');
      return { k: 'Chunk', kind, index, of: (yield this.postfix()) as Node };
    } finally {
      this.leave(frame);
    }
  }

  *the(): ParseTask<Node> {
    const frame = this.enter('The');
    try {
      this.next();
      const t = this.peek(0);
      if (this.isOp(t, '(')) {
        this.next();
        const key = (yield this.nested(() => this.expr())) as Node;
        this.expectOp(')');
        this.expectWord('of', 'operator');
        return {
          k: 'Key',
          key,
          computed: true,
          base: (yield this.postfix()) as Node,
        };
      }
      if (t.t === 'str') {
        this.next();
        this.expectWord('of', 'operator');
        return { k: 'Key', key: t.v, base: (yield this.postfix()) as Node };
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
            of: (yield this.postfix()) as Node,
          };
        }
      }
      const key = (yield this.propertyOrKey(
        'a key or property name',
      )) as string;
      this.expectWord('of', 'operator');
      return {
        k: PROPERTIES.has(key) ? 'Property' : 'Key',
        key,
        base: (yield this.postfix()) as Node,
      };
    } finally {
      this.leave(frame);
    }
  }

  *listLiteral(): ParseTask<Node> {
    const frame = this.enter('List');
    try {
      this.next();
      const items: Node[] = [];
      if (!this.isOp(this.peek(0), ']')) {
        do {
          if (items.length) {
            this.next('operator');
          }
          if (this.isOp(this.peek(0), '...')) {
            this.next();
            items.push({
              k: 'Spread',
              e: (yield this.nested(() => this.expr())) as Node,
            });
          } else {
            items.push((yield this.nested(() => this.expr())) as Node);
          }
        } while (this.isOp(this.peek(0, 'operator'), ','));
      }
      this.expectOp(']');
      return { k: 'List', items };
    } finally {
      this.leave(frame);
    }
  }

  // A word or text followed by `:` is a key, Reserved Words included.
  *mapKey(): ParseTask<string> {
    const frame = this.enter('MapKey');
    try {
      const t = this.peek(0);
      if (
        (t.t === 'str' || (t.t === 'word' && t.v !== 'offer')) &&
        this.isOp(this.la2('map-key', 'operator'), ':')
      ) {
        this.next();
        this.next('operator');
        return t.v;
      }
      this.fail(t, 'a key and `:`');
    } finally {
      this.leave(frame);
    }
  }

  *mapLiteral(): ParseTask<Node> {
    const frame = this.enter('Map');
    try {
      this.next();
      const entries: Node[] = [];
      if (!this.isOp(this.peek(0), '}')) {
        do {
          if (entries.length) {
            this.next('operator');
          }
          const key = (yield this.mapKey()) as string;
          entries.push({
            k: 'Entry',
            key,
            value: (yield this.nested(() => this.expr())) as Node,
          });
        } while (this.isOp(this.peek(0, 'operator'), ','));
      }
      this.expectOp('}');
      return { k: 'Map', entries };
    } finally {
      this.leave(frame);
    }
  }

  // ---------------------------------------------------------------- Destructuring

  *pattern(): ParseTask<Node> {
    const frame = this.enter('Pattern');
    try {
      const t = this.peek(0);
      let p = this.at(t, (yield this.patternPrimary()) as Node);
      if (this.atOperatorWord('as')) {
        this.next('operator');
        p = {
          k: 'BindAs',
          p,
          name: (yield this.name('a name after `as`')) as string,
        };
      }
      return p;
    } finally {
      this.leave(frame);
    }
  }

  *patternPrimary(): ParseTask<Node> {
    const frame = this.enter('PatternPrimary');
    try {
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
              items.push((yield this.pattern()) as Node);
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
                key: (yield this.name('a key')) as string,
                value: { k: 'Bind', name: k.v },
              });
            } else {
              entries.push({
                k: 'Entry',
                key: (yield this.mapKey()) as string,
                value: (yield this.pattern()) as Node,
              });
            }
          } while (this.isOp(this.peek(0, 'operator'), ','));
        }
        this.expectOp('}');
        return { k: 'MapPattern', entries };
      }
      if (t.t === 'patopen') {
        return (yield this.textPattern()) as Node;
      }
      if (t.t === 'binopen') {
        return (yield this.binaryPattern()) as Node;
      }
      if (this.isOp(t, '^')) {
        this.next();
        return { k: 'Pin', name: (yield this.name()) as string };
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
    } finally {
      this.leave(frame);
    }
  }

  // ---------------------------------------------------------------- Text Patterns

  *textPattern(): ParseTask<Node> {
    const frame = this.enter('TextPattern');
    try {
      this.next('pattern'); // opening bracket
      const els: Node[] = [];
      if (this.peek(0, 'pattern').t !== 'patclose') {
        els.push((yield this.patAlt()) as Node);
        while (this.isOp(this.peek(0, 'pattern'), ',')) {
          this.next('pattern');
          els.push((yield this.patAlt()) as Node);
        }
      }
      const c = this.peek(0, 'pattern');
      if (c.t !== 'patclose') {
        this.fail(c, '`,` or `>`');
      }
      this.next('pattern');
      return { k: 'TextPattern', els };
    } finally {
      this.leave(frame);
    }
  }

  *patAlt(): ParseTask<Node> {
    const frame = this.enter('Alternation');
    try {
      let l = (yield this.patPost()) as Node;
      while (this.isWord(this.peek(0, 'pattern'), 'or')) {
        this.next('pattern');
        l = { k: 'or', l, r: (yield this.patPost()) as Node };
      }
      return l;
    } finally {
      this.leave(frame);
    }
  }

  *patPost(): ParseTask<Node> {
    const frame = this.enter('Element');
    try {
      let e = (yield this.patAtom()) as Node;
      for (;;) {
        const t = this.peek(0, 'pattern');
        if (this.isWord(t, 'as')) {
          this.next('pattern');
          e = { k: 'as', e, type: (yield this.kind('pattern')) as string };
        } else if (this.isWord(t, 'lazily')) {
          this.next('pattern');
          e = { k: 'lazily', e };
        } else if ((yield this.ignoringCase('pattern')) as boolean) {
          e = { k: 'ignoring case', e };
        } else {
          return e;
        }
      }
    } finally {
      this.leave(frame);
    }
  }

  *patAtom(): ParseTask<Node> {
    const frame = this.enter('Atom');
    try {
      const t = this.peek(0, 'pattern');
      if (t.t === 'str') {
        this.next('pattern');
        return { k: 'Text', v: t.v };
      }
      if (t.t === 'num') {
        this.next('pattern');
        return { k: 'Count', n: t.v, e: (yield this.patAtom()) as Node };
      }
      if (t.t === 'patopen') {
        return { ...((yield this.textPattern()) as Node), k: 'Group' };
      }
      if (this.isOp(t, '(')) {
        this.next('pattern');
        const e = (yield this.nested(() => this.expr())) as Node;
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
          e: (yield this.patAlt()) as Node,
          line: t.line,
          col: t.col,
        };
      }
      if (ANCHORS.has(t.v) && this.isWord(n) && ANCHORS.get(t.v)!.has(n.v)) {
        this.site = 'pattern-anchor';
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
        return { k: `${t.v} or more of`, e: (yield this.patAtom()) as Node };
      }
      if (this.isWord(t, 'optional')) {
        this.next('pattern');
        return { k: 'optional', e: (yield this.patAtom()) as Node };
      }
      if (this.isWord(t, 'a', 'an')) {
        this.next('pattern');
        return { k: 'Typed', kind: (yield this.kind('pattern')) as string };
      }
      if (PAT_KEYWORDS.has(t.v)) {
        this.next('pattern');
        return { k: 'Keyword', v: t.v };
      }
      this.fail(
        t,
        'a Text Pattern element, a Capture (`name:`) or a splice (`(…)`)',
      );
    } finally {
      this.leave(frame);
    }
  }

  // ---------------------------------------------------------------- Binary Patterns

  *binaryPattern(): ParseTask<Node> {
    const frame = this.enter('BinaryPattern');
    try {
      this.next('operand'); // opening bracket
      const fields: Node[] = [];
      if (!this.isOp(this.peek(0, 'operator'), '>>')) {
        do {
          if (fields.length) {
            this.next('operator');
          }
          fields.push((yield this.binaryField()) as Node);
        } while (this.isOp(this.peek(0, 'operator'), ','));
      }
      this.expectOp('>>');
      return { k: 'BinaryPattern', fields };
    } finally {
      this.leave(frame);
    }
  }

  *binaryField(): ParseTask<Node> {
    const frame = this.enter('Field');
    try {
      const t = this.peek(0);
      return this.at(t, (yield this.binaryFieldAt(t)) as Node);
    } finally {
      this.leave(frame);
    }
  }

  *binaryFieldAt(t: Token): ParseTask<Node> {
    if (this.isOp(t, '...')) {
      this.next();
      const n = this.peek(0, 'operator');
      const name =
        this.isName(n) && n.v !== 'as' ? this.next('operator').v : null;
      return { k: 'Rest', name, asText: (yield this.asText()) as boolean };
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
      return { k: 'Field', name: t.v, type: (yield this.binaryType()) as Node };
    }
    this.fail(t, 'a Binary Pattern field (`name: type`, a literal or `...`)');
  }

  *asText(): ParseTask<boolean> {
    const frame = this.enter('AsText');
    try {
      if (!this.atOperatorWord('as')) {
        return false;
      }
      this.next('operator');
      this.expectWord('text');
      return true;
    } finally {
      this.leave(frame);
    }
  }

  *binaryType(): ParseTask<Node> {
    const frame = this.enter('FieldType');
    try {
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
        size = { k: 'Pin', name: (yield this.name()) as string };
      } else if (this.isOp(t, '(')) {
        this.next();
        this.size++;
        try {
          size = (yield this.expr()) as Node;
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
      return {
        k: 'Sized',
        size,
        unit: u.v,
        asText: (yield this.asText()) as boolean,
      };
    } finally {
      this.leave(frame);
    }
  }

  *binaryBuild(): ParseTask<Node> {
    const frame = this.enter('BinaryBuild');
    try {
      this.next('operand'); // opening bracket
      const fields: Node[] = [];
      // Peeked as an operand, so a nested build can be the first field; `>>`
      // reads the same either way.
      if (!this.isOp(this.peek(0, 'operand'), '>>')) {
        do {
          if (fields.length) {
            this.next('operator');
          }
          this.build++;
          let value: Node;
          try {
            value = (yield this.concat()) as Node;
          } finally {
            this.build--;
          }
          let type: Node | null = null;
          if (this.atOperatorWord('as')) {
            this.next('operator');
            type = (yield this.binaryType()) as Node;
          }
          fields.push({ k: 'BuildField', value, type });
        } while (this.isOp(this.peek(0, 'operator'), ','));
      }
      this.expectOp('>>');
      return { k: 'BinaryBuild', fields };
    } finally {
      this.leave(frame);
    }
  }
}

export type ParseResult =
  { error: null; tree: SyntaxNode } | { error: ParseError; tree: null };

/** Parse a Script or Library. Invalid scalar source throws HostError. */
export const parseSource = (source: string): ParseResult => {
  const parser = new Parser(source);
  try {
    runTask(parser.source());
    return { tree: parser.tree, error: null };
  } catch (error) {
    if (error instanceof ParseError) {
      return { tree: null, error };
    }
    throw error;
  }
};

/** A lossless tooling parse, including malformed regions as Error nodes. */
export type RecoveringParseResult = {
  diagnostics: readonly RecoveryDiagnostic[];
  error: ParseError | null;
  tree: SyntaxNode;
};

/** Recover past syntax errors. Invalid scalar source still throws HostError. */
export const parseSourceRecovering = (
  source: string,
): RecoveringParseResult => {
  const parser = new Parser(source, true);
  runTask(parser.source());
  return {
    tree: parser.tree,
    error: parser.diagnostics[0]?.error ?? null,
    diagnostics: parser.diagnostics,
  };
};

export type EntryResult =
  | { error: null; kind: EntryKind | null; tree: SyntaxNode }
  | {
      error: ParseError;
      /** The source ended before the Entry did, so more lines may finish it. */
      incomplete: boolean;
      tree: null;
    };

/**
 * Parse an Entry at a Session prompt (chapter 2, Entries). Its kind is null
 * when it holds only blank lines and comments. Invalid scalar source throws
 * HostError.
 */
export const parseEntry = (
  source: string,
  isHandler: (name: string) => boolean,
): EntryResult => {
  const parser = new Parser(source);
  try {
    const kind = runTask(parser.entry(isHandler));
    return { tree: parser.tree, kind, error: null };
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        tree: null,
        error,
        incomplete: error.tok.t === 'eof' || error.tok.incomplete === true,
      };
    }
    throw error;
  }
};
