import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

export function loadSettings(dataDir) {
    const envPath = join(dataDir, '.env');
    const jsonPath = join(dataDir, 'settings.json');
    const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
    const saved = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : {};

    return {
        token: env.DISCORD_TOKEN ?? '',
        serverId: env.DISCORD_SERVER_ID ?? '',
        retentionDays: Number(env.RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
        operatorName: saved.operatorName ?? '',
        commandRoleId: saved.commandRoleId ?? '',
    };
}

export function cleanOperatorName(name, maxLength = 32) {
    return String(name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, maxLength);
}

// The token goes in .env, which only this user can read. It is never sent back to the browser.
export function saveSettings(dataDir, { token, serverId, operatorName, commandRoleId = '', retentionDays }) {
    if (!/^\S+$/.test(token)) {
        throw new RangeError('The bot token looks wrong. Copy it again from the Discord Developer Portal.');
    }

    if (!/^\d{5,25}$/.test(serverId)) {
        throw new RangeError('The server ID should be a long number. Copy it again from Discord.');
    }

    if (operatorName === '') {
        throw new RangeError('Enter the name to show in the audit log.');
    }

    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
        throw new RangeError(`Keep batch files for between 1 and ${MAX_RETENTION_DAYS} days.`);
    }

    mkdirSync(dataDir, { recursive: true });

    const envPath = join(dataDir, '.env');
    writeFileSync(envPath, `DISCORD_TOKEN=${token}\nDISCORD_SERVER_ID=${serverId}\nRETENTION_DAYS=${retentionDays}\n`, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    writeFileSync(join(dataDir, 'settings.json'), `${JSON.stringify({ operatorName, commandRoleId })}\n`);
}
