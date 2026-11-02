import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readBundle } from './bundle.js';

const LATEST_RELEASE = 'https://api.github.com/repos/ZombiJudge/zombi-roles/releases/latest';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export function isNewer(candidate, current) {
    const parts = (version) => version.split('.').map(Number);
    const [a, b] = [parts(candidate), parts(current)];

    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) {
            return (a[i] ?? 0) > (b[i] ?? 0);
        }
    }

    return false;
}

// The version is part of what is signed, so an old release can't be passed off as a new one.
export const signedMessage = (version, bundle) => Buffer.concat([Buffer.from(`${version}\n`), bundle]);

export class Updater {
    constructor({ root, version, publicKey, fetch = globalThis.fetch }) {
        this.root = root;
        this.version = version;
        this.publicKey = publicKey;
        this.fetch = fetch;
        this.available = null;
    }

    read(name) {
        const path = join(this.root, name);
        return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    }

    get enabled() {
        return Boolean(this.root && this.publicKey);
    }

    status() {
        return {
            version: this.version,
            enabled: this.enabled,
            available: this.available && { version: this.available.version, notes: this.available.notes },
            previous: this.enabled ? this.read('previous.txt') : '',
        };
    }

    // Any failure here just means no update is offered. It must never stop the app.
    async check() {
        if (!this.enabled) {
            return null;
        }

        try {
            const response = await this.fetch(LATEST_RELEASE, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zombi-roles' } });

            if (!response.ok) {
                return null;
            }

            const { tag_name: tag, body, assets } = await response.json();
            const version = tag.replace(/^v/, '');
            const asset = (name) => assets.find((item) => item.name === name)?.browser_download_url;
            const bundleUrl = asset(`zombi-roles-${version}.bundle`);
            const signatureUrl = asset(`zombi-roles-${version}.sig`);

            if (isNewer(version, this.version) && bundleUrl && signatureUrl) {
                this.available = { version, notes: body ?? '', bundleUrl, signatureUrl };
            }
        } catch {
            this.available = null;
        }

        return this.available;
    }

    async download(url) {
        if (new URL(url).protocol !== 'https:') {
            throw new RangeError('The update address is not secure.');
        }

        const response = await this.fetch(url);

        if (!response.ok) {
            throw new RangeError('The update could not be downloaded. Check the internet connection and try again.');
        }

        const data = Buffer.from(await response.arrayBuffer());

        if (data.length > MAX_DOWNLOAD_BYTES) {
            throw new RangeError('The update is larger than expected, so it was not installed.');
        }

        return data;
    }

    // Everything is checked before the first file is written, and the new version is only
    // switched on once it is complete.
    async install() {
        if (!this.enabled || !this.available) {
            throw new RangeError('There is no update to install.');
        }

        const { version, bundleUrl, signatureUrl } = this.available;
        const [bundle, signature] = await Promise.all([this.download(bundleUrl), this.download(signatureUrl)]);

        if (!verify(null, signedMessage(version, bundle), createPublicKey(this.publicKey), signature)) {
            throw new RangeError('This update failed its safety check, so it was not installed.');
        }

        const { version: bundled, files } = readBundle(bundle);

        if (bundled !== version) {
            throw new RangeError('This update failed its safety check, so it was not installed.');
        }

        const versions = join(this.root, 'versions');
        const building = join(versions, `${version}.incoming`);

        rmSync(building, { recursive: true, force: true });

        for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(building, path)), { recursive: true });
            writeFileSync(join(building, path), Buffer.from(content, 'base64'));
        }

        rmSync(join(versions, version), { recursive: true, force: true });
        renameSync(building, join(versions, version));

        const current = this.read('current.txt');

        writeFileSync(join(this.root, 'previous.txt'), current);
        writeFileSync(join(this.root, 'pending.txt'), version);
        writeFileSync(join(this.root, 'current.txt'), version);

        for (const name of readdirSync(versions)) {
            if (name !== version && name !== current) {
                rmSync(join(versions, name), { recursive: true, force: true });
            }
        }
    }

    rollback() {
        const previous = this.enabled ? this.read('previous.txt') : '';

        if (!previous || !existsSync(join(this.root, 'versions', previous))) {
            throw new RangeError('There is no previous version to go back to.');
        }

        const current = this.read('current.txt');

        writeFileSync(join(this.root, 'current.txt'), previous);
        writeFileSync(join(this.root, 'previous.txt'), current);
    }

    // Called once the app is ready, so the launcher knows this version works.
    confirmStarted() {
        if (this.root) {
            rmSync(join(this.root, 'pending.txt'), { force: true });
        }
    }
}
