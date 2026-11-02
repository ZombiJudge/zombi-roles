// Starts the installed version and sits outside it, so an update can replace the app while
// this file stays put. If a new version crashes before it is ready, this goes back to the old one.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_CODE = 75;

const read = (root, name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim() : '');

function runVersion(root, version) {
    return new Promise((done) => {
        const child = spawn(process.execPath, [join(root, 'versions', version, 'src', 'main.js')], {
            cwd: join(root, 'versions', version),
            env: { ZOMBI_OPEN_BROWSER: '1', ...process.env, ZOMBI_APP_ROOT: root },
            stdio: 'inherit',
        });

        child.on('exit', (code) => done(code ?? 1));
        child.on('error', () => done(1));
    });
}

export async function launch(root, run = runVersion) {
    for (;;) {
        const code = await run(root, read(root, 'current.txt'));

        if (code === RESTART_CODE) {
            continue;
        }

        if (code === 0 || !existsSync(join(root, 'pending.txt'))) {
            return code;
        }

        // The update never reported that it started, so return to the version that worked.
        writeFileSync(join(root, 'current.txt'), read(root, 'previous.txt'));
        rmSync(join(root, 'pending.txt'));
        console.log('The update did not start, so Zombi Roles went back to the previous version.');
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exit(await launch(dirname(fileURLToPath(import.meta.url))));
}
