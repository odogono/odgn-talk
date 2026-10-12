import { describe, expect, test } from 'bun:test';
import { anchors, links, withoutCode } from './check';

describe('withoutCode', () => {
  test('blanks fences and spans but keeps line numbers', () => {
    const text = 'a `[x](y.md)` b\n```\n[z](w.md)\n```\nc';
    const out = withoutCode(text);
    expect(out.split('\n')).toHaveLength(5);
    expect(out).not.toContain('y.md');
    expect(out).not.toContain('w.md');
    expect(out).toContain('c');
  });
});

describe('anchors', () => {
  test('follow GitHub slugs, numbering repeats', () => {
    const found = anchors(
      '# The `sqlite` factory\n## Lists and maps\n## Lists and maps\n### JSON & the Value Encoding\n',
    );
    expect([...found]).toEqual([
      'the-sqlite-factory',
      'lists-and-maps',
      'lists-and-maps-1',
      'json--the-value-encoding',
    ]);
  });

  test('ignore headings inside fences and add explicit ids', () => {
    expect([...anchors('```\n# not\n```\n<a id="here"></a>\n')]).toEqual([
      'here',
    ]);
  });
});

describe('links', () => {
  test('find inline and reference links with lines, skipping URLs', () => {
    const text =
      'see [a](a.md#x) and [b](https://example.com)\n\n[c]: ../c.md\n[d](mailto:x@y.z)';
    expect(links(text)).toEqual([
      { target: 'a.md#x', line: 1 },
      { target: '../c.md', line: 3 },
    ]);
  });
});
