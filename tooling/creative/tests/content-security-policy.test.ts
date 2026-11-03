// The page's Content-Security-Policy must let Play fetch Project sounds from
// their blob: URLs to decode them for the sampler; browser test pages carry
// no policy, so only this catches a policy that blocks it.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const policy = (): Map<string, string[]> => {
  const html = readFileSync(
    new URL('../static/index.html', import.meta.url),
    'utf8',
  );
  const content =
    /http-equiv="Content-Security-Policy"\s+content="(?<c>[^"]+)"/u.exec(html)
      ?.groups?.c;
  if (!content) {
    throw new Error('index.html has no Content-Security-Policy');
  }
  return new Map(
    content.split(';').map(part => {
      const [name, ...sources] = part.trim().split(/\s+/u);
      return [name!, sources];
    }),
  );
};

test('Play can fetch Project sounds from blob: URLs', () => {
  const directives = policy();
  const connect =
    directives.get('connect-src') ?? directives.get('default-src');
  expect(connect).toContain('blob:');
  expect(connect).toContain("'self'");
});
