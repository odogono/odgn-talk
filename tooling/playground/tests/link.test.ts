import { expect, test } from 'bun:test';
import { decodeLink, encodeLink } from '../src/link';

test('a Shared Link round-trips its tabs and Transcript', async () => {
  const shared = {
    script: 'on greet name\n  say "héllo 👋 " & name\nend greet\n',
    libraries: [{ name: 'util', source: 'function f\n  return 1\nend f\n' }],
    transcript: '> greet "Ann"\n@ 2026-09-30T10:00:00Z\nhéllo 👋 Ann\n',
  };
  const fragment = await encodeLink(shared);
  expect(fragment).toMatch(/^v1\.[\w-]+$/u);
  expect(await decodeLink(`#${fragment}`)).toEqual(shared);
  const { transcript: _, ...source } = shared;
  expect(await decodeLink(await encodeLink(source))).toEqual(source);
});

test('refuses an unknown version', async () => {
  expect(decodeLink('#v2.abc')).rejects.toThrow('unknown Playground');
});
