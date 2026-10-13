// THROWAWAY #687: compare two default-operator spellings, never a Core parser.
// Run: bun tools/grammar/prototype-default.ts
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse as baseline } from './parser';

const dir = import.meta.dir;
const original = readFileSync(`${dir}/parser.ts`, 'utf8');
const lexer = readFileSync(`${dir}/lexer.ts`, 'utf8');
const generated: string[] = [];
function emit(name: string, source: string) {
  const path = `${dir}/${name}`;
  writeFileSync(path, source);
  generated.push(path);
  return path;
}
function variant(symbol: boolean) {
  let source = original.replace('const e = this.or();', 'const e = this.defaultValue();');
  const operator = symbol ? "this.isOp(this.peek(0, 'operator'), '??')" : "this.atOperatorWord('otherwise')";
  source = source.replace('  or(): Node {', `  defaultValue(): Node {
    let l = this.or();
    while (${operator}) {
      const op = this.next('operator');
      l = this.at(op, { k: 'Default', l, r: this.or() });
    }
    return l;
  }

  or(): Node {`);
  if (symbol) {
    emit('prototype-default-lexer.generated.ts', lexer.replace('    for (const op of OPS) {', "    if (rest.startsWith('??')) return T('op', '??');\n    for (const op of OPS) {"));
    source = source.replace("from './lexer'", "from './prototype-default-lexer.generated'");
  } else {
    source = source.replace('new Set<string>(grammar.follow)', "new Set<string>([...grammar.follow, 'otherwise'])")
      .replace('new Set<string>(grammar.labels.excluded)', "new Set<string>([...grammar.labels.excluded, 'otherwise'])")
      .replace("const CONTINUING_WORDS = new Set([", "const CONTINUING_WORDS = new Set([\n  'otherwise',");
  }
  source = source.replace('new Set<string>(grammar.decision.map((d: any) => d.name))', "new Set<string>([...grammar.decision.map((d: any) => d.name), 'optional-key'])");
  source = source.replace(`  the(): Node {
    this.next();
    const t = this.peek(0);`, `  the(): Node {
    this.next();
    const t = this.peek(0);
    if (this.isWord(t, 'optional') && !this.isWord(this.la2('optional-key', 'operator'), 'of')) {
      this.next();
      let key: string | Node;
      let computed = false;
      const start = this.peek(0);
      if (this.isOp(start, '(')) {
        this.next();
        key = this.nested(() => this.expr());
        this.expectOp(')');
        computed = true;
      } else if (start.t === 'str') {
        key = this.next().v;
      } else {
        key = this.propertyOrKey('an optional map key');
      }
      this.expectWord('of', 'operator');
      return { k: 'OptionalKey', key, computed, base: this.postfix(this.primary()) };
    }`);
  return emit(`prototype-default-${symbol ? 'symbol' : 'word'}.generated.ts`, source);
}
const body = (s: string) => `on demo\n${s}\nend demo\n`;
const expression = (s: string) => body(`return ${s}`);
const cases: [string, string][] = [
  ['optional literal', expression('the optional city of m')],
  ['optional chain with fallback', expression('the optional city of the optional address of customer OP "unknown"')],
  ['optional computed', expression('the optional (key()) of receiver()')],
  ['optional property spelling', expression('the optional length of m')],
  ['optional target spelling', expression('the optional target of m')],
  ['optional ordinal spelling', expression('the optional first of m')],
  ['optional multiword key', expression('the optional code points of m')],
  ['optional reserved key', expression('the optional if of m')],
  ['optional quoted of key', expression('the optional "of" of m')],
  ['optional optional key', expression('the optional optional of m')],
  ['optional guard', 'on demo x where (the optional active of x OP false)\nreturn x\nend demo\n'],
  ['optional assignment rejected', body('put 1 into the optional a of m')],
  ['optional set rejected', body('set the optional a of m to 1')],
  ['optional chunk rejected', expression('the optional first item of xs')],
  ['optional missing key rejected', expression('the optional ( ) of m')],
  ['optional inner ordinary', expression('the optional b of the a of m')],
  ['basic', expression('the second of found OP 0')],
  ['left association', expression('a OP b OP c')],
  ['below or', expression('a OP b or c')],
  ['below arithmetic', expression('a + b OP 0')],
  ['grouped comparison', expression('(a OP 0) > 3')],
  ['mixed comparison', expression('a OP b > 3')],
  ['lambda body', expression('given x: x OP d')],
  ['lambda fallback', expression('a OP (given x: x)')],
  ['unparenthesized lambda fallback', expression('a OP given x: x')],
  ['whose condition', expression('the first item of xs whose active OP false')],
  ['whose result', expression('(the first item of xs whose active) OP fallback')],
  ['every condition', expression('every item of xs whose active OP false')],
  ['trailing continuation', expression('a OP\n  d')],
  ['leading operator', expression('a\n OP d')],
  ['name at end of line', body('put otherwise into x\nreturn otherwise')],
  ['function called otherwise', expression('otherwise(x)')],
  ['chunk-word variable', expression('line OP ""')],
  ['old chunk index', expression('item otherwise of xs')],
  ['grouped old index', expression('item (otherwise) of xs')],
  ['old label declaration', 'on demo x otherwise d\nreturn d\nend demo\n'],
  ['old labelled call', body('foo 1 otherwise 2')],
  ['old labelled send', body('send to receiver: foo 1 otherwise 2')],
  ['old labelled event', body('wait for foo x otherwise d')],
  ['ordinary label', body('foo (a OP b) to c')],
  ['operator before label', body('foo a OP b to c')],
  ['guard', 'on demo x where (x OP false)\nreturn x\nend demo\n'],
  ['replace restricted slot', expression('replace "a" in x OP "" with "b"')],
  ['replace grouped slot', expression('replace "a" in (x OP "") with "b"')],
  ['missing rhs', expression('a OP')],
  ['rhs text pattern', expression('a OP <digit>')],
  ['rhs binary build', expression('a OP <<1 as uint8>>')],
  ['numeric operand', expression('1 OP 2')],
  ['rhs default name', expression('a OP otherwise')],
  ['handler named otherwise', 'on otherwise x\nreturn x\nend otherwise\n'],
  ['trailing comment continuation', expression('a OP -- fallback\n d')],
  ['no-space symbol', expression('a??b')],
  ['single question mark', expression('a ? b')],
  ['fallback grouping in list', expression('[a OP b, c]')],
  ['fallback grouping in call', expression('f(a OP b, c)')],
  ['key named otherwise', expression('the otherwise of m')],
  ['key named optional', expression('the optional of m')],
];
const compact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['line','col','end'].includes(k)).map(([k,v]) => [k,compact(v)]));
};
const result = (parse: typeof baseline, source: string) => {
  const r = parse(source);
  return { tree: r.error ? { error: r.error.code, line: r.error.tok.line, col: r.error.tok.col, message: r.error.message } : compact(r.ast), relexes: r.stats.relexes, decisions: [...r.stats.sites.keys()] };
};
try {
  const word = (await import(variant(false))).parse as typeof baseline;
  const symbol = (await import(variant(true))).parse as typeof baseline;
  console.log('THROWAWAY #687; base 0ea3a15c; full trees omit positions except errors. No runtime semantics implemented.');
  const decisions = new Set<string>();
  let relexes = 0;
  for (const [name, template] of cases) {
    console.log(`\nCASE ${name}`);
    for (const [label, parse, op] of [['baseline', baseline, 'otherwise'], ['otherwise', word, 'otherwise'], ['??', symbol, '??']] as const) {
      const r = result(parse, template.replaceAll('OP', op));
      r.decisions.forEach(d => decisions.add(d)); relexes += r.relexes.length;
      console.log(`${label}: ${JSON.stringify(r.tree)}`);
      if (r.relexes.length) console.log(`RELEX: ${JSON.stringify(r.relexes)}`);
    }
  }
  const files = execFileSync('git', ['ls-files', '-z', '*.talk'], { cwd: `${dir}/../..`, encoding: 'utf8' }).split('\0').filter(Boolean);
  const totals = { files: files.length, baselineAccepted: 0, baselineRejected: 0, wordChanges: 0, symbolChanges: 0 };
  for (const file of files) {
    const src = readFileSync(`${dir}/../../${file}`, 'utf8');
    const old = baseline(src);
    if (old.error) { totals.baselineRejected++; continue; }
    totals.baselineAccepted++;
    const before = JSON.stringify(old.ast);
    for (const [label, parse] of [['word', word], ['symbol', symbol]] as const) {
      const r = parse(src);
      r.stats.sites.forEach((_, d) => decisions.add(d)); relexes += r.stats.relexes.length;
      if (r.error || JSON.stringify(r.ast) !== before) {
        totals[label === 'word' ? 'wordChanges' : 'symbolChanges']++;
        console.log(`EXISTING CHANGE ${label} ${file}: ${r.error?.message ?? 'AST differs'}`);
      }
    }
  }
  console.log(`\nSCAN ${JSON.stringify(totals)}`);
  console.log(`RELEXES ${relexes}`);
  console.log(`DECISIONS ${JSON.stringify([...decisions].sort())}`);
  console.log('The parser throws on third-token lookahead and undeclared second-token decisions; neither guard was changed.');
} finally {
  for (const path of generated) unlinkSync(path);
}
