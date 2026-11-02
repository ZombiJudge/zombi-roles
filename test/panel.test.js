import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { createPanel } from '../src/panel/server.js';
import { FakeServer, fakeSleep, makeMembers } from './helpers/fake-discord.js';

const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true })));

let panel;
let port;
let members;
let server;
let dataDir;
let clientOptions;

const roles = [
    { id: '123456', name: '@everyone', position: 0, managed: false },
    { id: '200', name: 'Helper', position: 1, managed: false },
    { id: '300', name: 'Bot', position: 2, managed: true },
    { id: '400', name: 'Owner', position: 3, managed: false },
];

function fakeClient() {
    return {
        applyChange: (...args) => server.applyChange(...args),
        server: async () => ({ name: 'Test' }),
        roles: async () => roles,
        botMember: async () => ({ roleIds: ['300'] }),
        members: async () => {
            if (clientOptions.rejectToken) {
                throw Object.assign(new Error('Missing Access'), { status: 403 });
            }

            return server.snapshot();
        },
        memberIdsByInvite: async () => {
            if (clientOptions.inviteFails) {
                throw new Error('Gone');
            }

            return { ids: [members[1].id], complete: false };
        },
    };
}

const call = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Zombi-Session': panel.session, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    return { status: response.status, headers: response.headers, text, data: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
};

const setup = () => call('/api/setup', { token: 'real-token-abcd', serverId: '123456', operatorName: 'Sam' });

const finished = async () => {
    await panel.batches.running;
    return (await call('/api/batch')).data;
};

const runBatch = async (ids, addRoleIds = ['200']) => {
    const { data: preview } = await call('/api/preview', { memberIds: ids, addRoleIds });
    await call('/api/confirm', { previewId: preview.id });
    return finished();
};

beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'zombi-panel-'));
    folders.push(dataDir);
    members = makeMembers(4);
    server = new FakeServer(members);
    clientOptions = {};
    panel = createPanel({ dataDir, createClient: fakeClient, delayMs: 0, sleep: fakeSleep() });
    port = await panel.listen();
});

afterEach(() => panel.close());

