import { expect, test } from 'bun:test';
import {
  isExemptLocalMessage,
  parseCommitSubject,
  requiresChangelog,
  splitMessage,
  type Subject,
} from './message';

const parse = (text: string): Subject => {
  const result = parseCommitSubject(text);
  if ('errors' in result) {
    throw new Error(result.errors.join('\n'));
  }
  return result.subject;
};

test('reads a subject with and without a scope and "!"', () => {
  expect(parse('feat(ts): Add the Store capability (#226)')).toEqual({
    breaking: false,
    description: 'Add the Store capability (#226)',
    scope: 'ts',
    type: 'feat',
  });
  expect(parse('docs: Record ADR 0051')).toMatchObject({
    breaking: false,
    scope: undefined,
    type: 'docs',
  });
  expect(parse('refactor(spec)!: Rename Grants')).toMatchObject({
    breaking: true,
    scope: 'spec',
  });
  expect(parse('fix: `wait for` keeps its deadline')).toMatchObject({
    type: 'fix',
  });
});

test('rejects malformed subjects, unknown types and scopes, and style', () => {
  expect(parseCommitSubject('Add the Store capability')).toEqual({
    errors: [
      '"Add the Store capability" isn\'t "type(scope): Description"; the scope and a "!" before the colon are optional',
    ],
  });
  expect(parseCommitSubject('feat:Add x')).toHaveProperty('errors');
  expect(parseCommitSubject('feature: Add x')).toEqual({
    errors: [
      'unknown type "feature"; use one of feat, fix, perf, refactor, docs, test, build, ci, chore, revert',
    ],
  });
  expect(parseCommitSubject('feat(core): Add x')).toEqual({
    errors: [
      'unknown scope "core"; use one of spec, ts, cli, tools, corpus, repo',
    ],
  });
  expect(parseCommitSubject('feat(): Add x')).toHaveProperty('errors');
  expect(parseCommitSubject('feat: add x.')).toEqual({
    errors: [
      'the description "add x." must start with a capital letter',
      "the description doesn't end with a full stop",
    ],
  });
});

test('requires a changelog entry for feat, fix, perf and breaking changes', () => {
  expect(requiresChangelog(parse('feat: Add x'))).toBe(true);
  expect(requiresChangelog(parse('fix(ts): Fix x'))).toBe(true);
  expect(requiresChangelog(parse('perf: Speed up x'))).toBe(true);
  expect(requiresChangelog(parse('refactor: Move x'))).toBe(false);
  expect(requiresChangelog(parse('ci(repo): Check titles'))).toBe(false);
  expect(requiresChangelog(parse('refactor!: Rename x'))).toBe(true);
  expect(
    requiresChangelog(
      parse('refactor: Rename x'),
      'Details.\n\nBREAKING CHANGE: x is now y',
    ),
  ).toBe(true);
  expect(
    requiresChangelog(
      parse('refactor: Rename x'),
      'Mentions BREAKING CHANGE: inline',
    ),
  ).toBe(false);
});

test('lets through commits git writes or a squash removes', () => {
  expect(isExemptLocalMessage('fixup! feat: Add x')).toBe(true);
  expect(isExemptLocalMessage('squash! feat: Add x')).toBe(true);
  expect(isExemptLocalMessage("Merge branch 'main' into x")).toBe(true);
  expect(isExemptLocalMessage('Revert "feat: Add x"')).toBe(true);
  expect(isExemptLocalMessage('Add x')).toBe(false);
  expect(isExemptLocalMessage('revert: Undo x')).toBe(false);
});

test('splits a message file, dropping git comment lines', () => {
  expect(
    splitMessage(
      '# Please enter the commit message\n\nfeat: Add x  \n\nWhy.\n# On branch x\n',
    ),
  ).toEqual({ body: 'Why.', subject: 'feat: Add x' });
  expect(splitMessage('# only comments\n')).toEqual({ body: '', subject: '' });
});
