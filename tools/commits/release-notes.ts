#!/usr/bin/env bun
// Writes the release notes for a version of @northtalk/ts into
// impl/ts/CHANGELOG.md: the fragments added to changelog/unreleased/ since the
// latest ts-v* tag whose scope is ts or spec, or that are breaking. Fragments
// are shared by every package, so they stay where they are.
//
//   bun tools/commits/release-notes.ts 0.1.1 [--dry-run]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changelogSection, type Fragment, parseFragment } from './fragment';

const UNRELEASED = 'changelog/unreleased';
const CHANGELOG = 'impl/ts/CHANGELOG.md';
const VERSION = /^\d+\.\d+\.\d+(?:-[\d.A-Za-z-]+)?$/;

// Whether a fragment belongs in the package's notes. tools, repo and cli code
// doesn't ship in the tarball; spec changes alter the package's behaviour.
export const shipsInTs = (fragment: Fragment): boolean =>
  fragment.breaking || fragment.scope === 'ts' || fragment.scope === 'spec';

// Inserts `section` after the `## [Unreleased]` section, before the next
// release, or at the end when there is none.
export const insertSection = (changelog: string, section: string): string => {
  const unreleased = changelog.indexOf('\n## [Unreleased]');
  if (unreleased === -1) {
    throw new Error(`${CHANGELOG} has no "## [Unreleased]" section`);
  }
  const next = changelog.indexOf('\n## ', unreleased + 1);
  if (next === -1) {
    return `${changelog.trimEnd()}\n\n${section}\n`;
  }
  return `${changelog.slice(0, next + 1)}${section}\n\n${changelog.slice(next + 1)}`;
};

// The environment without git's GIT_* variables, which a hook sets and which
// would point git at the hook's repository rather than `root`.
export const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv(),
  }).trim();

// The fragments added since the latest ts-v* tag, read as they are now.
export const releaseFragments = (
  root: string,
): { errors: string[]; fragments: Fragment[]; tag: string } => {
  const tag = git(root, 'tag', '--list', 'ts-v*', '--sort=-v:refname').split(
    '\n',
  )[0];
  if (!tag) {
    throw new Error(
      'no ts-v* tag to collect fragments since; write the first release section by hand',
    );
  }
  const added = git(
    root,
    'diff',
    '--name-only',
    '--diff-filter=A',
    tag,
    'HEAD',
    '--',
    UNRELEASED,
  )
    .split('\n')
    .filter(path => path.endsWith('.md'))
    .sort();
  const errors: string[] = [];
  const fragments: Fragment[] = [];
  for (const path of added) {
    const result = parseFragment(readFileSync(join(root, path), 'utf8'));
    if ('errors' in result) {
      errors.push(...result.errors.map(error => `${path}: ${error}`));
    } else if (shipsInTs(result.fragment)) {
      fragments.push(result.fragment);
    }
  }
  return { errors, fragments, tag };
};

// The dated section for `version`, and the changelog with it inserted.
export const releaseNotes = (
  root: string,
  version: string,
  date: string,
): { changelog: string; errors: string[]; section: string; tag: string } => {
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" isn't a version like 0.1.1`);
  }
  const { errors, fragments, tag } = releaseFragments(root);
  const section = changelogSection(`[${version}] - ${date}`, fragments);
  const changelog = insertSection(
    readFileSync(join(root, CHANGELOG), 'utf8'),
    section,
  );
  return { changelog, errors, section, tag };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [version] = args.filter(arg => arg !== '--dry-run');
  if (!version) {
    console.error('usage: release-notes.ts <version> [--dry-run]');
    process.exit(2);
  }
  const root = resolve(import.meta.dir, '../..');
  try {
    const { changelog, errors, section, tag } = releaseNotes(
      root,
      version,
      new Date().toISOString().slice(0, 10),
    );
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0) {
      process.exit(1);
    }
    if (dryRun) {
      console.log(section);
    } else {
      writeFileSync(join(root, CHANGELOG), changelog);
      console.log(
        `${CHANGELOG}: added ${version}, with fragments since ${tag}`,
      );
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
