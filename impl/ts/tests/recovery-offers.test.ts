import { expect, test } from 'bun:test';
import cases from '../../../tools/grammar/recovery-offers.json';
import { compileSource as compileReference } from '../../../tools/machine/compile';
import { parse, newStats } from '../../../tools/grammar/parser';
import { checkSource, compileSource, parseSource, syntaxText } from '../src';

for (const fixture of cases) {
  test(`Recovery Offers: ${fixture.name}`, () => {
    const reference = parse(fixture.source, newStats());
    const parsed = parseSource(fixture.source);
    expect(
      reference.error
        ? [
            reference.error.code,
            reference.error.tok.line,
            reference.error.tok.col,
          ]
        : [],
    ).toEqual(fixture.syntaxDiagnostic);
    expect(!!reference.error).toBe(fixture.syntaxError);
    expect(!!parsed.error).toBe(fixture.syntaxError);
    if (fixture.syntaxError) {
      expect([
        String(parsed.error!.code),
        parsed.error!.tok.line,
        parsed.error!.tok.col,
      ]).toEqual(fixture.syntaxDiagnostic);
      return;
    }
    expect(syntaxText(parsed.tree!)).toBe(fixture.source);
    const checked = checkSource(fixture.source);
    expect(checked.error).toBeNull();
    expect(
      checked.diagnostics.map(d => [String(d.code), d.span.line, d.span.col]),
    ).toEqual(fixture.diagnostics);
  });
}

test('Recovery Offers lowering refuses staged forms explicitly', () => {
  for (const source of [
    'on t\ntry\noffer skip\nend try\nend t',
    'on t\ntry\ncatch e before unwind\nend try\nend t',
    'on t\ntry\ncatch e before unwind\nchoose offer skip\nend try\nend t',
  ]) {
    expect(() => compileReference('test', 'script', source)).toThrow(
      'not yet lowered',
    );
    expect(() => compileSource(source, { name: 'test' })).toThrow(
      'not yet lowered',
    );
  }
});
