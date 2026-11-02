// Builds and signs a release into the dist folder. npm run release
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBundle } from '../src/update/bundle.js';
import { signedMessage } from '../src/update/updater.js';

const PRIVATE_KEY = process.env.ZOMBI_RELEASE_KEY ?? join(homedir(), '.zombi-roles', 'release-key.pem');
const DIST = resolve('dist');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const FOLDER = `Zombi Roles ${version}`;

if (!existsSync(PRIVATE_KEY)) {
    console.log('No signing key found. Run: npm run release:key');
    process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);

const bundle = createBundle('.', version);
const signature = sign(null, signedMessage(version, bundle), createPrivateKey(readFileSync(PRIVATE_KEY)));

writeFileSync(join(DIST, `zombi-roles-${version}.bundle`), bundle);
writeFileSync(join(DIST, `zombi-roles-${version}.sig`), signature);

// The first-install files: starters and launcher at the top, the app in a version folder.
const install = join(DIST, FOLDER);
const app = join(install, 'versions', version);

mkdirSync(app, { recursive: true });

for (const path of ['src', 'public']) {
    cpSync(path, join(app, path), { recursive: true });
}

copyFileSync('package.json', join(app, 'package.json'));
copyFileSync('launcher.mjs', join(install, 'launcher.mjs'));
writeFileSync(join(install, 'current.txt'), version);

const windowsStarter = readFileSync('starters/Zombi Roles Launcher.bat', 'utf8').replace(/\r?\n/g, '\r\n');
writeFileSync(join(install, 'Zombi Roles Launcher.bat'), windowsStarter);

const macStarter = join(install, 'Zombi Roles Launcher.command');
copyFileSync('starters/Zombi Roles Launcher.command', macStarter);
chmodSync(macStarter, 0o755);

// One zip per system, each with only its own starter.
execFileSync('zip', ['-q', '-r', '-X', `Zombi-Roles-${version}-Windows.zip`, FOLDER, '-x', '*.command'], { cwd: DIST });
execFileSync('zip', ['-q', '-r', '-X', `Zombi-Roles-${version}-Mac.zip`, FOLDER, '-x', '*.bat'], { cwd: DIST });
rmSync(install, { recursive: true });

console.log(`Release ${version} is ready in the dist folder.`);
