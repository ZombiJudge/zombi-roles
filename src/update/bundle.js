import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const RELEASE_PATHS = ['src', 'public', 'package.json'];

function listFiles(path) {
    return statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => listFiles(join(path, name))) : [path];
}

// One compressed file holding the app, so updating needs no extra tools on the operator's computer.
export function createBundle(root, version) {
    const files = {};

    for (const path of RELEASE_PATHS.flatMap((name) => listFiles(join(root, name)))) {
        files[relative(root, path).split(sep).join('/')] = readFileSync(path).toString('base64');
    }

    return gzipSync(JSON.stringify({ version, files }));
}

export function readBundle(data) {
    const { version, files } = JSON.parse(gunzipSync(data).toString('utf8'));

    for (const path of Object.keys(files)) {
        if (path.includes('\\') || posix.isAbsolute(path) || posix.normalize(path) !== path || path.startsWith('..')) {
            throw new RangeError('This update contains an unsafe file path.');
        }
    }

    return { version, files };
}
