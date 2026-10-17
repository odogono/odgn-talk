import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitEnv, insertSection, releaseNotes } from './release-notes';

const CHANGELOG =
  '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- Pending.\n\n## [0.1.0] - 2026-10-01\n\n- First.\n';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A repository with the changelog committed, so tests can add files and tags.
const repo = (): {
  commit: (files: Record<string, string>) => void;
  root: string;
  tag: (name: string) => void;
} => {
  const root = mkdtempSync(join(tmpdir(), 'northtalk-release-'));
  dirs.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q');
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git('add', '.');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      'x',
    );
  };
  commit({ 'impl/ts/CHANGELOG.md': CHANGELOG });
  return { commit, root, tag: name => git('tag', name) };
};

const fragment = (head: string, entry: string) =>
  `---\n${head}\n---\n${entry}\n`;

test('inserts the section after Unreleased, before the last release', () => {
  expect(insertSection(CHANGELOG, '## [0.1.1] - 2026-10-17\n\n- New.')).toBe(
    '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- Pending.\n\n## [0.1.1] - 2026-10-17\n\n- New.\n\n## [0.1.0] - 2026-10-01\n\n- First.\n',
  );
  expect(insertSection('# C\n\n## [Unreleased]\n', '## [0.1.0] - d')).toBe(
    '# C\n\n## [Unreleased]\n\n## [0.1.0] - d\n',
  );
  expect(() => insertSection('# C\n', '## [0.1.0] - d')).toThrow(
    'no "## [Unreleased]" section',
  );
});

test('collects the ts, spec and breaking fragments added since the latest ts-v* tag', () => {
  const { commit, root, tag } = repo();
  commit({
    'changelog/unreleased/old.md': fragment('type: feat\nscope: ts', 'Old.'),
  });
  tag('ts-v0.1.0');
  commit({
    'changelog/unreleased/cli.md': fragment('type: feat\nscope: cli', 'CLI.'),
    'changelog/unreleased/repo-break.md': fragment(
      'type: fix\nscope: repo\nbreaking: true',
      'Break.',
    ),
    'changelog/unreleased/spec.md': fragment(
      'type: feat\nscope: spec',
      'Spec.',
    ),
    'changelog/unreleased/ts-fix.md': fragment('type: fix\nscope: ts', 'Fix.'),
    'changelog/unreleased/ts-perf.md': fragment(
      'type: perf\nscope: ts',
      'Fast.',
    ),
  });

  const notes = releaseNotes(root, '0.1.1', '2026-10-17');
  expect(notes.tag).toBe('ts-v0.1.0');
  expect(notes.errors).toEqual([]);
  expect(notes.section).toBe(
    [
      '## [0.1.1] - 2026-10-17',
      '',
      '### Breaking',
      '',
      '- **repo:** Break.',
      '',
      '### Added',
      '',
      '- **spec:** Spec.',
      '',
      '### Fixed',
      '',
      '- **ts:** Fix.',
      '',
      '### Performance',
      '',
      '- **ts:** Fast.',
    ].join('\n'),
  );
  expect(notes.changelog).toContain(
    `- Pending.\n\n${notes.section}\n\n## [0.1.0]`,
  );
});

test('uses the highest ts-v* tag and ignores other tags', () => {
  const { commit, root, tag } = repo();
  tag('ts-v0.1.0');
  commit({
    'changelog/unreleased/a.md': fragment('type: feat\nscope: ts', 'A.'),
  });
  tag('ts-v0.10.0');
  tag('reactor-v9.0.0');
  commit({
    'changelog/unreleased/b.md': fragment('type: feat\nscope: ts', 'B.'),
  });

  const notes = releaseNotes(root, '0.10.1', '2026-10-17');
  expect(notes.tag).toBe('ts-v0.10.0');
  expect(notes.section).toBe(
    '## [0.10.1] - 2026-10-17\n\n### Added\n\n- **ts:** B.',
  );
});

test('fails without a ts-v* tag, or with a bad version or fragment', () => {
  const { commit, root, tag } = repo();
  expect(() => releaseNotes(root, '0.1.1', '2026-10-17')).toThrow(
    'no ts-v* tag',
  );
  tag('ts-v0.1.0');
  expect(() => releaseNotes(root, 'v0.1.1', '2026-10-17')).toThrow(
    `"v0.1.1" isn't a version`,
  );
  commit({ 'changelog/unreleased/bad.md': 'Add x.' });
  expect(releaseNotes(root, '0.1.1', '2026-10-17').errors).toEqual([
    'changelog/unreleased/bad.md: it must start with a "---" frontmatter block',
  ]);
});
