import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { RoleBatchBot, ROLEBATCH_COMMAND } from './bot/rolebatch.js';
import { DiscordClient } from './discord/client.js';
import { Gateway } from './discord/gateway.js';
import { createPanel } from './panel/server.js';
import { loadSettings } from './panel/settings.js';
import { dataFolder } from './paths.js';
import { Updater } from './update/updater.js';

const PORT = 4646;
const URL_OF_PANEL = `http://127.0.0.1:${PORT}`;
const RESTART_CODE = 75;
const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
const DATA_DIR = dataFolder();
const PUBLIC_KEY_FILE = new URL('update/release-public-key.pem', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const createClient = (settings) => new DiscordClient(settings);
let gateway = null;

// Connects to Discord for slash commands, starting over whenever the settings change.
async function startBot() {
    gateway?.stop();
    gateway = null;

    const settings = loadSettings(DATA_DIR);

    if (!settings.token || !settings.serverId) {
        return;
    }

    const client = createClient(settings);
    const bot = new RoleBatchBot({ client, batches: panel.batches, getSettings: () => loadSettings(DATA_DIR) });

    try {
        await client.registerCommand(ROLEBATCH_COMMAND);
    } catch (error) {
        console.log(`The /rolebatch command could not be registered: ${error.message}`);
        return;
    }

    gateway = new Gateway({
        token: settings.token,
        getUrl: () => client.gatewayUrl(),
        onInteraction: (interaction) => bot.handle(interaction),
        onFatal: (code) => console.log(`Discord refused the connection (${code}). The panel still works, but /rolebatch does not.`),
    });
    await gateway.start();
}

function openBrowser() {
    if (process.env.ZOMBI_OPEN_BROWSER) {
        const [command, ...args] = process.platform === 'win32' ? ['cmd', '/c', 'start', '""', URL_OF_PANEL] : ['open', URL_OF_PANEL];
        spawn(command, args, { stdio: 'ignore', detached: true }).unref();
    }
}

const updater = new Updater({
    root: process.env.ZOMBI_APP_ROOT,
    version,
    publicKey: existsSync(PUBLIC_KEY_FILE) ? readFileSync(PUBLIC_KEY_FILE, 'utf8') : null,
});

const panel = createPanel({
    dataDir: DATA_DIR,
    createClient,
    port: PORT,
    updater,
    onSettingsSaved: () => startBot(),
    onRestart: () => {
        gateway?.stop();
        process.exit(RESTART_CODE);
    },
    onShutdown: () => {
        gateway?.stop();
        process.exit(0);
    },
});

try {
    await panel.listen();
} catch (error) {
    if (error.code !== 'EADDRINUSE') {
        throw error;
    }

    // Already running, such as after a second double-click, so just show it.
    console.log('Zombi Roles is already running.');
    openBrowser();
    process.exit(0);
}

updater.confirmStarted();
panel.cleanUp();
setInterval(() => panel.cleanUp(), CLEANUP_EVERY_MS);
console.log(`Zombi Roles ${version} is running at ${URL_OF_PANEL}`);
openBrowser();
await updater.check();
await startBot();
