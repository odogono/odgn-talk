// Adapt Woodpecker's GitHub PR events to the existing Conventions checker.
// Fetch current metadata: CI_COMMIT_MESSAGE omits the PR body, and a queued
// webhook can contain an older title or body.
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const requestPullRequest = (url: string) =>
  fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });

export const woodpeckerPullRequest = async (
  environment: Record<string, string | undefined>,
  request: (url: string) => Promise<Response> = requestPullRequest,
): Promise<{ BASE_REF: string; PR_BODY: string; PR_TITLE: string }> => {
  const repo = environment.CI_REPO ?? '';
  const number = environment.CI_COMMIT_PULL_REQUEST ?? '';
  const commit = environment.CI_COMMIT_SHA ?? '';
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split('/').some(part => part === '.' || part === '..') ||
    !/^[1-9]\d*$/.test(number) ||
    !/^[\da-f]{40}$/.test(commit)
  ) {
    throw new Error('GitHub PR repository, number and head SHA are required');
  }

  const response = await request(
    `https://api.github.com/repos/${repo}/pulls/${number}`,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub PR metadata request failed: HTTP ${response.status}`,
    );
  }
  const data: unknown = await response.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !('title' in data) ||
    typeof data.title !== 'string' ||
    !('body' in data) ||
    (data.body !== null && typeof data.body !== 'string') ||
    !('head' in data) ||
    typeof data.head !== 'object' ||
    data.head === null ||
    !('sha' in data.head) ||
    typeof data.head.sha !== 'string' ||
    !('base' in data) ||
    typeof data.base !== 'object' ||
    data.base === null ||
    !('ref' in data.base) ||
    typeof data.base.ref !== 'string' ||
    data.base.ref === ''
  ) {
    throw new Error('GitHub returned incomplete PR metadata');
  }
  if (data.head.sha !== commit) {
    throw new Error('PR head changed; run Conventions on the latest revision');
  }
  return {
    BASE_REF: data.base.ref,
    PR_BODY: data.body ?? '',
    PR_TITLE: data.title,
  };
};

if (import.meta.main) {
  try {
    const metadata = await woodpeckerPullRequest(process.env);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (head !== process.env.CI_COMMIT_SHA) {
      throw new Error('Checkout does not match the PR head SHA');
    }
    execFileSync('git', ['check-ref-format', '--branch', metadata.BASE_REF], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${metadata.BASE_REF}:refs/remotes/origin/${metadata.BASE_REF}`,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, 'tools/commits/check.ts'), 'pr'],
      {
        cwd: ROOT,
        env: { ...process.env, ...metadata },
        stdio: 'inherit',
      },
    );
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(
      'conventions:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