test('refuses requests from other sites and without the session', async () => {
    await setup();

    assert.equal((await call('/api/state', undefined, { 'X-Zombi-Session': 'wrong' })).status, 403);
    assert.equal((await call('/api/stop', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/api/stop', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call('/api/stop', {}, { Origin: `http://127.0.0.1:${port}` })).status, 200);
});

test('refuses a website pretending to be localhost', async () => {
    const request = (await import('node:http')).request;
    const status = await new Promise((done) => {
        request({ port, path: '/', headers: { Host: 'evil.example' } }, (response) => done(response.statusCode)).end();
    });

    assert.equal(status, 403);
});

test('serves the page with the session and safe headers, and nothing outside public', async () => {
    const page = await call('/');

    assert.ok(page.text.includes(panel.session));
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await call('/..%2fpackage.json')).status, 404);
    assert.equal((await call('/%2e%2e/data/.env')).status, 404);
});

test('saves setup privately and never sends the token back', async () => {
    assert.equal((await call('/api/state')).data.configured, false);
    await setup();

    const { text, data } = await call('/api/state');

    assert.equal(data.configured, true);
    assert.equal(data.tokenEnding, 'abcd');
    assert.ok(!text.includes('real-token'));
    assert.equal(statSync(join(dataDir, '.env')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(dataDir, '.env'), 'utf8'), /DISCORD_TOKEN=real-token-abcd/);
});

test('keeps the saved token when setup leaves it empty', async () => {
    await setup();
    await call('/api/setup', { token: '', serverId: '999999', operatorName: 'Alex' });

    const env = readFileSync(join(dataDir, '.env'), 'utf8');

    assert.match(env, /real-token-abcd/);
    assert.match(env, /999999/);
});

test('rejects bad setup values and warns when Discord refuses', async () => {
    assert.equal((await call('/api/setup', { token: 'a b', serverId: '123456', operatorName: 'Sam' })).status, 400);
    assert.equal((await call('/api/setup', { token: 'abc', serverId: 'x\nDISCORD_TOKEN=y', operatorName: 'Sam' })).status, 400);

    clientOptions.rejectToken = true;
    assert.match((await setup()).data.warning, /cannot reach this server/);
});

test('sorts roles the bot can and cannot manage', async () => {
    await setup();
    const { manageable, blocked } = (await call('/api/state')).data;

    assert.deepEqual(manageable.map(({ name }) => name), ['Helper']);
    assert.deepEqual(blocked.map(({ name }) => name).sort(), ['Bot', 'Owner']);
});

test('nothing changes before Confirm, and a preview only works once', async () => {
    await setup();
    const ids = members.map(({ id }) => id);
    const { data: preview } = await call('/api/preview', { memberIds: ids, addRoleIds: ['200'] });

    assert.equal(preview.counts.willChange, 4);
    assert.equal(server.calls, 0);
    assert.equal((await call('/api/confirm', { previewId: 'made-up' })).status, 400);
    assert.equal(server.calls, 0);

    await call('/api/confirm', { previewId: preview.id });
    assert.equal((await finished()).ok, 4);
    assert.equal((await call('/api/confirm', { previewId: preview.id })).status, 400);
    assert.deepEqual([...server.reasons], ['Zombi Roles batch 1 by Sam']);
});

test('deletes old batch files but keeps recent ones and the running number', async () => {
    await setup();
    const first = await runBatch(members.map(({ id }) => id));

    assert.equal(first.batch, 1);

    const dayMs = 24 * 60 * 60 * 1000;
    const files = () => readdirSync(join(dataDir, 'batches'));

    assert.equal(panel.batches.deleteOlderThan(30, Date.now() + 29 * dayMs), 0);
    assert.ok(files().includes('batch-1.csv'));

    assert.equal(panel.batches.deleteOlderThan(30, Date.now() + 31 * dayMs), 1);
    assert.deepEqual(files(), ['last-batch.txt']);

    server = new FakeServer(makeMembers(4));
    const next = await runBatch([members[1].id]);
    assert.equal(next.batch, 2);
});

test('saves the retention setting and refuses bad values', async () => {
    await setup();
    await call('/api/setup', { serverId: '123456', operatorName: 'Sam', retentionDays: '7' });
    assert.equal((await call('/api/state')).data.retentionDays, 7);

    assert.equal((await call('/api/setup', { serverId: '123456', operatorName: 'Sam', retentionDays: '0' })).status, 400);
});

test('refuses a role the bot cannot manage', async () => {
    await setup();
    const result = await call('/api/preview', { memberIds: [members[0].id], addRoleIds: ['400'] });

    assert.equal(result.status, 400);
});

test('carries unresolved and ambiguous names into the preview', async () => {
    await setup();
    const { data: found } = await call('/api/match', { text: members[1].username, fileText: 'nobody,2026\n', fileFormat: 'csv' });
    const { data: preview } = await call('/api/preview', { memberIds: found.ids, addRoleIds: ['200'], unresolved: found.unresolved, ambiguous: found.ambiguous });

    assert.deepEqual([preview.counts.matched, preview.counts.unresolved], [1, 1]);
});

test('warns when the invite filter is partial or broken instead of failing', async () => {
    await setup();
    const partial = (await call('/api/filter', { invite: 'abc' })).data;

    assert.deepEqual(partial.ids, [members[1].id]);
    assert.match(partial.inviteWarning, /may be missing/);

    clientOptions.inviteFails = true;
    const broken = (await call('/api/filter', { invite: 'abc' })).data;

    assert.equal(broken.ids, null);
    assert.match(broken.inviteWarning, /not working/);
});

test('takes an invite link and refuses text that is neither a code nor a link', async () => {
    await setup();

    assert.equal((await call('/api/filter', { invite: 'https://discord.gg/abc' })).status, 200);
    assert.equal((await call('/api/filter', { invite: 'https://example.com/abc' })).status, 400);
});

test('reports errors and offers the error CSV', async () => {
    await setup();
    server.failIds.add(members[0].id);

    const status = await runBatch(members.map(({ id }) => id));

    assert.equal(status.failed, 1);
    assert.match(status.report, /Did not work \(1 change\)/);
    assert.match((await call(`/api/batches/${status.batch}/errors.csv`)).text, /Unknown Member/);
});

test('a save failure keeps going and Undo can still reverse it from the error file', async () => {
    await setup();
    const ids = members.map(({ id }) => id);
    const { data: preview } = await call('/api/preview', { memberIds: ids, addRoleIds: ['200'] });
    const realPath = panel.batches.path.bind(panel.batches);

    panel.batches.path = (batch, suffix) => (suffix === '.csv' ? '\0' : realPath(batch, suffix));

    await call('/api/confirm', { previewId: preview.id });
    const status = await finished();

    assert.equal(status.ok, 4);
    assert.equal(status.unsavedCount, 4);
    assert.match(status.report, /Keep the error CSV/);

    const { data: undo } = await call('/api/undo-preview', { csv: (await call(`/api/batches/${status.batch}/errors.csv`)).text });
    assert.equal(undo.counts.willChange, 4);
});

test('undoes a batch and numbers the next one', async () => {
    await setup();
    const status = await runBatch(members.map(({ id }) => id));
    const { data: undo } = await call('/api/undo-preview', { batch: status.batch });

    assert.equal(undo.kind, 'undo');
    await call('/api/confirm', { previewId: undo.id });

    const second = await finished();
    assert.equal(second.batch, 2);
    assert.ok(server.snapshot().every(({ roleIds }) => !roleIds.includes('200')));

    const history = (await call('/api/batches')).data;
    assert.deepEqual(history.map(({ batch, kind }) => [batch, kind]), [[2, 'undo'], [1, 'batch']]);
});

test('resumes a batch interrupted by a crash', async () => {
    await setup();
    const change = (member) => ({ memberId: member.id, memberName: member.username, action: 'add', roleId: '200', roleName: 'Helper' });
    const changes = members.map(change);

    panel.batches.writeMeta({ batch: 7, kind: 'batch', operator: 'Sam', changes, status: 'running', createdAt: 'now' });

    const [listed] = (await call('/api/batches')).data;
    assert.equal(listed.status, 'interrupted');
    assert.equal(listed.canResume, true);

    await call('/api/resume', { batch: 7 });
    assert.equal((await finished()).ok, 4);
});

test('stops a running batch', async () => {
    await setup();
    panel.batches.delayMs = 50;
    panel.batches.sleep = undefined;

    const { data: preview } = await call('/api/preview', { memberIds: members.map(({ id }) => id), addRoleIds: ['200'] });
    await call('/api/confirm', { previewId: preview.id });
    await call('/api/stop', {});

    const status = await finished();
    assert.equal(status.result, 'stopped');
    assert.ok(status.ok < 4);
});

test('shuts down only when no batch is running', async () => {
    await setup();
    panel.batches.delayMs = 20;
    panel.batches.sleep = undefined;

    const { data: preview } = await call('/api/preview', { memberIds: members.map(({ id }) => id), addRoleIds: ['200'] });
    await call('/api/confirm', { previewId: preview.id });

    assert.equal((await call('/api/shutdown', {})).status, 400);
    await finished();
    assert.equal((await call('/api/shutdown', {})).status, 200);
});

test('only runs one batch at a time', async () => {
    await setup();
    panel.batches.delayMs = 20;
    panel.batches.sleep = undefined;

    const ids = members.map(({ id }) => id);
    const { data: first } = await call('/api/preview', { memberIds: ids, addRoleIds: ['200'] });
    await call('/api/confirm', { previewId: first.id });

    const { data: second } = await call('/api/preview', { memberIds: ids, removeRoleIds: ['200'] });
    const refused = await call('/api/confirm', { previewId: second.id });

    assert.equal(refused.status, 400);
    await finished();
});
