import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { INITIAL, Registry, type IGrammar } from 'vscode-textmate';

const require = createRequire(import.meta.url);
const grammarPath = new URL(
  '../syntaxes/northtalk.tmLanguage.json',
  import.meta.url,
);

await loadWASM(
  readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer,
);
const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: patterns => new OnigScanner(patterns),
    createOnigString: text => new OnigString(text),
  }),
  loadGrammar: async () => JSON.parse(readFileSync(grammarPath, 'utf8')),
});
const grammar = (await registry.loadGrammar('source.northtalk')) as IGrammar;

// Each token's text with its innermost scope, skipping whitespace.
const tokenize = (source: string) => {
  let state = INITIAL;
  const tokens: [string, string][] = [];
  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, state);
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text.trim()) {
        tokens.push([text.trim(), token.scopes.at(-1)!]);
      }
    }
    state = result.ruleStack;
  }
  return tokens;
};
const scopeOf = (source: string, text: string) =>
  tokenize(source).find(([t]) => t === text)?.[1];

describe('the TextMate grammar', () => {
  test('is generated from the current Data Files', () => {
    const run = Bun.spawnSync([
      'bun',
      new URL('../tools/grammar.ts', import.meta.url).pathname,
      '--check',
    ]);
    expect(run.exitCode).toBe(0);
  });

  test('scopes handler declarations and their ends', () => {
    const source = 'private function pad s, width\nend pad';
    expect(tokenize(source)).toEqual([
      ['private', 'storage.modifier.northtalk'],
      ['function', 'storage.type.function.northtalk'],
      ['pad', 'entity.name.function.northtalk'],
      ['s', 'variable.other.northtalk'],
      [',', 'punctuation.separator.northtalk'],
      ['width', 'variable.other.northtalk'],
      ['end', 'keyword.control.northtalk'],
      ['pad', 'entity.name.function.northtalk'],
    ]);
    expect(scopeOf('  end repeat', 'repeat')).toBe('keyword.control.northtalk');
  });

  test('scopes keywords, constants and Built-ins', () => {
    const source = 'put upper(name) & newline into it -- shout';
    expect(tokenize(source)).toEqual([
      ['put', 'keyword.other.northtalk'],
      ['upper', 'support.function.builtin.northtalk'],
      ['(', 'punctuation.section.brackets.northtalk'],
      ['name', 'variable.other.northtalk'],
      [')', 'punctuation.section.brackets.northtalk'],
      ['&', 'keyword.operator.northtalk'],
      ['newline', 'support.constant.northtalk'],
      ['into', 'keyword.other.northtalk'],
      ['it', 'constant.language.northtalk'],
      ['-- shout', 'comment.line.double-dash.northtalk'],
    ]);
    // Words are case-sensitive, so `Put` is a Name.
    expect(scopeOf('Put x', 'Put')).toBe('variable.other.northtalk');
    expect(scopeOf('if x contains y then', 'contains')).toBe(
      'keyword.operator.word.northtalk',
    );
  });

  test('scopes Numbers and their Units', () => {
    expect(tokenize('put 9.81 m/s^2 into g')).toContainEqual([
      'm/s^2',
      'keyword.other.unit.northtalk',
    ]);
    expect(scopeOf('put 0x0D into cr', '0x0D')).toBe(
      'constant.numeric.northtalk',
    );
    // `n kg` is two operands, and `mod` after a Number is an operator.
    expect(scopeOf('put n kg into x', 'kg')).toBe('variable.other.northtalk');
    expect(scopeOf('put 3 mod 2 into x', 'mod')).toBe(
      'keyword.operator.word.northtalk',
    );
  });

  test('scopes text literals without escapes or across lines', () => {
    expect(tokenize(String.raw`put "C:\new" into path`)).toContainEqual([
      String.raw`C:\new`,
      'string.quoted.double.northtalk',
    ]);
    // Unterminated quoted text ends at its line break.
    expect(scopeOf('put "oops\nput x into y', 'x')).toBe(
      'variable.other.northtalk',
    );
  });

  test('scopes raw text up to a fence of the same length', () => {
    const source = 'put """"\nsay """ inside\n"""" into raw';
    expect(scopeOf(source, 'say """ inside')).toBe(
      'string.quoted.triple.northtalk',
    );
    expect(scopeOf(source, 'raw')).toBe('variable.other.northtalk');
  });

  test('scopes interpolation holes as code', () => {
    const tokens = tokenize('put `total ${count({a: 1}) + 1}\\n` into label');
    expect(tokens).toContainEqual(['total', 'string.interpolated.northtalk']);
    expect(tokens).toContainEqual([
      'count',
      'entity.name.function.call.northtalk',
    ]);
    expect(tokens).toContainEqual([
      String.raw`\n`,
      'constant.character.escape.northtalk',
    ]);
    expect(tokens.at(-1)).toEqual(['label', 'variable.other.northtalk']);
  });

  test('scopes use declarations', () => {
    expect(tokenize('use fetch, hold from helper as h')).toEqual([
      ['use', 'keyword.other.import.northtalk'],
      ['fetch', 'variable.other.northtalk'],
      [',', 'punctuation.separator.northtalk'],
      ['hold', 'variable.other.northtalk'],
      ['from', 'keyword.other.import.northtalk'],
      ['helper', 'entity.name.namespace.northtalk'],
      ['as', 'keyword.other.import.northtalk'],
      ['h', 'entity.name.namespace.northtalk'],
    ]);
  });
});
