import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInviteCode } from '../core/invite.js';
import { matchNames, suggestName } from '../core/match.js';
import { parseNameList } from '../core/names.js';
import { buildPlan } from '../core/plan.js';
import { parseResults } from '../core/results.js';
import { checkRoles } from '../core/roles.js';
import { FatalBatchError } from '../core/runner.js';
import { BatchManager } from './batches.js';
import { cleanOperatorName, loadSettings, saveSettings } from './settings.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SUGGESTIONS = 10;
const RESTART_DELAY_MS = 200;
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
};

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function readBody(request) {
    return new Promise((done, fail) => {
        const chunks = [];
        let size = 0;

        request.on('data', (chunk) => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                fail(new HttpError(413, 'That is too much text at once.'));
                request.destroy();
                return;
            }

            chunks.push(chunk);
        });
        request.on('end', () => {
            try {
                done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            } catch {
                fail(new HttpError(400, 'The request could not be read.'));
            }
        });
        request.on('error', fail);
    });
}

function sameSecret(a, b) {
    const left = Buffer.from(String(a ?? ''));
    const right = Buffer.from(b);

    return left.length === right.length && timingSafeEqual(left, right);
}

function connectionMessage(error) {
    if (error instanceof FatalBatchError) {
        return 'Discord rejected the bot token. Check it in Settings.';
    }

    if (error.status === 403 || error.status === 404) {
        return 'The bot cannot reach this server. Check that it is invited and that the server ID is right.';
    }

    return `Discord could not be reached: ${error.message}`;
}

