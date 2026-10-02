#!/usr/bin/env bun
// Checks commit messages and changelog fragments, as docs/agents/commits.md
// describes.
//
//   bun tools/commits/check.ts message FILE   check a commit message file
//                                            (the commit-msg hook runs this)
//   bun tools/commits/check.ts pr             check a PR (CI runs this)
//
// `pr` reads the PR's title and body from PR_TITLE and PR_BODY, and its base
// branch from BASE_REF. The title must be a valid subject. When the change
// needs a changelog entry, the PR must add or change a fragment under
// changelog/unreleased/, every fragment it touches must be valid, and one of
// them must match the title's type and scope.

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

const checkPullRequest = (): string[] => {
  const title = process.env.PR_TITLE ?? '';
  const body = process.env.PR_BODY ?? '';
  const base = process.env.BASE_REF || 'main';
  const parsed = parseCommitSubject(title);
  if ('errors' in parsed) {
    return parsed.errors.map(error => `PR title: ${error}`);
  }
  const { subject } = parsed;

  const changed = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=AM',
      `origin/${base}...HEAD`,
      '--',
      UNRELEASED,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
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

const [mode, file] = process.argv.slice(2);
let problems: string[];
if (mode === 'message' && file) {
  problems = checkMessage(file);
} else if (mode === 'pr') {
  problems = checkPullRequest();
} else {
  console.error('usage: bun tools/commits/check.ts message FILE | pr');
  process.exit(2);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`commits: ${problem}`);
  }
  console.error(GUIDE);
  process.exit(1);
}
