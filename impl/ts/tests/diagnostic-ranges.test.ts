// A load diagnostic's range (chapter 2, Syntax errors): the token it is
// reported at, with an exclusive end in lines and Unicode-scalar columns.
import { describe, expect, test } from 'bun:test';
import {
  compileLibrary,
  LoadError,
  newGroup,
  shape,
  type LoadDiagnostic,
} from '../src/index';
import { prepare, rangesOf } from '../src/library';

type Range = Pick<LoadDiagnostic, 'line' | 'col' | 'endLine' | 'endCol'>;
const range = ({ line, col, endLine, endCol }: Range) => ({
  line,
  col,
  endLine,
  endCol,
});
const ranges = (source: string) =>
  (prepare('script', 's', source, new Map()).diagnostics ?? []).map(range);
const rejected = (work: () => unknown): readonly LoadDiagnostic[] => {
  try {
    work();
  } catch (error) {
    if (error instanceof LoadError) {
      return error.diagnostics;
    }
    throw error;
  }
  throw new Error('expected a LoadError');
};

describe('diagnostic ranges', () => {
  test('an unterminated interpolation spans its dollar-brace opener', () => {
    expect(ranges('constant x = `hello ${1 +\n')).toEqual([
      { line: 1, col: 21, endLine: 1, endCol: 23 },
    ]);
  });
  test('a checker diagnostic spans its token', () => {
    expect(ranges('on go\n  return absent\nend go')).toEqual([
      { line: 2, col: 10, endLine: 2, endCol: 16 },
    ]);
  });

  test('columns count scalars, so an astral character is one column', () => {
    expect(ranges('on go\n  return {"😀": 1, "😀": 2}\nend go')).toEqual([
      { line: 2, col: 19, endLine: 2, endCol: 22 },
    ]);
  });

  test('a multi-line text literal ends on its last line', () => {
    expect(
      ranges('on go\n  return {"😀a": 1, """\n  😀a\n  """: 2}\nend go').at(0),
    ).toEqual({ line: 2, col: 20, endLine: 4, endCol: 6 });
  });

  test('a syntax error at a line end is empty, for LF and CRLF alike', () => {
    for (const nl of ['\n', '\r\n']) {
      expect(ranges(`on go${nl}put 5 into${nl}end go`)).toEqual([
        { line: 2, col: 11, endLine: 2, endCol: 11 },
      ]);
    }
  });

  test('a syntax error at the end of the source is empty', () => {
    expect(ranges('on go\nput 5 into')).toEqual([
      { line: 2, col: 11, endLine: 2, endCol: 11 },
    ]);
  });

  test('a syntax error at a token spans it', () => {
    expect(ranges('on go\n  if 1 > then say "x"\nend go')).toEqual([
      { line: 2, col: 10, endLine: 2, endCol: 14 },
    ]);
  });

  test('a position no token starts at is an empty range', () => {
    const source = 'constant x = 1 / 0';
    const p = prepare('script', 's', source, new Map());
    expect(p.ranges.at(1, 16)).toEqual({ endLine: 1, endCol: 17 });
    expect(p.ranges.at(1, 15)).toEqual({ endLine: 1, endCol: 15 });
    expect(rangesOf(source).at(1, 16)).toEqual({ endLine: 1, endCol: 16 });
  });

  test('`initialiser failed` spans the raising token', () => {
    const d = rejected(() =>
      newGroup({ name: 'g' }).load({
        name: 's',
        source: 'constant x = "😀" & (1 / 0)\non go\nend go',
      }),
    );
    expect(d.map(range)).toEqual([
      { line: 1, col: 23, endLine: 1, endCol: 24 },
    ]);
  });

  test('a Library need is reported over the `use` that imports it', () => {
    const library = compileLibrary(
      {
        name: 'base',
        source:
          'function fetch key\n  ask io to read key\n  return it\nend fetch',
        version: '1',
      },
      [],
      { io: { read: { mode: 'immediate', args: [shape.text] } } },
    );
    const g = newGroup({ name: 'g' });
    g.addLibrary(library);
    const d = rejected(() =>
      g.load({ name: 's', source: 'use fetch from base\non go\nend go' }),
    );
    expect(d.map(d => [d.code, d.unit, ...Object.values(range(d))])).toEqual([
      ['missing grant', 's', 1, 1, 1, 4],
    ]);
  });

  test('an inherited veto ends in the unit it is positioned in', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source: 'on decide, deciding\n  veto "😀😀😀"\nend decide',
    });
    const d = rejected(() =>
      s.extend(
        '-- a longer first line than the veto’s\non caller\n  decide\nend caller',
      ),
    );
    expect(d.map(range)).toContainEqual({
      line: 2,
      col: 3,
      endLine: 2,
      endCol: 7,
    });
  });
});