// The local control panel. Listening on 127.0.0.1 keeps other computers out, and the checks
// in guard() keep out websites open in the same browser.
export function createPanel({ dataDir, createClient, delayMs, sleep, port = 0, onSettingsSaved = () => {}, updater = null, onRestart = () => {}, onShutdown = () => {} }) {
    const session = randomBytes(32).toString('hex');
    const batches = new BatchManager({ dataDir, delayMs, sleep });
    let boundPort = port;
    let preview = null;

    const settings = () => loadSettings(dataDir);
    const client = () => {
        const { token, serverId } = settings();
        return createClient({ token, serverId });
    };

    function guard(request, isApi) {
        const { host, origin } = request.headers;
        const allowed = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];

        if (!allowed.includes(host)) {
            throw new HttpError(403, 'Not allowed.');
        }

        if (origin !== undefined && origin !== `http://${host}`) {
            throw new HttpError(403, 'Not allowed.');
        }

        const site = request.headers['sec-fetch-site'];

        if (isApi && site !== undefined && site !== 'same-origin') {
            throw new HttpError(403, 'Not allowed.');
        }

        if (isApi && !sameSecret(request.headers['x-zombi-session'], session)) {
            throw new HttpError(403, 'Reload the page and try again.');
        }
    }

    function makePreview({ changes, alreadySet = [], unresolved = [], ambiguous = [], counts, tooLongForDiscordProgress = false, kind }) {
        preview = { id: randomBytes(16).toString('hex'), changes, kind };

        return {
            id: preview.id,
            kind,
            counts,
            tooLongForDiscordProgress,
            changes,
            alreadySet,
            unresolved,
            ambiguous,
        };
    }

    const routes = {
        'GET /api/state': async () => {
            const { token, serverId, operatorName, commandRoleId, retentionDays } = settings();
            const base = { serverId, operatorName, commandRoleId, retentionDays, hasToken: token !== '', tokenEnding: token.slice(-4) };

            if (!token || !serverId || !operatorName) {
                return { ...base, configured: false };
            }

            try {
                const discord = client();
                const [server, roles, bot] = await Promise.all([discord.server(), discord.roles(), discord.botMember()]);
                const { manageable, blocked } = checkRoles(roles, bot.roleIds, serverId);
                const byPosition = (a, b) => b.position - a.position;

                return {
                    ...base,
                    configured: true,
                    serverName: server.name,
                    manageable: manageable.toSorted(byPosition).map(({ id, name }) => ({ id, name })),
                    assignable: roles.filter(({ id, managed }) => id !== serverId && !managed).toSorted(byPosition).map(({ id, name }) => ({ id, name })),
                    blocked: blocked.map(({ role, reason }) => ({ id: role.id, name: role.name, reason })),
                };
            } catch (error) {
                return { ...base, configured: true, connectionError: connectionMessage(error) };
            }
        },

        'POST /api/setup': async ({ token, serverId, operatorName, commandRoleId, retentionDays }) => {
            const current = settings();
            const next = {
                token: String(token ?? '').trim() || current.token,
                serverId: String(serverId ?? '').trim(),
                operatorName: cleanOperatorName(operatorName),
                commandRoleId: /^\d*$/.test(commandRoleId ?? '') ? (commandRoleId ?? current.commandRoleId) : current.commandRoleId,
                retentionDays: retentionDays === undefined ? current.retentionDays : Number(retentionDays),
            };

            saveSettings(dataDir, next);
            batches.deleteOlderThan(next.retentionDays);
            onSettingsSaved();

            try {
                await createClient(next).members();
            } catch (error) {
                return { saved: true, warning: connectionMessage(error) };
            }

            return { saved: true };
        },

        'GET /api/members': async () => client().members(),

        'POST /api/filter': async ({ invite }) => {
            const code = parseInviteCode(String(invite ?? ''));

            try {
                const { ids, complete } = await client().memberIdsByInvite(code);
                const warning = 'Discord did not return every member for this invite, so this list may be missing some people.';

                return { ids, inviteWarning: complete ? null : warning };
            } catch {
                return { ids: null, inviteWarning: 'The experimental invite filter is not working right now. The member list and name lists still work.' };
            }
        },

        'POST /api/match': async ({ text, fileText, fileFormat }) => {
            const typed = parseNameList(String(text ?? ''));
            const fromFile = parseNameList(String(fileText ?? ''), { format: fileFormat === 'csv' ? 'csv' : 'lines' });
            const names = parseNameList([...typed, ...fromFile].join('\n'));
            const members = await client().members();
            const { matched, unresolved, ambiguous, repeated } = matchNames(names, members);

            return {
                ids: matched.map(({ member }) => member.id),
                unresolved,
                suggestions: Object.fromEntries(unresolved.slice(0, MAX_SUGGESTIONS).map((name) => [name, suggestName(name, members)])),
                ambiguous: ambiguous.map(({ name, candidates }) => ({ name, candidates: candidates.map(({ username }) => username) })),
                repeated: repeated.map(({ name }) => name),
            };
        },

        'POST /api/preview': async ({ memberIds = [], addRoleIds = [], removeRoleIds = [], unresolved = [], ambiguous = [] }) => {
            const { manageable } = await routes['GET /api/state']();
            const allowed = new Set((manageable ?? []).map(({ id }) => id));

            if ([...addRoleIds, ...removeRoleIds].some((id) => !allowed.has(id))) {
                throw new RangeError('The bot cannot manage one of those roles.');
            }

            const wanted = new Set(memberIds);
            const members = (await client().members()).filter(({ id }) => wanted.has(id));
            const roleNames = Object.fromEntries(manageable.map(({ id, name }) => [id, name]));
            const plan = buildPlan({ members, addRoleIds, removeRoleIds, roleNames });

            return makePreview({
                ...plan,
                unresolved,
                ambiguous,
                counts: { ...plan.counts, unresolved: unresolved.length, ambiguous: ambiguous.length },
                kind: 'batch',
            });
        },

        'POST /api/undo-preview': async ({ batch, csv }) => {
            const rows = csv ? parseResults(String(csv)) : batches.resultRows(Number(batch));

            if (rows.length === 0) {
                throw new RangeError('That file has no results in it.');
            }

            const { changes, alreadySet, missing } = batches.planUndo(rows, await client().members());

            return makePreview({
                changes,
                alreadySet,
                unresolved: missing.map(({ memberName }) => memberName),
                counts: { matched: changes.length + alreadySet.length, unresolved: missing.length, ambiguous: 0, alreadySet: alreadySet.length, willChange: changes.length },
                kind: 'undo',
            });
        },

        'POST /api/confirm': async ({ previewId }) => {
            if (!preview || !sameSecret(previewId, preview.id)) {
                throw new RangeError('That preview is out of date. Make a new preview.');
            }

            const { changes, kind } = preview;
            preview = null;
            return { batch: batches.start({ changes, kind, operator: settings().operatorName, client: client() }) };
        },

        'POST /api/stop': async () => {
            batches.stop();
            return {};
        },

        'POST /api/resume': async ({ batch }) => {
            batches.resume(Number(batch), client());
            return {};
        },

        'GET /api/update': async () => updater?.status() ?? { enabled: false },

        'POST /api/update/install': async () => {
            batches.assertIdle();
            await updater.install();
            setTimeout(onRestart, RESTART_DELAY_MS);
            return {};
        },

        'POST /api/update/rollback': async () => {
            batches.assertIdle();
            updater.rollback();
            setTimeout(onRestart, RESTART_DELAY_MS);
            return {};
        },

        'POST /api/shutdown': async () => {
            batches.assertIdle();
            setTimeout(onShutdown, RESTART_DELAY_MS);
            return {};
        },

        'GET /api/batch': async () => batches.status(),
        'GET /api/batches': async () => batches.list(),
    };

    async function handleApi(request, response, url) {
        const download = /^\/api\/batches\/(\d+)\/(results|errors)\.csv$/.exec(url.pathname);

        if (download && request.method === 'GET') {
            const [, batch, type] = download;
            const csv = type === 'results' ? batches.resultsCsv(batch) : batches.errorCsv(Number(batch));
            response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' });
            response.end(csv);
            return;
        }

        const route = routes[`${request.method} ${url.pathname}`];

        if (!route) {
            throw new HttpError(404, 'Not found.');
        }

        const result = await route(request.method === 'POST' ? await readBody(request) : {});
        response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
    }

    function handleStatic(response, url) {
        const file = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
        const path = resolve(join(PUBLIC_DIR, file));
        const type = TYPES[extname(path)];

        if (!type || !path.startsWith(PUBLIC_DIR)) {
            throw new HttpError(404, 'Not found.');
        }

        let content;

        try {
            content = readFileSync(path);
        } catch {
            throw new HttpError(404, 'Not found.');
        }

        if (file === 'index.html') {
            content = content.toString('utf8').replace('__SESSION__', session);
        }

        response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
        response.end(content);
    }

    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const isApi = url.pathname.startsWith('/api/');

        try {
            guard(request, isApi);

            if (isApi) {
                await handleApi(request, response, url);
            } else {
                handleStatic(response, url);
            }
        } catch (error) {
            const status = error instanceof HttpError ? error.status : error instanceof RangeError ? 400 : 500;
            const message = status === 500 ? connectionMessage(error) : error.message;

            if (!response.headersSent) {
                response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: message }));
            }
        }
    });

    return {
        batches,
        session,
        cleanUp: () => batches.deleteOlderThan(settings().retentionDays),
        listen: () =>
            new Promise((done, fail) => {
                server.once('error', fail);
                server.listen(port, '127.0.0.1', () => {
                    boundPort = server.address().port;
                    done(boundPort);
                });
            }),
        close: () => new Promise((done) => server.close(done)),
    };
}
