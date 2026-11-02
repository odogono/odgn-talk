// Makes a new NorthTalk Add-on signing key pair (#1967), for a first key or
// a rotation. It writes the private key, base64 PKCS #8, to the file named
// on the command line, never to the terminal, and prints the public key to
// put in src/add-ons/signing.ts. Then:
//   gh secret set NORTHTALK_ADD_ON_SIGNING_KEY < <file>
// and delete the file. See "Signing Project Add-ons" in the README.
import { writeFileSync } from 'node:fs';
import { generateSigningKeys } from '../src/add-ons/signing';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: bun tools/add-on-key.ts <private-key-file>');
  process.exit(1);
}
const { privateKey, publicKey } = await generateSigningKeys();
writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' });
console.log(`Public key for NORTHTALK_ADD_ON_KEY: ${publicKey}`);
console.log(`Private key written to ${file}`);
