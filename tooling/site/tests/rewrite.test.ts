import { describe, expect, test } from 'bun:test';
import { githubBlob, rewritePage, rewriteTarget } from '../src/rewrite.ts';

const slugs = new Map([
  ['docs/tour.md', 'learn/tour'],
  ['GLOSSARY.md', 'reference/glossary'],
  ['spec/03-values.md', 'reference/spec/03-values'],
]);

describe('rewriteTarget', () => {
  test('a listed file becomes a site path, keeping its fragment', () => {
    expect(rewriteTarget('../GLOSSARY.md#run', 'docs/tour.md', slugs)).toBe(
      '/reference/glossary/#run',
    );
    expect(rewriteTarget('03-values.md', 'spec/02-grammar.md', slugs)).toBe(
      '/reference/spec/03-values/',
    );
  });

  test('any other repo path goes to GitHub', () => {
    expect(rewriteTarget('adr/', 'docs/tour.md', slugs)).toBe(
      `${githubBlob}docs/adr`,
    );
    expect(
      rewriteTarget('../impl/ts/src/core.ts#L3', 'docs/tour.md', slugs),
    ).toBe(`${githubBlob}impl/ts/src/core.ts#L3`);
  });

  test('URLs and same-page fragments are unchanged', () => {
    for (const target of [
      'https://example.com/a.md',
      '#values',
      'mailto:a@b.c',
    ]) {
      expect(rewriteTarget(target, 'docs/tour.md', slugs)).toBe(target);
    }
  });
});

describe('rewritePage', () => {
  test('takes the first heading as the title and rewrites links outside code', () => {
    const page = rewritePage(
      '# Tour\n\nSee [values](../spec/03-values.md).\n\n```md\n[x](../GLOSSARY.md)\n# not a title\n```\n\n[ref]: ../GLOSSARY.md\n',
      'docs/tour.md',
      slugs,
    );
    expect(page.title).toBe('Tour');
    expect(page.body).toBe(
      'See [values](/reference/spec/03-values/).\n\n```md\n[x](../GLOSSARY.md)\n# not a title\n```\n\n[ref]: /reference/glossary/\n',
    );
  });

  test('a listed title replaces the heading', () => {
    expect(
      rewritePage('# NorthTalk\n\nTerms.', 'GLOSSARY.md', slugs, 'Glossary'),
    ).toEqual({
      body: 'Terms.',
      title: 'Glossary',
    });
  });
});
