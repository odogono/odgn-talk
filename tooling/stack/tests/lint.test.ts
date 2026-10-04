import { describe, expect, test } from 'bun:test';
import { checkSource, newGroup, parseSourceRecovering } from '@odgn/northtalk';
import { lint, lintSyntax, lintCatalogue } from '../src/lint';
import { fixtureManifest, fixtures } from './fixtures';

for (const { id, positive, negative, options } of fixtures) {
  describe(`${id}: ${positive.split('\n')[1] ?? positive}`, () => {
    test('flags the positive fixture', () => {
      expect(parseSourceRecovering(positive).diagnostics).toEqual([]);
      expect(
        lint(positive, { ...options, profile: 'beginner' }).lints.some(
          item => item.id === id,
        ),
      ).toBe(true);
    });
    test('leaves the negative fixture alone', () => {
      expect(parseSourceRecovering(negative).diagnostics).toEqual([]);
      expect(
        lint(negative, { ...options, profile: 'beginner' }).lints.some(
          item => item.id === id,
        ),
      ).toBe(false);
    });
  });
}

test('ships eighteen implemented catalogue entries', () => {
  expect(lintCatalogue).toHaveLength(18);
  expect(lintCatalogue.every(item => item.status === 'implemented')).toBe(true);
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

const clause = (pattern: string) => `on demo ${pattern}\nend demo\n`;
const script = (body: string) => `on demo m\n${body}\nend demo`;
const caught = (body: string) =>
  `script variable count = 0\non demo flag\ntry\n${body}\ncatch e\nsay e\nend try\nend demo`;
const join = (receiver: string, waiting = ' and wait') =>
  `on demo\nwait for all\nsend ping to ${receiver}${waiting}\nend wait\nend demo`;
const advice = (source: string, id: string) =>
  lint(source).lints.filter(l => l.id === id);

test('clause coverage respects arity, guards and structural restrictions', () => {
  for (const [earlier, later, expected] of [
    ['_', '1', true],
    ['x', 'x, y', false],
    ['1', '2', false],
    ['1', '1', true],
    ['{key: x}', '{key: 1, other: 2}', true],
    ['{key: 1}', '{key: x}', false],
    ['[x, ...rest]', '[1, 2]', true],
    ['[x]', '[1, 2]', false],
    ['x where false', '1', false],
    ['^limit', '^limit', false],
  ] as const) {
    const source =
      'script variable limit = 1\n' + clause(earlier) + clause(later);
    expect(parseSourceRecovering(source).diagnostics).toEqual([]);
    expect(advice(source, 'unreachable-clause').length > 0).toBe(expected);
  }
});

test('pin advice applies to destructuring bindings, not function parameters or reads', () => {
  const source =
    'script variable count = 0\nfunction f count\nreturn count\nend f\non demo\nlet [count] be [1]\nput count into x\nend demo';
  expect(advice(source, 'pin-trap').map(l => l.span.line)).toEqual([6]);
  // The Core's name-clash diagnostic remains authoritative and separate.
  expect(
    checkSource(source).diagnostics.some(d => d.code === 'name clash'),
  ).toBe(true);
  expect(lint(source).diagnostics).toEqual([]);
});

test('key emptiness advice distinguishes properties, known keys and reassignment', () => {
  for (const [body, expected] of [
    ["if m's title is empty then say 1", true],
    ['if the length of m is empty then say 1', false],
    ['if the "length" of m is empty then say 1', true],
    ['if the "title" of m is nothing then say 1', false],
    ['put {title: ""} into m\nif the "title" of m is empty then say 1', false],
    [
      'put {title: ""} into m\nput {} into m\nif the "title" of m is empty then say 1',
      true,
    ],
    [
      'put {title: ""} into m\nif true then put {} into m\nif the "title" of m is empty then say 1',
      true,
    ],
    ['if the ("title") of m is empty then say 1', true],
  ] as const) {
    const source = script(body);
    expect(parseSourceRecovering(source).diagnostics).toEqual([]);
    expect(advice(source, 'is-empty-on-missing-key').length > 0).toBe(expected);
  }
  expect(
    lint('on demo\nif the "title" of window is empty then say 1\nend demo', {
      manifest: { ...fixtureManifest, objects: ['window'] },
    }).lints,
  ).toEqual([]);
});

test('caught-error advice follows branch order and stops at exits and Lambda bodies', () => {
  for (const [body, expected] of [
    ['put 1 into count\nput 1 / 0 into x', true],
    ['put 1 into count', false],
    ['put 1 into local\nthrow {code: "oops"}', false],
    ['put 1 into count\nreturn\nthrow {code: "oops"}', false],
    [
      'if flag then\nput 1 into count\nelse\nthrow {code: "oops"}\nend if',
      false,
    ],
    ['if flag then put 1 into count\nthrow {code: "oops"}', true],
    [
      'put given\nput 1 into count\nthrow {code: "oops"}\nend given into fn',
      false,
    ],
    [
      'put 1 into count\nput given\nthrow {code: "oops"}\nend given into fn',
      false,
    ],
  ] as const) {
    const source = caught(body);
    expect(parseSourceRecovering(source).diagnostics).toEqual([]);
    expect(advice(source, 'try-write-before-fail').length > 0).toBe(expected);
  }
  expect(
    advice(
      'script variable count = 0\non demo\ntry\nput 1 into count\nthrow {code: "oops"}\nfinally\nsay count\nend try\nend demo',
      'try-write-before-fail',
    ),
  ).toEqual([]);
});

test('self-Join advice requires waiting members and every receiving clause to opt out', () => {
  for (const policy of ['queued', 'dropping', 'replacing']) {
    const clauses = `on ping, ${policy}\nend ping\n`;
    expect(advice(clauses + join('me'), 'serialised-self-join')).toHaveLength(
      1,
    );
    expect(advice(clauses + join('other'), 'serialised-self-join')).toEqual([]);
    expect(advice(clauses + join('me', ''), 'serialised-self-join')).toEqual(
      [],
    );
    expect(
      advice(
        clauses + 'on ping x\nend ping\n' + join('me'),
        'serialised-self-join',
      ),
    ).toEqual([]);
  }
  expect(advice(join('me'), 'serialised-self-join')).toEqual([]);
});

test('binding advice keeps original spans, profiles, adjacency and recovery', () => {
  const source =
    'constant min = 1\r\non demo\r\nput + into x\r\n-- lint: ignore shadows-builtin\r\nput 1 into y\r\nend demo';
  const result = lint(source);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.lints).toMatchObject([
    {
      id: 'shadows-builtin',
      level: 'hint',
      span: { start: 9, end: 12, line: 1, col: 10 },
    },
  ]);
  expect(lint('-- lint: ignore shadows-builtin\n' + source).lints).toEqual([]);
  expect(lint(source, { profile: 'beginner' }).lints[0]!.level).toBe('warning');
});

test('unknown-message is manifest-only and respects suppression and Library context', () => {
  const source = 'on other\nend other';
  expect(lint(source).lints).toEqual([]);
  expect(lint(source, { manifest: fixtureManifest }).lints).toMatchObject([
    { id: 'unknown-message', level: 'hint' },
  ]);
  expect(
    lint('-- lint: ignore unknown-message\n' + source, {
      manifest: fixtureManifest,
    }).lints,
  ).toEqual([]);
  expect(
    lint(source, {
      manifest: fixtureManifest,
      checkOptions: { unit: 'library' },
    }).lints,
  ).toEqual([]);
});

test('key presence guards and immutable map constants make emptiness tests safe', () => {
  for (const source of [
    'constant m = {title: ""}\non demo\nif the "title" of m is empty then say 1\nend demo',
    'on demo m\nif "title" is in the keys of m then\nif the "title" of m is empty then say 1\nend if\nend demo',
    'on demo m\nif "title" is in the keys of m and the "title" of m is empty then say 1\nend demo',
  ]) {
    expect(advice(source, 'is-empty-on-missing-key')).toEqual([]);
  }
  expect(
    advice(
      'on demo m\nif "title" is in the keys of m or the "title" of m is empty then say 1\nend demo',
      'is-empty-on-missing-key',
    ),
  ).toHaveLength(1);
  expect(
    advice(
      'on demo m\nif "title" is in the keys of m then\nput {} into m\nif the "title" of m is empty then say 1\nend if\nend demo',
      'is-empty-on-missing-key',
    ),
  ).toHaveLength(1);
});

test('nested caught-error analysis emits one piece of advice per original write', () => {
  const source =
    'script variable count = 0\non demo\ntry\ntry\nput 1 into count\nthrow {code: "oops"}\ncatch e\nthrow e\nend try\ncatch e\nsay e\nend try\nend demo';
  expect(advice(source, 'try-write-before-fail')).toHaveLength(1);
});

test('manifest Library imports and supplied checker bindings use the same advice', () => {
  const source = 'use smallest from custom as min\non demo\nsay min\nend demo';
  const manifest = {
    ...fixtureManifest,
    libraries: [{ name: 'custom', source: 'constant smallest = 1' }],
  };
  const parsed = parseSourceRecovering(source);
  const checked = checkSource(source, {
    libraries: { custom: { smallest: 'constant' } },
  });
  expect(checked.tree).not.toBeNull();
  const standalone = lintSyntax(parsed.tree, { manifest });
  expect(standalone.map(l => l.id)).toEqual(['shadows-builtin']);
  expect(
    lintSyntax(parsed.tree, { manifest, bindings: checked.tree! }),
  ).toEqual(standalone);
});

test('key presence proofs expire across calls in a conjunction or enclosing condition', () => {
  const head =
    'script variable m = {title: ""}\nfunction clear\nput {} into m\nreturn true\nend clear\non demo\n';
  for (const body of [
    'if "title" is in the keys of m and clear() and the "title" of m is empty then say 1',
    'if "title" is in the keys of m and clear() then\nif the "title" of m is empty then say 1\nend if',
  ]) {
    const source = head + body + '\nend demo';
    expect(checkSource(source).ok).toBe(true);
    expect(advice(source, 'is-empty-on-missing-key')).toHaveLength(1);
  }
});

test('caught-error analysis carries writes through finally and loop back edges', () => {
  for (const body of [
    'try\nput 1 into count\nfinally\nthrow {code: "oops"}\nend try',
    'try\nput 1 into count\nreturn\nfinally\nthrow {code: "oops"}\nend try',
    'repeat 2 times\nput 1 / count into x\nput 0 into count\nend repeat',
    'repeat 2 times\nput 1 into count\nexit repeat\nend repeat\nthrow {code: "oops"}',
  ]) {
    const source = caught(body).replace('count = 0', 'count = 1');
    expect(checkSource(source).ok).toBe(true);
    expect(advice(source, 'try-write-before-fail')).toHaveLength(1);
  }
  for (const body of [
    'repeat 2 times\nput 1 into count\nexit repeat\nend repeat',
    'repeat 2 times\nput 1 into count\nnext repeat\nend repeat',
    'repeat 1 times\nput 1 / count into x\nput 0 into count\nend repeat',
  ]) {
    const source = caught(body).replace('count = 0', 'count = 1');
    expect(checkSource(source).ok).toBe(true);
    expect(advice(source, 'try-write-before-fail')).toEqual([]);
  }
});

test('finally keeps returning writes separate from the live successor', () => {
  const source = caught(
    'try\nif flag then\nput 1 into count\nreturn\nend if\nfinally\nput 1 into local\nend try\nthrow {code: "oops"}',
  );
  expect(checkSource(source).ok).toBe(true);
  expect(advice(source, 'try-write-before-fail')).toEqual([]);
});

test('key presence guards outside loops expire on a mutating back edge', () => {
  const source =
    'on demo m\nif "title" is in the keys of m then\nrepeat 2 times\nif the "title" of m is empty then say 1\nput {} into m\nend repeat\nend if\nend demo';
  expect(checkSource(source).ok).toBe(true);
  expect(advice(source, 'is-empty-on-missing-key')).toHaveLength(1);
  expect(
    advice(source.replace('2 times', '1 times'), 'is-empty-on-missing-key'),
  ).toEqual([]);
  expect(
    advice(
      'on demo m\nrepeat 2 times\nif "title" is in the keys of m then\nif the "title" of m is empty then say 1\nend if\nput {} into m\nend repeat\nend demo',
      'is-empty-on-missing-key',
    ),
  ).toEqual([]);
});
