// NorthTalk-signed Project Add-ons (ADR 0162, #1967). The release build
// signs the hash of each Project Add-on in the Base and Example Projects it
// publishes with the NorthTalk Ed25519 key; Folio ships only the public key,
// and a signature that verifies against it skips the trust prompt wherever
// the file came from. Anything else, including a missing signature, asks.
import { type AddOnRef, type Project } from '../model';
import { sha256Hex } from '../project-file';
import { type TrustStore } from './trust';

/**
 * The NorthTalk Add-on signing key's public half, as base64 of its raw 32
 * bytes. Rotating the key replaces this in a new Folio release; see
 * "Signing Project Add-ons" in the README.
 */
export const NORTHTALK_ADD_ON_KEY =
  'efG4WaCjWSRtscNTAFoBRPbnUXbwtuaDEq21lbTYyBs=';

/** The environment variable the release build reads the private key from. */
export const SIGNING_KEY_ENV = 'NORTHTALK_ADD_ON_SIGNING_KEY';

const ED25519 = { name: 'Ed25519' } as const;

const toBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
  let text = '';
  for (const byte of new Uint8Array(bytes)) {
    text += String.fromCodePoint(byte);
  }
  return btoa(text);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), c => c.codePointAt(0)!);

/** What is signed: the Add-on's code hash, under a NorthTalk prefix. */
const signedBytes = (hash: string) =>
  new TextEncoder().encode(`northtalk-add-on:${hash}`);

/**
 * Whether a Project Add-on carries a NorthTalk signature that verifies:
 * its hash matches its code and the signature is over that hash. A browser
 * without Ed25519, or a malformed key or signature, verifies nothing.
 */
export const verifyAddOn = async (
  ref: Readonly<AddOnRef>,
  publicKey: string = NORTHTALK_ADD_ON_KEY,
): Promise<boolean> => {
  if (
    ref.code === undefined ||
    ref.hash === undefined ||
    ref.signature === undefined
  ) {
    return false;
  }
  try {
    if ((await sha256Hex(new TextEncoder().encode(ref.code))) !== ref.hash) {
      return false;
    }
    const key = await crypto.subtle.importKey(
      'raw',
      fromBase64(publicKey),
      ED25519,
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      ED25519,
      key,
      fromBase64(ref.signature),
      signedBytes(ref.hash),
    );
  } catch {
    return false;
  }
};

/** A Project Add-on signed with a private key, given as base64 PKCS #8. */
export const signAddOn = async (
  ref: Readonly<AddOnRef>,
  privateKey: string,
): Promise<AddOnRef> => {
  if (ref.code === undefined || ref.hash === undefined) {
    return { ...ref };
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64(privateKey),
    ED25519,
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    ED25519,
    key,
    signedBytes(ref.hash),
  );
  return { ...ref, signature: toBase64(signature) };
};

/** A new signing key pair: the public key raw, the private key PKCS #8. */
export const generateSigningKeys = async (): Promise<{
  privateKey: string;
  publicKey: string;
}> => {
  const pair = (await crypto.subtle.generateKey(ED25519, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    publicKey: toBase64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: toBase64(
      await crypto.subtle.exportKey('pkcs8', pair.privateKey),
    ),
  };
};

/** The hashes of the Project Add-ons in `refs` whose signature verifies. */
export const signedHashes = async (
  refs: readonly Readonly<AddOnRef>[],
  publicKey: string = NORTHTALK_ADD_ON_KEY,
): Promise<string[]> => {
  const hashes: string[] = [];
  for (const ref of refs) {
    if (await verifyAddOn(ref, publicKey)) {
      hashes.push(ref.hash!);
    }
  }
  return hashes;
};

/**
 * Every Project Add-on (one carrying code) whose signature doesn't verify,
 * by id; empty when all of them are signed. The release check uses it.
 */
export const unsignedAddOns = async (
  refs: readonly Readonly<AddOnRef>[],
  publicKey: string = NORTHTALK_ADD_ON_KEY,
): Promise<string[]> => {
  const unsigned: string[] = [];
  for (const ref of refs) {
    if (ref.code !== undefined && !(await verifyAddOn(ref, publicKey))) {
      unsigned.push(ref.id);
    }
  }
  return unsigned;
};

/**
 * Readies a Project the build publishes (#1967): with a private key, signs
 * each Project Add-on; when signatures are required, as the release build
 * requires them, refuses any Project Add-on that doesn't verify.
 */
export const signForPublishing = async (
  project: Project,
  name: string,
  options: { privateKey?: string; publicKey?: string; require?: boolean },
): Promise<void> => {
  const refs = project.addOns ?? [];
  if (options.privateKey) {
    project.addOns = await Promise.all(
      refs.map(ref => signAddOn(ref, options.privateKey!)),
    );
  }
  if (options.require) {
    const unsigned = await unsignedAddOns(
      project.addOns ?? [],
      options.publicKey,
    );
    if (unsigned.length) {
      throw new Error(
        `${name}: the Project Add-on ${unsigned.join(', ')} is not signed by the NorthTalk key`,
      );
    }
  }
};

/**
 * The Project Add-ons the reader must be asked to trust: those carrying code
 * that `store` doesn't trust. One whose NorthTalk signature verifies is
 * trusted for this visit first, so it is never asked about.
 */
export const addOnsToAsk = async (
  refs: readonly Readonly<AddOnRef>[],
  store: TrustStore,
  publicKey: string = NORTHTALK_ADD_ON_KEY,
): Promise<Readonly<AddOnRef>[]> => {
  store.vouch(await signedHashes(refs, publicKey));
  return refs.filter(ref => ref.code !== undefined && !store.has(ref.hash!));
};
