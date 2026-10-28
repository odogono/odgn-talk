// Shared Links: `#p1.<deflated base64url>` carrying a Project (#1678).
import { expect, test } from 'bun:test';
import { createElement, createProject } from '../src/model';
import { serializeProject } from '../src/project-file';
import {
  readSharedLink,
  sharedLinkFor,
  sharedLinkOf,
  withoutFragment,
} from '../src/shared-link';

const PAGE = 'https://northtalk.org/folio/?open=x.folio#old';

const sample = () => {
  const project = createProject('Lighthouse');
  project.script = 'on startPlay\n  put "→ ok" into it\nend startPlay\n';
  project.pages[0]!.elements.push(createElement('button', 'go'));
  return project;
};

test('a Project survives the round trip through its link', async () => {
  const project = sample();
  const link = await sharedLinkFor(project, PAGE);
  expect(link.startsWith('https://northtalk.org/folio/#p1.')).toBe(true);
  expect(link).toMatch(/^[^#]*#p1\.[\w-]+$/u);
  const payload = sharedLinkOf(link)!;
  const read = await readSharedLink(payload);
  expect(serializeProject(read)).toEqual(serializeProject(project));
});

test('refuses a Project with assets and suggests a .folio file', async () => {
  const project = sample();
  project.assets.push({
    name: 'lamp',
    hash: '0'.repeat(64),
    mediaType: 'image/png',
    size: 1,
    fileName: 'lamp.png',
  });
  await expect(sharedLinkFor(project, PAGE)).rejects.toThrow(/\.folio file/u);
});

test('reads only p1 fragments, ignoring the Playground’s v1 links', () => {
  expect(sharedLinkOf('https://northtalk.org/folio/#p1.abc')).toBe('abc');
  expect(sharedLinkOf('https://northtalk.org/folio/#v1.abc')).toBeUndefined();
  expect(sharedLinkOf('https://northtalk.org/folio/#p1.')).toBeUndefined();
  expect(sharedLinkOf('https://northtalk.org/folio/')).toBeUndefined();
  expect(withoutFragment('https://northtalk.org/folio/#p1.abc')).toBe(
    'https://northtalk.org/folio/',
  );
});

test('a damaged or cut-short link says so', async () => {
  const payload = sharedLinkOf(await sharedLinkFor(sample(), PAGE))!;
  await expect(readSharedLink(payload.slice(0, 10))).rejects.toThrow(
    /damaged or cut short/u,
  );
  await expect(readSharedLink('!!!')).rejects.toThrow(/damaged/u);
});
