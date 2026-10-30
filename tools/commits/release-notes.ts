#!/usr/bin/env bun
// Writes the release notes for a version of a published package into its
// CHANGELOG.md: the fragments added to changelog/unreleased/ since the
// package's latest tag whose scope is the package's or spec, or that are
// breaking and not another package's. Fragments are shared by every package,
// so they stay where they are.
//
//   bun tools/commits/release-notes.ts ts 0.1.1 [--dry-run]
//   bun tools/commits/release-notes.ts go 0.1.0 [--dry-run]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changelogSection, type Fragment, parseFragment } from './fragment';

const UNRELEASED = 'changelog/unreleased';
const VERSION = /^\d+\.\d+\.\d+(?:-[\d.A-Za-z-]+)?$/;

// Each published package: its scope, its changelog and its release tags.
export const PACKAGES = {
  go: { changelog: 'impl/go/CHANGELOG.md', tagPrefix: 'impl/go/v' },
  ts: { changelog: 'impl/ts/CHANGELOG.md', tagPrefix: 'ts-v' },
} as const;

export type Package = keyof typeof PACKAGES;

const isPackage = (name: string): name is Package =>
  Object.hasOwn(PACKAGES, name);

// Whether a fragment belongs in `pkg`'s notes. tools, repo and cli code
// doesn't ship in it; spec changes alter its behaviour. A breaking change
// ships unless another package's scope says it is that package's alone.
export const shipsIn = (pkg: Package, fragment: Fragment): boolean =>
  fragment.scope === pkg ||
  fragment.scope === 'spec' ||
  (fragment.breaking &&
    !(fragment.scope !== undefined && isPackage(fragment.scope)));

// Inserts `section` after the `## [Unreleased]` section, before the next
// release, or at the end when there is none.
export const insertSection = (changelog: string, section: string): string => {
  const unreleased = changelog.indexOf('\n## [Unreleased]');
  if (unreleased === -1) {
    throw new Error('the changelog has no "## [Unreleased]" section');
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

// The fragments added since `pkg`'s latest tag, read as they are now.
export const releaseFragments = (
  root: string,
  pkg: Package,
): { errors: string[]; fragments: Fragment[]; tag: string } => {
  const { tagPrefix } = PACKAGES[pkg];
  const tag = git(
    root,
    'tag',
    '--list',
    `${tagPrefix}*`,
    '--sort=-v:refname',
  ).split('\n')[0];
  if (!tag) {
    throw new Error(
      `no ${tagPrefix}* tag to collect fragments since; write the first release section by hand`,
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
    } else if (shipsIn(pkg, result.fragment)) {
      fragments.push(result.fragment);
    }
  }
  return { errors, fragments, tag };
};

// The dated section for `version`, and the changelog with it inserted.
export const releaseNotes = (
  root: string,
  pkg: Package,
  version: string,
  date: string,
): { changelog: string; errors: string[]; section: string; tag: string } => {
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" isn't a version like 0.1.1`);
  }
  const { errors, fragments, tag } = releaseFragments(root, pkg);
  const section = changelogSection(`[${version}] - ${date}`, fragments);
  const changelog = insertSection(
    readFileSync(join(root, PACKAGES[pkg].changelog), 'utf8'),
    section,
  );
  return { changelog, errors, section, tag };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [pkg, version] = args.filter(arg => arg !== '--dry-run');
  if (!pkg || !isPackage(pkg) || !version) {
    console.error(
      `usage: release-notes.ts <${Object.keys(PACKAGES).join('|')}> <version> [--dry-run]`,
    );
    process.exit(2);
  }
  const root = resolve(import.meta.dir, '../..');
  try {
    const { changelog, errors, section, tag } = releaseNotes(
      root,
      pkg,
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
      const { changelog: path } = PACKAGES[pkg];
      writeFileSync(join(root, path), changelog);
      console.log(`${path}: added ${version}, with fragments since ${tag}`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
