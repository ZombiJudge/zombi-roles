import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { launch, RESTART_CODE } from '../launcher.mjs';
import { dataFolder } from '../src/paths.js';
import { createBundle, readBundle } from '../src/update/bundle.js';
import { isNewer, signedMessage, Updater } from '../src/update/updater.js';

const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true })));

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

let root;

const read = (name) => readFileSync(join(root, name), 'utf8');

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zombi-update-'));
    folders.push(root);
    mkdirSync(join(root, 'versions', '1.0.0'), { recursive: true });
    writeFileSync(join(root, 'versions', '1.0.0', 'old.txt'), 'old');
    writeFileSync(join(root, 'current.txt'), '1.0.0');
});

const makeBundle = (version, files = { 'src/main.js': Buffer.from('new').toString('base64') }) => gzipSync(JSON.stringify({ version, files }));

function release(version, bundle = makeBundle(version), signature = sign(null, signedMessage(version, bundle), privateKey)) {
    const urls = {
        'https://github.com/bundle': bundle,
        'https://github.com/sig': signature,
    };
    const fetch = async (url) => {
        if (url.includes('api.github.com')) {
            return {
                ok: true,
                json: async () => ({
                    tag_name: `v${version}`,
                    body: 'Notes',
                    assets: [
                        { name: `zombi-roles-${version}.bundle`, browser_download_url: 'https://github.com/bundle' },
                        { name: `zombi-roles-${version}.sig`, browser_download_url: 'https://github.com/sig' },
                    ],
                }),
            };
        }

        return { ok: true, arrayBuffer: async () => urls[url] };
    };

    return new Updater({ root, version: '1.0.0', publicKey, fetch });
}

test('compares versions as numbers', () => {
    assert.ok(isNewer('1.10.0', '1.9.0'));
    assert.ok(isNewer('2.0.0', '1.9.9'));
    assert.ok(!isNewer('1.0.0', '1.0.0'));
    assert.ok(!isNewer('0.9.0', '1.0.0'));
});

test('offers a newer signed release and ignores an old one', async () => {
    const updater = release('1.1.0');

    assert.equal((await updater.check()).version, '1.1.0');
    assert.equal(updater.status().available.notes, 'Notes');
    assert.equal(await release('1.0.0').check(), null);
});

test('a failed check never stops the app', async () => {
    const offline = new Updater({ root, version: '1.0.0', publicKey, fetch: async () => { throw new Error('offline'); } });
    const missing = new Updater({ root, version: '1.0.0', publicKey, fetch: async () => ({ ok: false }) });

    assert.equal(await offline.check(), null);
    assert.equal(await missing.check(), null);
});

test('is off in a development copy', async () => {
    const updater = new Updater({ version: '1.0.0', publicKey });

    assert.equal(updater.status().enabled, false);
    assert.equal(await updater.check(), null);
    assert.throws(() => updater.rollback(), RangeError);
});

test('installs a signed update and keeps the previous version', async () => {
    const updater = release('1.1.0');

    await updater.check();
    await updater.install();

    assert.equal(read('current.txt'), '1.1.0');
    assert.equal(read('previous.txt'), '1.0.0');
    assert.equal(read('pending.txt'), '1.1.0');
    assert.equal(read('versions/1.1.0/src/main.js'), 'new');
    assert.equal(read('versions/1.0.0/old.txt'), 'old');
    assert.deepEqual(readdirSync(join(root, 'versions')).sort(), ['1.0.0', '1.1.0']);
});

test('refuses a tampered bundle and changes nothing', async () => {
    const version = '1.1.0';
    const signature = sign(null, signedMessage(version, makeBundle(version)), privateKey);
    const updater = release(version, makeBundle(version, { 'src/main.js': Buffer.from('evil').toString('base64') }), signature);

    await updater.check();
    await assert.rejects(updater.install(), /safety check/);
    assert.equal(read('current.txt'), '1.0.0');
    assert.ok(!existsSync(join(root, 'versions', version)));
});

test('refuses a signature from another key', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const bundle = makeBundle('1.1.0');
    const updater = release('1.1.0', bundle, sign(null, signedMessage('1.1.0', bundle), other));

    await updater.check();
    await assert.rejects(updater.install(), /safety check/);
});

test('refuses an old signed release passed off as a new version', async () => {
    const bundle = makeBundle('1.0.1');
    const updater = release('9.0.0', bundle, sign(null, signedMessage('1.0.1', bundle), privateKey));

    await updater.check();
    await assert.rejects(updater.install(), /safety check/);
});

test('refuses file paths that leave the app folder', () => {
    for (const path of ['../evil.js', '/etc/evil', 'src/../../evil.js', 'src\\evil.js']) {
        assert.throws(() => readBundle(makeBundle('1.0.0', { [path]: '' })), /unsafe/);
    }
});

test('goes back to the previous version', async () => {
    const updater = release('1.1.0');

    await updater.check();
    await updater.install();
    updater.confirmStarted();
    updater.rollback();

    assert.equal(read('current.txt'), '1.0.0');
    assert.equal(read('previous.txt'), '1.1.0');
    assert.ok(!existsSync(join(root, 'pending.txt')));
});

test('builds a bundle that reads back', () => {
    const { version, files } = readBundle(createBundle('.', '1.2.3'));

    assert.equal(version, '1.2.3');
    assert.ok(files['src/main.js']);
    assert.ok(files['public/index.html']);
    assert.ok(!Object.keys(files).some((path) => path.startsWith('test/') || path.includes('.env')));
});

test('the launcher restarts on request and stops on a normal exit', async () => {
    const codes = [RESTART_CODE, 0];
    const runs = [];
    const code = await launch(root, async (_, version) => {
        runs.push(version);
        return codes.shift();
    });

    assert.equal(code, 0);
    assert.deepEqual(runs, ['1.0.0', '1.0.0']);
});

test('the launcher returns to the old version if an update crashes before it is ready', async () => {
    writeFileSync(join(root, 'current.txt'), '1.1.0');
    writeFileSync(join(root, 'previous.txt'), '1.0.0');
    writeFileSync(join(root, 'pending.txt'), '1.1.0');

    const runs = [];
    const code = await launch(root, async (_, version) => {
        runs.push(version);
        return version === '1.1.0' ? 1 : 0;
    });

    assert.equal(code, 0);
    assert.deepEqual(runs, ['1.1.0', '1.0.0']);
    assert.equal(read('current.txt'), '1.0.0');
});

test('a crash in a working version is not rolled back', async () => {
    assert.equal(await launch(root, async () => 1), 1);
    assert.equal(read('current.txt'), '1.0.0');
});

test('keeps data outside the app folder on each system', () => {
    assert.equal(dataFolder({}), 'data');
    assert.equal(dataFolder({ ZOMBI_DATA_DIR: 'x' }), 'x');
    assert.match(dataFolder({ ZOMBI_APP_ROOT: '/app', APPDATA: 'C:/Users/Sam/AppData/Roaming' }, 'win32'), /Roaming.Zombi Roles$/);
    assert.equal(dataFolder({ ZOMBI_APP_ROOT: '/app' }, 'darwin', '/Users/meg'), '/Users/meg/Library/Application Support/Zombi Roles');
});
