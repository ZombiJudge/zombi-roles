import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_FOLDER = 'Zombi Roles';

// Token, settings, and batch results live outside the app folder, so updates never touch them.
// A development copy, started without the launcher, keeps using its local data folder.
export function dataFolder(env = process.env, platform = process.platform, home = homedir()) {
    if (env.ZOMBI_DATA_DIR) {
        return env.ZOMBI_DATA_DIR;
    }

    if (!env.ZOMBI_APP_ROOT) {
        return 'data';
    }

    if (platform === 'win32') {
        return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_FOLDER);
    }

    return platform === 'darwin' ? join(home, 'Library', 'Application Support', APP_FOLDER) : join(home, '.zombi-roles');
}
