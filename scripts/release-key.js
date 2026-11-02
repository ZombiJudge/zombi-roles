// Creates the key that signs releases. Run once. npm run release:key
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PRIVATE_KEY = join(homedir(), '.zombi-roles', 'release-key.pem');
const PUBLIC_KEY = join('src', 'update', 'release-public-key.pem');

if (existsSync(PRIVATE_KEY)) {
    console.log(`A signing key already exists, so nothing changed: ${PRIVATE_KEY}`);
    process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(dirname(PRIVATE_KEY), { recursive: true });
writeFileSync(PRIVATE_KEY, privateKey, { mode: 0o600 });
chmodSync(PRIVATE_KEY, 0o600);
writeFileSync(PUBLIC_KEY, publicKey);

console.log(`Private signing key saved to ${PRIVATE_KEY}`);
console.log(`Public key saved to ${PUBLIC_KEY}`);
console.log('Keep a safe backup of the private key. Never share it or put it in git.');
