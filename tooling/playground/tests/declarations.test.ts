import { describe, expect, test } from 'bun:test';
import { planApply, splitDeclarations } from '../src/declarations';

const split = (source: string) => {
  const r = splitDeclarations(source);
  if (r.error) {
    throw new Error(r.error.code);
  }
  return r.declarations;
};

describe('Apply', () => {
  test('keeps attached doc blocks exactly, without changing declaration identity', () => {
    const source =
      '  --| function docs\r\n\t--|\r\n--|  space  \r\nprivate function f\r\n return 1\r\nend f\r\n--| detached\r\n\r\nconstant k = 2 --| trailing\r\n--| variable docs\r\nscript variable v = 3\r\n--| interrupted\r\n-- ordinary\r\non go\r\nend go';
    expect(split(source)).toEqual([
      {
        key: 'function f',
        source:
          '  --| function docs\r\n\t--|\r\n--|  space  \r\nprivate function f\r\n return 1\r\nend f',
      },
      { key: 'constant k', source: 'constant k = 2 --| trailing' },
      {
        key: 'script variable v',
        source: '--| variable docs\r\nscript variable v = 3',
      },
      { key: 'on go', source: 'on go\r\nend go' },
    ]);
    const before = split('--| old\nprivate constant k = 1');
    const after = split('--| new\nprivate constant k = 1');
    expect(planApply(after, before)).toEqual({ enter: after, removed: [] });
  });

  test('splits top-level declarations, comments inside them kept', () => {
    expect(
      split(
        '-- lead\nuse pad from text\nscript   variable x = 1\n\non greet name -- hi\n  say name\nend greet\n',
      ),
    ).toEqual([
      { key: 'use pad from text', source: 'use pad from text' },
      { key: 'script variable x', source: 'script   variable x = 1' },
      {
        key: 'on greet',
        source: 'on greet name -- hi\n  say name\nend greet',
      },
    ]);
  });

  test('reports a syntax error', () => {
    expect(splitDeclarations('on greet\n  say 1 +\nend greet')).toEqual({
      error: expect.objectContaining({ code: expect.any(String) }),
    });
  });

  test('enters new and changed declarations, and finds removed ones', () => {
    const session = split(
      'constant a = 1\non f\n  say 1\nend f\nconstant b = 2\n',
    );
    const tab = split('constant a = 1\non f\n  say 2\nend f\nconstant c = 3\n');
    expect(planApply(tab, session)).toEqual({
      enter: [
        { key: 'on f', source: 'on f\n  say 2\nend f' },
        { key: 'constant c', source: 'constant c = 3' },
      ],
      removed: [{ key: 'constant b', source: 'constant b = 2' }],
    });
    expect(planApply(session, session)).toEqual({ enter: [], removed: [] });
  });
});

test('Apply identifies each Handler by its full Selector', () => {
  const original = splitDeclarations(
    'on move piece\nend move\non move piece to square\nend move\n',
  );
  const changed = splitDeclarations(
    'on move piece\nend move\non move piece to square\n say square\nend move\n',
  );
  expect(original.error).toBeUndefined();
  expect(changed.error).toBeUndefined();
  if (original.error || changed.error) {
    throw new Error('expected declarations');
  }
  expect(original.declarations.map(d => d.key)).toEqual([
    'on move',
    'on move:to:',
  ]);
  expect(
    planApply(changed.declarations, original.declarations).enter.map(
      d => d.key,
    ),
  ).toEqual(['on move:to:']);
  expect(
    planApply(
      changed.declarations.slice(0, 1),
      original.declarations,
    ).removed.map(d => d.key),
  ).toEqual(['on move:to:']);
});
