#!/usr/bin/env bun
// Checks commit messages and changelog fragments, as docs/agents/commits.md
// describes.
//
//   bun tools/commits/check.ts message FILE   check a commit message file
//                                            (the commit-msg hook runs this)
//   bun tools/commits/check.ts pr             check a PR (CI runs this)
//   bun tools/commits/check.ts branch         check the branch's fragments
//                                            and ADR numbers (the pre-push
//                                            hook runs this)
//
// `pr` reads the PR's title and body from PR_TITLE and PR_BODY, and its base
// branch from BASE_REF. The title must be a valid subject. When the change
// needs a changelog entry, the PR must add or change a fragment under
// changelog/unreleased/, every fragment it touches must be valid, and one of
// them must match the title's type and scope.
//
// `branch` has no PR title, so it checks the commits since origin/BASE_REF:
// when any needs a changelog entry, one touched fragment must match one of
// them. An ADR the branch adds must not take a number origin/BASE_REF has
// given another ADR, which parallel worktrees otherwise find only on merge.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fragmentMatches, parseFragment } from './fragment';
import {
  CHANGELOG_TYPES,
  isBreaking,
  isExemptLocalMessage,
  parseCommitSubject,
  requiresChangelog,
  splitMessage,
} from './message';

const ROOT = resolve(import.meta.dir, '../..');
const UNRELEASED = 'changelog/unreleased/';
const GUIDE = 'See docs/agents/commits.md.';

const checkMessage = (file: string): string[] => {
  const { subject } = splitMessage(readFileSync(file, 'utf8'));
  if (subject === '' || isExemptLocalMessage(subject)) {
    return [];
  }
  const parsed = parseCommitSubject(subject);
  return 'errors' in parsed ? parsed.errors : [];
};

const BASE = process.env.BASE_REF || 'main';

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// The fragments the change adds or edits, and the problems parsing them.
const touchedFragments = () => {
  const changed = git([
    'diff',
    '--name-only',
    '--diff-filter=AM',
    `origin/${BASE}...HEAD`,
    '--',
    UNRELEASED,
  ])
    .split('\n')
    .filter(path => path.endsWith('.md') && existsSync(join(ROOT, path)));

  const problems: string[] = [];
  const fragments = [];
  for (const path of changed) {
    const result = parseFragment(readFileSync(join(ROOT, path), 'utf8'));
    if ('errors' in result) {
      problems.push(...result.errors.map(error => `${path}: ${error}`));
    } else {
      fragments.push(result.fragment);
    }
  }
  return { changed, fragments, problems };
};

const checkPullRequest = (): string[] => {
  const title = process.env.PR_TITLE ?? '';
  const body = process.env.PR_BODY ?? '';
  const parsed = parseCommitSubject(title);
  if ('errors' in parsed) {
    return parsed.errors.map(error => `PR title: ${error}`);
  }
  const { subject } = parsed;
  const { changed, fragments, problems } = touchedFragments();
  if (!requiresChangelog(subject, body)) {
    return problems;
  }

  const breaking = isBreaking(subject, body);
  const requiresType = (CHANGELOG_TYPES as readonly string[]).includes(
    subject.type,
  );
  const kind = `${subject.type}${subject.scope ? `(${subject.scope})` : ''}${breaking ? ', breaking' : ''}`;
  if (changed.length === 0) {
    problems.push(
      `a ${kind} change needs a changelog fragment under ${UNRELEASED}`,
    );
  } else if (
    problems.length === 0 &&
    !fragments.some(fragment => fragmentMatches(fragment, subject, breaking))
  ) {
    problems.push(
      `no fragment under ${UNRELEASED} matches the PR title's ${kind}; give one ${requiresType ? 'the same type and scope' : 'the same scope'}${breaking ? ' and "breaking: true"' : ''}`,
    );
  }
  return problems;
};

const ADRS = 'docs/adr/';
const adrNumber = (path: string) =>
  /^(\d{4})-/.exec(path.slice(ADRS.length))?.[1];

const checkAdrNumbers = (): string[] => {
  const added = git([
    'diff',
    '--name-only',
    '--diff-filter=A',
    `origin/${BASE}...HEAD`,
    '--',
    ADRS,
  ]).split('\n');
  const taken = new Map(
    git(['ls-tree', '--name-only', `origin/${BASE}`, ADRS])
      .split('\n')
      .map(path => [adrNumber(path), path] as const),
  );
  return added.flatMap(path => {
    const other = taken.get(adrNumber(path));
    return other && other !== path
      ? [
          `${path}: origin/${BASE} already has ADR ${adrNumber(path)} (${other}); take the next free number (docs/agents/domain.md)`,
        ]
      : [];
  });
};

const checkBranchFragments = (): string[] => {
  const { changed, fragments, problems } = touchedFragments();
  const needing = git(['log', '--format=%B%x00', `origin/${BASE}..HEAD`])
    .split('\0')
    .map(message => splitMessage(message))
    .filter(({ subject }) => !isExemptLocalMessage(subject))
    .flatMap(({ body, subject }) => {
      const parsed = parseCommitSubject(subject);
      return 'subject' in parsed && requiresChangelog(parsed.subject, body)
        ? [
            {
              breaking: isBreaking(parsed.subject, body),
              subject: parsed.subject,
            },
          ]
        : [];
    });
  if (needing.length === 0 || problems.length > 0) {
    return problems;
  }
  const kinds = needing
    .map(
      ({ subject }) =>
        `${subject.type}${subject.scope ? `(${subject.scope})` : ''}`,
    )
    .join(', ');
  if (changed.length === 0) {
    return [
      `commits of type ${kinds} need a changelog fragment under ${UNRELEASED}`,
    ];
  }
  if (
    !needing.some(({ breaking, subject }) =>
      fragments.some(fragment => fragmentMatches(fragment, subject, breaking)),
    )
  ) {
    return [
      `no fragment under ${UNRELEASED} matches a commit's type and scope (${kinds}); the PR title's scope goes in the fragment's "scope:"`,
    ];
  }
  return [];
};

const checkBranch = (): string[] => [
  ...checkAdrNumbers(),
  ...checkBranchFragments(),
];

const [mode, file] = process.argv.slice(2);
let problems: string[];
if (mode === 'message' && file) {
  problems = checkMessage(file);
} else if (mode === 'pr') {
  problems = checkPullRequest();
} else if (mode === 'branch') {
  problems = checkBranch();
} else {
  console.error('usage: bun tools/commits/check.ts message FILE | pr | branch');
  process.exit(2);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`commits: ${problem}`);
  }
  console.error(GUIDE);
  process.exit(1);
}
