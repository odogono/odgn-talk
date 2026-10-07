import { expect, test } from 'bun:test';
import cases from '../../../tools/grammar/recovery-offers.json';
import { checkSource } from '@odgn/northtalk';
import { parse } from '../../../tools/grammar/parser';
import { viewSource } from '../../../impl/ts/src/view';
import { formatSource } from '../src/format';

for (const fixture of cases.filter(c => !c.syntaxError)) {
  test(`Recovery Offers formatting round trip: ${fixture.name}`, () => {
    const formatted = formatSource(fixture.source);
    expect(formatted.error).toBeNull();
    expect(formatSource(formatted.source)).toEqual(formatted);
    expect(parse(formatted.source).error).toBeNull();
    expect(
      checkSource(formatted.source).diagnostics.map(d => String(d.code)),
    ).toEqual(fixture.diagnostics.map(d => String(d[0])));
  });
}

test('semantic view retains offer parameters, recovery flags and choice arguments', () => {
  const checked = checkSource(cases[0]!.source);
  expect(checked.ok).toBe(true);
  const handler = viewSource(checked.tree!.root)[0]!;
  if (handler.k !== 'handler') {
    throw new Error('expected Handler');
  }
  const body = handler.body[0]!;
  if (body.k !== 'try') {
    throw new Error('expected try');
  }
  expect(body.offers.map(o => [o.name, o.params.map(p => p.text)])).toEqual([
    ['skip', []],
    ['useValue', ['value', 'extra']],
  ]);
  expect(body.offers[1]!.params.map(p => p.binding?.initial)).toEqual([
    'nothing',
    'nothing',
  ]);
  expect(body.catches.map(c => c.recovery)).toEqual([true, false]);
  expect(
    body.catches[0]!.body.map(s =>
      s.k === 'choose-offer' ? [s.name, s.args.length] : null,
    ),
  ).toEqual([
    ['skip', 0],
    ['skip', 0],
    ['useValue', 2],
  ]);
});
