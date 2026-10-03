import { describe, expect, test } from 'bun:test';
import { checkSource, newGroup, parseSourceRecovering } from '@odgn/northtalk';
import { lint, lintSyntax, lintCatalogue } from '../src/lint';
import { fixtures } from './fixtures';

for (const { id, positive, negative } of fixtures) {
  describe(`${id}: ${positive.split('\n')[1] ?? positive}`, () => {
    test('flags the positive fixture', () => {
      expect(parseSourceRecovering(positive).diagnostics).toEqual([]);
      expect(
        lint(positive, { profile: 'beginner' }).lints.some(
          item => item.id === id,
        ),
      ).toBe(true);
    });
    test('leaves the negative fixture alone', () => {
      expect(parseSourceRecovering(negative).diagnostics).toEqual([]);
      expect(
        lint(negative, { profile: 'beginner' }).lints.some(
          item => item.id === id,
        ),
      ).toBe(false);
    });
  });
}

test('ships eighteen catalogue entries, with seven planned binding/manifest lints', () => {
  expect(lintCatalogue).toHaveLength(18);
  expect(lintCatalogue.filter(item => item.status === 'planned')).toHaveLength(
    7,
  );
  expect(new Set(lintCatalogue.map(item => item.id)).size).toBe(18);
});

test('the Host or user selects the profile; default is standard', () => {
  const source = 'on demo\nend';
  expect(lint(source).lints).toEqual([]);
  expect(lint(source, { profile: 'standard' }).lints).toEqual([]);
  expect(lint(source, { profile: 'beginner' }).lints).toMatchObject([
    {
      id: 'prefer-explicit-end',
      level: 'warning',
      span: { start: 8, end: 11, line: 2, col: 1 },
    },
  ]);
});

test('a standalone comment suppresses only its id on the next physical line', () => {
  const source =
    'on demo\nwait for all\n-- lint: ignore plain-send-in-join\nsend ping to me\nsend ping to me\nend wait\nend demo';
  expect(
    lint(source)
      .lints.filter(item => item.id === 'plain-send-in-join')
      .map(item => item.span.line),
  ).toEqual([5]);
  expect(
    lint(source.replace('-- lint:', 'say 1 -- lint:')).lints.filter(
      item => item.id === 'plain-send-in-join',
    ),
  ).toHaveLength(2);
  expect(
    lint(
      source.replace('send ping to me\nsend', '\nsend ping to me\nsend'),
    ).lints.filter(item => item.id === 'plain-send-in-join'),
  ).toHaveLength(2);
  expect(
    lint(
      source.replace('plain-send-in-join\nsend', 'advanced-construct\nsend'),
    ).lints.filter(item => item.id === 'plain-send-in-join'),
  ).toHaveLength(2);
});

test('continues linting after errors without advice on malformed expressions', () => {
  const source =
    'on demo\nput "bad" + as instant into x\nput {length: 1} into x\nend demo';
  const result = lint(source);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.lints.map(item => item.id)).toEqual(['key-shadows-property']);
  expect(lintSyntax(parseSourceRecovering(source).tree)).toEqual(result.lints);
});

test('Join context stops at Lambda bodies and conditional context starts inside the Join', () => {
  const source =
    'on demo\nwait for all\nput given\nsend ping to me\nend given into fn\nif true then\nwait for all\nsend ping to me and wait\nend wait\nend if\nend wait\nend demo';
  expect(lint(source).lints).toEqual([]);
});

test('bare endings suggest the matching names and keywords', () => {
  const source =
    'on demo\nput given x\nreturn x\nend into fn\nwait for all\nend\nend';
  expect(
    lint(source, { profile: 'beginner' }).lints.map(item => item.message),
  ).toEqual([
    'Write end given to show which block ends here.',
    'Write end wait to show which block ends here.',
    'Write end demo to show which block ends here.',
  ]);
});

test('lints do not alter Core acceptance', () => {
  const source =
    'on demo\nput {length: 1} into x\nput "bad" as instant into x\nend demo';
  const before = checkSource(source);
  expect(before.ok).toBe(true);
  expect(lint(source).lints).toHaveLength(2);
  expect(checkSource(source)).toEqual(before);
  const trace: string[] = [];
  const group = newGroup({
    name: 'lint-test',
    trace: line => trace.push(line),
  });
  expect(() => group.load({ name: 'demo', source })).not.toThrow();
  const loadedTrace = [...trace];
  lint(source);
  expect(trace).toEqual(loadedTrace);
});

