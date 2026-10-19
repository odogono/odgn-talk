import { expect, test } from 'bun:test';
import { woodpeckerPullRequest } from './woodpecker';

const commit = 'a'.repeat(40);
const environment = {
  CI_COMMIT_PULL_REQUEST: '42',
  CI_COMMIT_SHA: commit,
  CI_REPO: 'odogono/odgn-talk',
};
const metadata = {
  base: { ref: 'main' },
  body: 'Description',
  head: { sha: commit },
  title: 'ci(repo): Check Conventions',
};
const response = (data: unknown) => async () => Response.json(data);

test('reads current PR metadata and preserves shell syntax as environment data', async () => {
  const body =
    'BREAKING CHANGE: Keep this footer\n$(touch /tmp/should-not-exist)\n"quoted"';
  const title = 'ci(repo): Preserve $(literal) text';
  const urls: string[] = [];
  expect(
    await woodpeckerPullRequest(environment, async url => {
      urls.push(url);
      return Response.json({ ...metadata, body, title });
    }),
  ).toEqual({ BASE_REF: 'main', PR_BODY: body, PR_TITLE: title });
  expect(urls).toEqual([
    'https://api.github.com/repos/odogono/odgn-talk/pulls/42',
  ]);
});

test('handles a missing PR body and uses the current base branch', async () => {
  expect(
    await woodpeckerPullRequest(
      environment,
      response({ ...metadata, base: { ref: 'release/v1' }, body: null }),
    ),
  ).toEqual({
    BASE_REF: 'release/v1',
    PR_BODY: '',
    PR_TITLE: metadata.title,
  });
});

test('rejects stale pipeline revisions', async () => {
  await expect(
    woodpeckerPullRequest(
      environment,
      response({ ...metadata, head: { sha: 'b'.repeat(40) } }),
    ),
  ).rejects.toThrow('PR head changed');
});

test('fails closed on API errors and incomplete metadata', async () => {
  await expect(
    woodpeckerPullRequest(
      environment,
      async () => new Response('', { status: 403 }),
    ),
  ).rejects.toThrow('HTTP 403');
  await expect(
    woodpeckerPullRequest(environment, async () => {
      throw new Error('connection failed');
    }),
  ).rejects.toThrow('connection failed');
  for (const data of [
    null,
    {},
    { ...metadata, body: undefined },
    { ...metadata, title: 42 },
    { ...metadata, head: null },
    { ...metadata, base: { ref: '' } },
  ]) {
    await expect(
      woodpeckerPullRequest(environment, response(data)),
    ).rejects.toThrow('incomplete PR metadata');
  }
});

test('rejects missing or malformed pipeline identity before requesting metadata', async () => {
  for (const variables of [
    {},
    { ...environment, CI_REPO: '../repo?x/y' },
    { ...environment, CI_REPO: 'odogono/..' },
    { ...environment, CI_COMMIT_PULL_REQUEST: '0' },
    { ...environment, CI_COMMIT_PULL_REQUEST: '42/../43' },
    { ...environment, CI_COMMIT_SHA: '' },
  ]) {
    await expect(
      woodpeckerPullRequest(variables, async () => {
        throw new Error('metadata must not be requested');
      }),
    ).rejects.toThrow('repository, number and head SHA are required');
  }
});
