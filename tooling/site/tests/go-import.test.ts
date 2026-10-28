import { describe, expect, test } from 'bun:test';
import { goImport } from '../src/go-import.ts';

const get = (path: string) =>
  goImport(new Request(`https://northtalk.org${path}`));

const meta = async (path: string, name: string) => {
  const html = await get(path)!.text();
  return new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html)?.[1];
};

describe('go get', () => {
  test('a module root names the repo and its subdirectory', async () => {
    expect(await meta('/go?go-get=1', 'go-import')).toBe(
      'northtalk.org/go git https://github.com/odogono/odgn-talk impl/go',
    );
    expect(await meta('/go/sqlite?go-get=1', 'go-import')).toBe(
      'northtalk.org/go/sqlite git https://github.com/odogono/odgn-talk impl/go/sqlite',
    );
  });

  test('a package path answers with its module', async () => {
    expect(await meta('/go/session?go-get=1', 'go-import')).toStartWith(
      'northtalk.org/go git',
    );
    expect(
      await meta('/go/sqlite/internal/x?go-get=1', 'go-import'),
    ).toStartWith('northtalk.org/go/sqlite git');
  });

  test('go-source links pkg.go.dev to GitHub lines', async () => {
    expect(await meta('/go/sqlite?go-get=1', 'go-source')).toBe(
      'northtalk.org/go/sqlite https://github.com/odogono/odgn-talk' +
        ' https://github.com/odogono/odgn-talk/tree/main/impl/go/sqlite{/dir}' +
        ' https://github.com/odogono/odgn-talk/blob/main/impl/go/sqlite{/dir}/{file}#L{line}',
    );
  });
});

describe('browsers', () => {
  test('go to pkg.go.dev', () => {
    const response = get('/go/session')!;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://pkg.go.dev/northtalk.org/go/session',
    );
  });
});

describe('other paths', () => {
  test('are not Go module paths', () => {
    for (const path of [
      '/gopher',
      '/go-other',
      '/go-probe',
      '/learn/tour/',
      '/',
    ]) {
      expect(get(`${path}?go-get=1`)).toBeUndefined();
    }
  });
});
