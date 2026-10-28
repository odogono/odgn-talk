/**
 * Shared Links (ADR 0141, #1678): `/folio/#p1.<deflated base64url>` carries
 * a whole asset-free Project in the address's fragment, so it never reaches
 * a server. The payload is `project.json`, compact, through
 * `deflate-raw`. A Project with assets is shared as a `.folio` file
 * instead. The Playground's old `#v1.` links are ignored. No DOM.
 */

import type { Project } from './model';
import {
  migrateProjectJson,
  ProjectFileError,
  serializeProject,
  validateProjectJson,
} from './project-file';
import type { DeepReadonly } from './readonly';

/** The fragment prefix of a Shared Link; part of the public contract. */
export const SHARED_LINK_PREFIX = '#p1.';

const runStream = async (
  stream: CompressionStream | DecompressionStream,
  data: Uint8Array,
): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x80_00) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

const fromBase64Url = (text: string): Uint8Array => {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
};

/**
 * The Shared Link for a Project, resolved against Folio's page address.
 * Throws when the Project has assets, naming the `.folio` file instead.
 */
export const sharedLinkFor = async (
  project: DeepReadonly<Project>,
  page: string,
): Promise<string> => {
  if (project.assets.length) {
    throw new ProjectFileError(
      "This Project has images or sounds, which a link can't carry. Export it as a .folio file to share it.",
    );
  }
  const result = validateProjectJson(project);
  if ('issues' in result) {
    throw new ProjectFileError(
      `This Project cannot be shared: ${result.issues.map(i => `${i.path}: ${i.message}`).join('; ')}.`,
      result.issues,
    );
  }
  const json = new TextEncoder().encode(
    JSON.stringify(serializeProject(result.project)),
  );
  const payload = toBase64Url(
    await runStream(new CompressionStream('deflate-raw'), json),
  );
  const url = new URL(page);
  url.search = '';
  url.hash = '';
  return `${url.href}${SHARED_LINK_PREFIX}${payload}`;
};

/**
 * The payload of the Shared Link a page address carries, or `undefined`
 * when its fragment is not one (including the Playground's `#v1.`).
 */
export const sharedLinkOf = (address: string): string | undefined => {
  const { hash } = new URL(address);
  if (!hash.startsWith(SHARED_LINK_PREFIX)) {
    return undefined;
  }
  return hash.slice(SHARED_LINK_PREFIX.length) || undefined;
};

/** The page address without its fragment. */
export const withoutFragment = (address: string): string => {
  const url = new URL(address);
  url.hash = '';
  return url.href;
};

/**
 * Reads a Shared Link's payload back into a Project, throwing a reader's
 * error when the link is cut short, damaged or from a newer Folio.
 */
export const readSharedLink = async (payload: string): Promise<Project> => {
  let json: Uint8Array;
  try {
    json = await runStream(
      new DecompressionStream('deflate-raw'),
      fromBase64Url(payload),
    );
  } catch {
    throw new ProjectFileError(
      'This link is damaged or cut short. Ask for it again.',
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new ProjectFileError(
      'This link is damaged or cut short. Ask for it again.',
    );
  }
  const result = validateProjectJson(migrateProjectJson(data));
  if ('issues' in result) {
    const [first] = result.issues;
    throw new ProjectFileError(
      `The Project in this link is damaged at ${first!.path}: ${first!.message}.`,
      result.issues,
    );
  }
  if (result.project.assets.length) {
    throw new ProjectFileError(
      "This link names images or sounds, which a link can't carry.",
    );
  }
  return result.project;
};
