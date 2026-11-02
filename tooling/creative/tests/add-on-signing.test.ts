// NorthTalk-signed Project Add-ons (#1967): a valid signature verifies;
// tampered code, another key's signature and a missing one don't, and the
// release build refuses an unsigned one.
import { expect, test } from 'bun:test';
import {
  addOnsToAsk,
  generateSigningKeys,
  NORTHTALK_ADD_ON_KEY,
  signAddOn,
  signedHashes,
  signForPublishing,
  verifyAddOn,
} from '../src/add-ons/signing';
import { TrustStore } from '../src/add-ons/trust';
import { createProject, type AddOnRef } from '../src/model';
import {
  serializeProject,
  sha256Hex,
  validateProjectJson,
} from '../src/project-file';

const addOn = async (code = 'export default {}'): Promise<AddOnRef> => ({
  id: 'https://example.org/pads',
  version: '1.0.0',
  code,
  hash: await sha256Hex(new TextEncoder().encode(code)),
});

const northtalk = await generateSigningKeys();
const other = await generateSigningKeys();

test('a signature by the key verifies', async () => {
  const signed = await signAddOn(await addOn(), northtalk.privateKey);
  expect(await verifyAddOn(signed, northtalk.publicKey)).toBe(true);
  expect(await signedHashes([signed], northtalk.publicKey)).toEqual([
    signed.hash!,
  ]);
});

test('tampered code, another key and a missing signature do not', async () => {
  const signed = await signAddOn(await addOn(), northtalk.privateKey);
  const tampered = { ...signed, code: 'export default { evil: true }' };
  expect(await verifyAddOn(tampered, northtalk.publicKey)).toBe(false);
  const rehashed = {
    ...tampered,
    hash: await sha256Hex(new TextEncoder().encode(tampered.code)),
  };
  expect(await verifyAddOn(rehashed, northtalk.publicKey)).toBe(false);
  const byOther = await signAddOn(await addOn(), other.privateKey);
  expect(await verifyAddOn(byOther, northtalk.publicKey)).toBe(false);
  expect(await verifyAddOn(await addOn(), northtalk.publicKey)).toBe(false);
  expect(
    await verifyAddOn(
      { ...signed, signature: 'not base64!' },
      northtalk.publicKey,
    ),
  ).toBe(false);
});

test('Folio ships a real public key, not a placeholder', async () => {
  const signed = await signAddOn(await addOn(), northtalk.privateKey);
  // Another key's signature never verifies against the shipped one.
  expect(await verifyAddOn(signed)).toBe(false);
  expect(atob(NORTHTALK_ADD_ON_KEY)).toHaveLength(32);
});

test('a verified hash is trusted for the visit only, not saved', () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  } as unknown as Storage;
  const store = new TrustStore(storage);
  store.vouch(['abc']);
  expect(store.has('abc')).toBe(true);
  store.trust(['def']);
  expect(new TrustStore(storage).has('abc')).toBe(false);
  expect(new TrustStore(storage).has('def')).toBe(true);
});

test('the signature saves with the Project, only on a Project Add-on', async () => {
  const project = createProject('Signed');
  project.addOns = [await signAddOn(await addOn(), northtalk.privateKey)];
  const json = serializeProject(project);
  expect(validateProjectJson(json)).toHaveProperty(
    'project.addOns.0.signature',
    project.addOns[0]!.signature,
  );
  json.addOns = [
    { id: 'https://example.org/x', version: '1.0.0', signature: 'x' },
  ];
  expect(validateProjectJson(json)).toMatchObject({
    issues: [{ path: 'addOns[0].signature' }],
  });
});

test('the release build signs with the key and refuses what does not verify', async () => {
  const project = createProject('Published');
  project.addOns = [await addOn()];
  await expect(
    signForPublishing(project, 'Published', {
      require: true,
      publicKey: northtalk.publicKey,
    }),
  ).rejects.toThrow('Published: the Project Add-on https://example.org/pads');
  await signForPublishing(project, 'Published', {
    privateKey: northtalk.privateKey,
    publicKey: northtalk.publicKey,
    require: true,
  });
  expect(await verifyAddOn(project.addOns[0]!, northtalk.publicKey)).toBe(true);
  // Built-in Add-ons carry no code, so they need no signature.
  const plain = createProject('Plain');
  plain.addOns = [{ id: 'northtalk:instruments', version: '1.0.0' }];
  await signForPublishing(plain, 'Plain', { require: true });
});

test('a signed Add-on is not asked about; tampered, other-key and unsigned ones are', async () => {
  const store = new TrustStore(undefined);
  const signed = await signAddOn(
    await addOn('export default 1'),
    northtalk.privateKey,
  );
  const tampered = {
    ...(await signAddOn(await addOn('export default 2'), northtalk.privateKey)),
    code: 'export default 3',
  };
  const byOther = await signAddOn(
    await addOn('export default 4'),
    other.privateKey,
  );
  const unsigned = await addOn('export default 5');
  const builtIn = { id: 'northtalk:instruments', version: '1.0.0' };
  const asked = await addOnsToAsk(
    [signed, tampered, byOther, unsigned, builtIn],
    store,
    northtalk.publicKey,
  );
  expect(asked).toEqual([tampered, byOther, unsigned]);
});
