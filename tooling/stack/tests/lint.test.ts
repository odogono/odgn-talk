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

test('ships twenty-three implemented catalogue entries', () => {
  expect(lintCatalogue).toHaveLength(23);
  expect(lintCatalogue.every(item => item.status === 'implemented')).toBe(true);
  expect(new Set(lintCatalogue.map(item => item.id)).size).toBe(23);
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

test("a tell block's bare ending is advised, and its waiting line in a conditional Join", () => {
  const block = 'on demo\ntell canvas\nfill "red"\nend\nend demo';
  expect(lint(block, { profile: 'beginner' }).lints).toMatchObject([
    { id: 'prefer-explicit-end', span: { line: 4, col: 1 } },
  ]);
  expect(
    lint(block.replace('\nend\nend demo', '\nend tell\nend demo'), {
      profile: 'beginner',
    }).lints,
  ).toEqual([]);
  expect(
    lint(
      'on demo\nwait for all\nif ready then\ntell feed\nfetch "a" and wait\nend tell\nend if\nend wait\nend demo',
    ).lints.map(item => [item.id, item.span.line]),
  ).toContainEqual(['conditional-join-member', 5]);
});

test("a Timeout Block's bare ending is advised as `end timeout`", () => {
  const block = 'on demo\nwith timeout of 1 s\nwait 1 s\nend\nend demo';
  expect(lint(block, { profile: 'beginner' }).lints).toMatchObject([
    {
      id: 'prefer-explicit-end',
      span: { line: 4, col: 1 },
      message: expect.stringContaining('end timeout'),
    },
  ]);
  expect(
    lint(block.replace('\nend\nend demo', '\nend timeout\nend demo'), {
      profile: 'beginner',
    }).lints,
  ).toEqual([]);
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
  // A computed name can't tell which message it sends (ADR 0057).
  expect(
    advice(
      'on ping, queued\nend ping\n' +
        'on demo\nwait for all\nsend ("ping") to me and wait\nend wait\nend demo',
      'serialised-self-join',
    ),
  ).toEqual([]);
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

test('a Fallback Handler is no message for unknown-message, and names its own end', () => {
  const source = 'on any message m\nend';
  expect(lint(source, { manifest: fixtureManifest }).lints).toEqual([]);
  expect(
    lint(source, { profile: 'beginner' }).lints.map(l => l.message),
  ).toEqual([expect.stringContaining('any message')]);
});

test('fallback-routes-known reads the head pattern and either side of `is`', () => {
  const handlers = 'on ping\nend ping\non move a to b\nend move\n';
  for (const [clause, expected] of [
    ['on any message {name: "ping"}', 1],
    ['on any message {name: "move:to:", args: a}', 1],
    ['on any message m where "ping" is the name of m', 1],
    ['on any message m\n  if the name of m is "ping" then return 1', 1],
    ['on any message {name: "pong"}', 0],
    ['on any message m where the name of n is "ping"', 0],
  ] as const) {
    expect(
      advice(`${handlers}${clause}\nend any message`, 'fallback-routes-known'),
    ).toHaveLength(expected);
  }
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

test('collecting advice respects profiles, suppression, splices and shadowing', () => {
  const source =
    'on demo\nput [] into acc\nrepeat 2 times\nput 1 after acc\nend repeat\nend demo';
  expect(lint(source).lints.filter(l => l.id === 'suggest-collecting')).toEqual(
    [],
  );
  expect(
    lint(source, { profile: 'beginner' }).lints.filter(
      l => l.id === 'suggest-collecting',
    ),
  ).toMatchObject([{ level: 'hint', span: { line: 3, col: 1 } }]);
  for (const negative of [
    source.replace('repeat 2', '-- lint: ignore suggest-collecting\nrepeat 2'),
    source.replace('put 1 after', 'put ...[1] after'),
    source.replace(
      'put 1 after acc',
      'put given acc\nput 1 after acc\nend given into f',
    ),
    source.replace('repeat 2 times', 'repeat for each acc in [1]'),
    source.replace('put [] into acc', 'put [] into item 1 of acc'),
    'script variable acc = []\n' + source,
  ]) {
    expect(
      lint(negative, { profile: 'beginner' }).lints.filter(
        l => l.id === 'suggest-collecting',
      ),
    ).toEqual([]);
  }
});

const whose = (text: string, profile?: 'beginner') =>
  lint(text, profile ? { profile } : {}).lints.filter(
    l => l.id === 'suggest-whose',
  );

test('whose advice needs list filter, one plain parameter and a valid condition', () => {
  const source =
    'use filter from list\non demo orders\nput filter(orders, given o: the amount of o > 1) into big\nend demo';
  expect(whose(source)).toEqual([]);
  expect(whose(source, 'beginner')).toMatchObject([
    {
      level: 'hint',
      span: { line: 3, col: 5 },
      message:
        'Consider `every item of … whose …`, with `it` for o, in place of `filter` and a Lambda.',
    },
  ]);
  for (const negative of [
    source.replace('put filter', '-- lint: ignore suggest-whose\nput filter'),
    source.replace('given o:', 'given o, i:'),
    source.replace('given o:', 'given [o]:'),
    source.replace('> 1)', '> f(1))') + '\nfunction f x\nreturn x\nend f',
    source.replace('> 1)', '> it)'),
    source.replace('> 1)', '> 1 and [given p: p] is not empty)'),
    source.replace(
      'given o: the amount of o > 1)',
      'given o\nreturn the amount of o > 1\nend given)',
    ),
    source.replace('use filter from list', 'use filter from mine'),
  ]) {
    expect(whose(negative, 'beginner')).toEqual([]);
  }
});

const spliceAdvice = (source: string) =>
  lint(source, { profile: 'beginner' }).lints.filter(
    l => l.id === 'suggest-list-splice',
  );
const appendScript = (body: string) =>
  `on demo xs, f\nput [] into acc\n${body}\nend demo`;

test('list-splice advice recognizes literals, local aliases and collecting targets', () => {
  for (const source of [
    appendScript('put ([1, 2]) after acc'),
    appendScript('put [] after acc'),
    appendScript('if true then put [1, 2] after acc'),
    appendScript(
      'put [1] into values\nput values into copy\nput copy after acc',
    ),
    appendScript(
      'put [1] into values\nput given: values into read\nread()\nput values after acc',
    ),
    'constant values = [1]\n' + appendScript('put values after acc'),
    appendScript(
      'repeat 2 times collecting 1 into values\nend repeat\nput values after acc',
    ),
    appendScript(
      'repeat 2 times collecting 1 into values\nput values after acc\nend repeat',
    ),
    appendScript(
      'repeat 2 times\nput [1] into values\nput values after acc\nend repeat',
    ),
  ]) {
    expect(checkSource(source).ok).toBe(true);
    expect(spliceAdvice(source)).toHaveLength(1);
  }
});

test('list-splice advice uses the imported list export identity and return kind', () => {
  for (const [name, args] of [
    ['zip', 'xs, xs'],
    ['unique', 'xs'],
    ['reverse', 'xs'],
    ['flatten', 'xs'],
    ['sort', 'xs'],
    ['sortBy', 'xs, f'],
    ['sortWith', 'xs, f'],
    ['filter', 'xs, f'],
    ['map', 'xs, f'],
    ['partition', 'xs, f'],
  ]) {
    const source =
      `use ${name} from list as makeList\n` +
      appendScript(`put makeList(${args}) into values\nput values after acc`);
    expect(checkSource(source).ok).toBe(true);
    expect(spliceAdvice(source)).toHaveLength(1);
  }
  for (const [name, args] of [
    ['sum', 'xs'],
    ['average', 'xs'],
    ['reduce', 'xs, f, 0'],
    ['group', 'xs, f'],
    ['any', 'xs, f'],
    ['all', 'xs, f'],
    ['find', 'xs, f'],
    ['indexOf', 'xs, 1'],
  ]) {
    const source =
      `use ${name} from list\n` +
      appendScript(`put ${name}(${args}) after acc`);
    expect(checkSource(source).ok).toBe(true);
    expect(spliceAdvice(source)).toEqual([]);
  }
  const source =
    'use reverse from list\n' + appendScript('put reverse(xs) after acc');
  expect(spliceAdvice(source)).toHaveLength(1);
  expect(
    lint(source, {
      profile: 'beginner',
      checkOptions: { libraries: { list: { reverse: 'function' } } },
    }).lints.filter(l => l.id === 'suggest-list-splice'),
  ).toEqual([]);
  expect(
    lint(source, {
      profile: 'beginner',
      manifest: {
        ...fixtureManifest,
        libraries: [
          {
            name: 'list',
            source: 'function reverse xs\nreturn 0\nend reverse',
          },
        ],
      },
    }).lints.filter(l => l.id === 'suggest-list-splice'),
  ).toEqual([]);
  expect(
    spliceAdvice(
      'function reverse xs\nreturn 0\nend reverse\n' +
        appendScript('put reverse(xs) after acc'),
    ),
  ).toEqual([]);
});

test('list-splice advice drops uncertain values and respects control flow and Lambda scopes', () => {
  for (const source of [
    appendScript('put xs after acc'),
    appendScript('put ...[1] after acc'),
    appendScript('put 1 after acc'),
    appendScript('put "text" after acc'),
    appendScript('put [1] before acc'),
    appendScript(
      'put [1] into values\nput 0 into values\nput values after acc',
    ),
    appendScript(
      'put [1] into values\nif true then put 0 into values\nput values after acc',
    ),
    appendScript('if true then put [1] into values\nput values after acc'),
    appendScript(
      'put [1] into values\nrepeat 2 times\nput values after acc\nput 0 into values\nend repeat',
    ),
    appendScript(
      'repeat for each x in xs\nput xs after acc\nput x after acc\nend repeat',
    ),
    appendScript(
      'put [1] into values\nput given values: values into f\nput f(0) after acc',
    ),
    appendScript(
      'put [1] into values\nput given values\nput [] into localAcc\nput values after localAcc\nend given into g',
    ),
    appendScript('f(xs)\nput it after acc'),
    appendScript(
      'repeat 2 times collecting 1 into values\nend repeat\nput 0 into values\nput values after acc',
    ),
    'script variable values = [1]\n' + appendScript('put values after acc'),
  ]) {
    expect(checkSource(source).ok).toBe(true);
    expect(spliceAdvice(source)).toEqual([]);
  }
});

test('list-splice advice keeps positions, profiles, suppression and error recovery', () => {
  const source = appendScript('  put [1, 2] after acc');
  expect(
    lint(source).lints.filter(l => l.id === 'suggest-list-splice'),
  ).toEqual([]);
  expect(spliceAdvice(source)).toMatchObject([
    {
      level: 'hint',
      span: { start: source.indexOf('put [1'), line: 3, col: 3 },
    },
  ]);
  expect(
    spliceAdvice(
      source.replace(
        '  put [1',
        '-- lint: ignore suggest-list-splice\n  put [1',
      ),
    ),
  ).toEqual([]);
  expect(spliceAdvice(source.replaceAll('\n', '\r\n'))).toMatchObject([
    { span: { line: 3, col: 3 } },
  ]);
  const broken = appendScript('put [1, +] after acc\nput [2] after acc');
  expect(lint(broken).diagnostics.length).toBeGreaterThan(0);
  expect(spliceAdvice(broken)).toMatchObject([{ span: { line: 4, col: 1 } }]);
});

const race = (body: string, profile: 'beginner' | 'standard' = 'standard') =>
  lint(`on demo k, n\n${body}\nend demo`, { profile }).lints.filter(
    l => l.id === 'store-race',
  );

test('store-race follows a read through locals to a set of the same key and Grant', () => {
  expect(
    race(
      'ask s to get "best"\nput it + 1 into best\nask s to set "best", best',
    ),
  ).toMatchObject([
    {
      level: 'warning',
      message:
        'Another Script can change "best" between this get and set. Use increment or swap to update it in one call.',
      span: { line: 4, col: 10 },
    },
  ]);
  expect(
    race('ask s to get "best"\nask s to set "best", it + 1', 'beginner'),
  ).toMatchObject([{ level: 'hint' }]);
  // The same binding as the key, unchanged in between.
  expect(race('ask s to get k\nask s to set k, it')).toHaveLength(1);
  for (const safe of [
    // Another key, another Grant, or a key binding written in between.
    'ask s to get "best"\nask s to set "other", it',
    'ask s to get "best"\nask t to set "best", it',
    'ask s to get k\nput "x" into k\nask s to set k, it',
    // A value that doesn't come from the read.
    'ask s to get "best"\nask s to set "best", n',
    'ask s to get "best"\nput it into v\nput n into v\nask s to set "best", v',
    // A later `ask` replaces `it`.
    'ask s to get "best"\nask s to keys\nask s to set "best", it',
    // The atomic Operations.
    'ask s to increment "best", n',
    // A nested Lambda is its own context.
    'ask s to get "best"\nput given\nask s to set "best", it\nend given into f',
    '-- lint: ignore store-race\nask s to set "best", 1\nask s to get "best"',
  ]) {
    expect(race(safe)).toEqual([]);
  }
  expect(
    race(
      'ask s to get "best"\nput [it] into v\n-- lint: ignore store-race\nask s to set "best", v',
    ),
  ).toEqual([]);
  // Taint flows through a chunk write into its base.
  expect(
    race(
      'put [] into v\nask s to get "best"\nput it into item 1 of v\nask s to set "best", v',
    ),
  ).toHaveLength(1);
});
