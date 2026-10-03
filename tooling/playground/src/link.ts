// A Shared Link's fragment: the tab sources and, optionally, a Session
// Transcript, as versioned JSON compressed with the platform's deflate and
// written in base64url. The fragment never reaches a server.
import type { Tabs } from './session';

export type Shared = Tabs & { transcript?: string };

const VERSION = 1;
const PREFIX = `v${VERSION}.`;

const pipe = async (
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

const unbase64url = (text: string): Uint8Array => {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
};

/** The fragment for a Shared Link, without its `#`. */
export const encodeLink = async (shared: Shared): Promise<string> => {
  const json = JSON.stringify({
    v: VERSION,
    script: shared.script,
    libraries: shared.libraries.map(l => [l.name, l.source]),
    ...(shared.transcript === undefined
      ? {}
      : { transcript: shared.transcript }),
  });
  return (
    PREFIX +
    base64url(
      await pipe(
        new TextEncoder().encode(json),
        new CompressionStream('deflate-raw'),
      ),
    )
  );
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`The link's ${what} is not text`);
  }
  return value;
};

/** Reads a Shared Link's fragment, with or without its `#`. */
export const decodeLink = async (fragment: string): Promise<Shared> => {
  const body = fragment.replace(/^#/u, '');
  if (!body.startsWith(PREFIX)) {
    throw new Error('This link was made by a newer or unknown Playground');
  }
  const json = new TextDecoder('utf-8', { fatal: true }).decode(
    await pipe(
      unbase64url(body.slice(PREFIX.length)),
      new DecompressionStream('deflate-raw'),
    ),
  );
  const data = JSON.parse(json) as Record<string, unknown>;
  if (data.v !== VERSION || !Array.isArray(data.libraries)) {
    throw new Error('The link is malformed');
  }
  return {
    script: text(data.script, 'Script'),
    libraries: data.libraries.map((l: unknown) => {
      if (!Array.isArray(l)) {
        throw new Error('The link is malformed');
      }
      return {
        name: text(l[0], 'Library name'),
        source: text(l[1], 'Library'),
      };
    }),
    ...(data.transcript === undefined
      ? {}
      : { transcript: text(data.transcript, 'Transcript') }),
  };
};
