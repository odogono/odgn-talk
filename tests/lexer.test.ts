import { describe, expect, test } from 'bun:test';
import { HostError, Lexer } from '../src';

describe('Core lexer', () => {
  test('preserves BOM, spaces, comments and exact token spelling', () => {
    const source = '\ufeff \t-- 😀 comment\r\n"e\u0301" 2.50';
    const lexer = new Lexer(source);
    const newline = lexer.lex(0, 'operand');
    expect(newline.raw).toBe('\r\n');
    expect(newline.leadingTrivia.map(t => t.raw).join('')).toBe(
      '\ufeff \t-- 😀 comment',
    );
    const literal = lexer.lex(newline.end, 'operand');
    expect(literal.v).toBe('e\u0301');
    expect(literal.raw).toBe('"e\u0301"');
    const number = lexer.lex(literal.end, 'operand');
    expect(number.v).toBe('2.50');
  });

  test('refuses lone surrogates anywhere in source as a Host error', () => {
    for (const source of ['-- \ud800', '"\udfff"', '\ud800']) {
      expect(() => new Lexer(source)).toThrow(HostError);
    }
  });

  test('counts scalar columns and all three line break forms', () => {
    const source = '"😀"\t@\r"x"\r\n"y"\n@';
    const lexer = new Lexer(source);
    expect(lexer.where(source.indexOf('@'))).toEqual({ line: 1, col: 5 });
    expect(lexer.where(source.length - 1)).toEqual({ line: 4, col: 1 });
  });

  test('never truncates words, decimal digits or compound units', () => {
    const lexer = new Lexer(
      'a'.repeat(300) + ' ' + '2'.repeat(300) + ' m' + '*m'.repeat(100),
    );
    const word = lexer.lex(0, 'operand');
    const number = lexer.lex(word.end, 'operand');
    const unit = lexer.lex(number.end, 'unit');
    expect(word.v).toHaveLength(300);
    expect(number.v).toHaveLength(300);
    expect(unit.v).toBe('m' + '*m'.repeat(100));
  });

  test('uses parser modes for angle brackets and preserves requested fallback mode', () => {
    const lexer = new Lexer('<< >>= mod');
    expect(lexer.lex(0, 'operand').t).toBe('binopen');
    expect(lexer.lex(0, 'operator').t).toBe('op');
    expect(lexer.lex(2, 'pattern').raw).toBe('>');
    expect(lexer.lex(2, 'operator').raw).toBe('>>');
    expect(new Lexer('mod').lex(0, 'unit').mode).toBe('unit');
  });

  test('checks complete unit runs and retains lexical error spans', () => {
    for (const unit of [
      's^-1',
      'm^0',
      'm^',
      'm^+2',
      'm/s/kg',
      'USD/month',
      'm*width',
      '1/s^0',
    ]) {
      const token = new Lexer(unit).lex(0, 'unit');
      expect(token.code).toBe('bad unit');
      expect(token.raw).toBe(unit);
    }
    const token = new Lexer('"unfinished\rnext').lex(0, 'operand');
    expect(token.code).toBe('unterminated text');
    expect(token.raw).toBe('"unfinished');
  });
});

test('scalar positions remain exact across long lines and mixed line endings', () => {
  const source = 'a'.repeat(20_000) + '😀\t𐐀x\r\n😀\ry\nz';
  const lexer = new Lexer(source);
  expect(lexer.where(20_000)).toEqual({ line: 1, col: 20_001 });
  expect(lexer.where(20_005)).toEqual({ line: 1, col: 20_004 });
  expect(lexer.where(20_008)).toEqual({ line: 2, col: 1 });
  expect(lexer.where(20_011)).toEqual({ line: 3, col: 1 });
  expect(lexer.where(source.length)).toEqual({ line: 4, col: 2 });
});