test('case advice requires a literal operand and does not apply to emptiness or kind tests', () => {
  const source =
    'on demo\nif length("Ann") = 3 then say 1\nif "Ann" is empty then say 1\nif "Ann" is a text then say 1\nend demo';
  expect(lint(source, { profile: 'beginner' }).lints).toEqual([]);
});

test('case advice covers ordering', () => {
  expect(
    lint('on demo\nif name < "Ann" then say 1\nend demo', {
      profile: 'beginner',
    }).lints.map(item => item.id),
  ).toEqual(['suggest-ignoring-case']);
});

test('binary exponentiation is not a pin, and Binary builds are Beginner Surface', () => {
  const source =
    'on demo <<data: (2 ^ 3) bytes>>\nput <<n as uint16>> into x\nend demo';
  expect(lint(source, { profile: 'beginner' }).lints).toEqual([]);
});

test('profile levels, rendered wording and spans match the catalogue for every emitted Lint', () => {
  for (const { positive } of fixtures) {
    for (const profile of ['beginner', 'standard'] as const) {
      for (const item of lint(positive, { profile }).lints) {
        const entry = lintCatalogue.find(entry => entry.id === item.id)!;
        expect(entry[profile]).toBe(item.level);
        expect(item.message).not.toMatch(/{[a-z]+}/);
        expect(
          positive.slice(item.span.start, item.span.end).length,
        ).toBeGreaterThan(0);
      }
    }
  }
});

test('suppression works with CRLF, indentation and the last line of a file', () => {
  const source = 'on demo\r\n  -- lint: ignore prefer-explicit-end\r\nend';
  expect(lint(source, { profile: 'beginner' }).lints).toEqual([]);
});

test('comments and blank lines use the physical Join line threshold', () => {
  const body = '-- comment\n\n'.repeat(11);
  expect(
    lint(`on demo\nwait for all\n${body}end wait\nend demo`).lints,
  ).toMatchObject([
    {
      id: 'long-join-body',
      message:
        'This Join body spans 22 source lines. Consider keeping it within 20 lines.',
    },
  ]);
});

test('every grammar Advanced tag is exercised and supplies its beginner wording', async () => {
  const { advancedTags } = await import('../src/generated/lints');
  const advice = fixtures.flatMap(
    ({ positive }) => lint(positive, { profile: 'beginner' }).lints,
  );
  for (const tag of advancedTags) {
    expect(
      advice.some(
        item =>
          item.id === 'advanced-construct' &&
          item.message.includes(tag.construct) &&
          item.message.includes(tag.beginner),
      ),
    ).toBe(true);
  }
});

test('recovering nodes retain bare endings and advice in later blocks', () => {
  const source =
    'on demo\nif true then\nput + into x\nend\nput {length: 3} into x\nend';
  expect(
    lint(source, { profile: 'beginner' }).lints.map(item => item.id),
  ).toEqual([
    'prefer-explicit-end',
    'key-shadows-property',
    'prefer-explicit-end',
  ]);
});

test('suppression uses comments, not directive-looking text', () => {
  const source =
    'on demo\nsay "-- lint: ignore key-shadows-property"\nput {length: 3} into x\nend demo';
  expect(lint(source).lints.map(item => item.id)).toEqual([
    'key-shadows-property',
  ]);
});

test('deep edited expressions lint without a native-stack limit', () => {
  const source = `on demo\nput ${'('.repeat(1200)}"bad"${')'.repeat(1200)} as instant into x\nend demo`;
  expect(lint(source).lints.map(item => item.id)).toEqual([
    'unconvertible-literal',
  ]);
});

test('an error inside a Lambda body leaves its valid sibling statements available', () => {
  const source =
    'on demo\nput given\nput + into x\nput {length: 3} into x\nend given into fn\nend demo';
  expect(lint(source).lints.map(item => item.id)).toEqual([
    'key-shadows-property',
  ]);
});
