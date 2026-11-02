// Reading `?open=<url>` and fetching the `.folio` file it names (#1677).
import { expect, test } from 'bun:test';
import {
  fetchExampleFile,
  fetchProjectFile,
  fileNameOf,
  openUrlOf,
  withoutOpenParam,
} from '../src/open-url';

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const fetchGiving = (response: Response | Error): typeof fetch =>
  (() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)) as unknown as typeof fetch;

test('reads the open parameter, resolved against the page', () => {
  expect(
    openUrlOf(
      'https://northtalk.org/folio/?open=https%3A%2F%2Fa.example%2Fx.folio',
    ),
  ).toBe('https://a.example/x.folio');
  expect(
    openUrlOf('https://northtalk.org/folio/?open=projects/tetris.folio'),
  ).toBe('https://northtalk.org/folio/projects/tetris.folio');
  expect(openUrlOf('https://northtalk.org/folio/')).toBeUndefined();
  expect(openUrlOf('https://northtalk.org/folio/?open=')).toBeUndefined();
});

test('drops only the open parameter from the address', () => {
  expect(
    withoutOpenParam('https://northtalk.org/folio/?open=x.folio&a=1#h'),
  ).toBe('https://northtalk.org/folio/?a=1#h');
  expect(withoutOpenParam('https://northtalk.org/folio/?open=x.folio')).toBe(
    'https://northtalk.org/folio/',
  );
});

test('names the file from the last path segment', () => {
  expect(fileNameOf('https://a.example/my%20game.folio?v=2')).toBe(
    'my game.folio',
  );
  expect(fileNameOf('https://a.example/')).toBe('project.folio');
});

test('gives the bytes of a .folio file', async () => {
  const bytes = await fetchProjectFile(
    'https://a.example/x.folio',
    fetchGiving(new Response(ZIP)),
  );
  expect([...bytes]).toEqual([...ZIP]);
});

test('says why a file could not be opened', async () => {
  await expect(
    fetchProjectFile('not a url', fetchGiving(new Response(ZIP))),
  ).rejects.toThrow("isn't a web address");
  await expect(
    fetchProjectFile('ftp://a.example/x.folio', fetchGiving(new Response(ZIP))),
  ).rejects.toThrow("isn't an http or https address");
  await expect(
    fetchProjectFile(
      'https://a.example/x.folio',
      fetchGiving(new TypeError('Failed to fetch')),
    ),
  ).rejects.toThrow('CORS');
  await expect(
    fetchProjectFile(
      'https://a.example/x.folio',
      fetchGiving(new Response('', { status: 404, statusText: 'Not Found' })),
    ),
  ).rejects.toThrow('a.example answered 404 Not Found.');
  await expect(
    fetchProjectFile(
      'https://a.example/x.folio',
      fetchGiving(new Response('<html>')),
    ),
  ).rejects.toThrow("isn't a .folio file");
});

test('fetches an Example Project from its file under Folio', async () => {
  const asked: string[] = [];
  const fetchFn = ((url: string) => {
    asked.push(url);
    return Promise.resolve(new Response(ZIP));
  }) as unknown as typeof fetch;
  const bytes = await fetchExampleFile('first-sounds', fetchFn);
  expect([...bytes]).toEqual([...ZIP]);
  expect(asked).toEqual(['projects/first-sounds.folio']);
});

test('an Example Project never fetched online says so when offline', async () => {
  // The service worker answers 503 for a file it never kept (ADR 0161).
  for (const answer of [
    new Response('', { status: 503 }),
    new TypeError('Failed to fetch'),
  ]) {
    await expect(
      fetchExampleFile('first-sounds', fetchGiving(answer)),
    ).rejects.toThrow('Open it once while online');
  }
});
