import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { RoleBatchBot } from '../src/bot/rolebatch.js';
import { BatchManager } from '../src/panel/batches.js';
import { FakeServer, fakeSleep, makeMembers } from './helpers/fake-discord.js';

const SERVER_ID = '1';
const ALLOWED_ROLE = '7';
const roles = [
    { id: SERVER_ID, name: '@everyone', position: 0, managed: false },
    { id: '5', name: 'Helper', position: 1, managed: false },
    { id: '6', name: 'Bot', position: 2, managed: true },
    { id: '8', name: 'Owner', position: 3, managed: false },
];

const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true })));

let members;
let server;
let replies;
let bot;
let batches;
let clock;
let downloads;

const lastEdit = () => replies.filter(({ kind }) => kind === 'edit').at(-1);
const responses = () => replies.filter(({ kind }) => kind === 'respond');

beforeEach(() => {
    const folder = mkdtempSync(join(tmpdir(), 'zombi-bot-'));
    folders.push(folder);
    members = makeMembers(3);
    server = new FakeServer(members);
    replies = [];
    clock = 0;
    downloads = {};
    batches = new BatchManager({ dataDir: folder, delayMs: 0, sleep: fakeSleep() });

    const client = {
        applyChange: server.applyChange,
        roles: async () => roles,
        botMember: async () => ({ roleIds: ['6'] }),
        members: async () => server.snapshot(),
        respond: async (interaction, type, data) => replies.push({ kind: 'respond', type, data }),
        editReply: async (token, payload, files = []) => replies.push({ kind: 'edit', token, payload, files }),
        sendDm: async (userId, payload, files = []) => replies.push({ kind: 'dm', userId, payload, files }),
    };

    bot = new RoleBatchBot({
        client,
        batches,
        getSettings: () => ({ serverId: SERVER_ID, commandRoleId: ALLOWED_ROLE }),
        fetch: async (url) => ({ ok: true, text: async () => downloads[url] }),
        sleep: async () => {
            clock += 5000;
            await new Promise((done) => setImmediate(done));
        },
        now: () => clock,
    });
});

const person = (id = '50', memberRoles = [ALLOWED_ROLE]) => ({ roles: memberRoles, user: { id, username: `user${id}`, global_name: 'Sam' } });

const command = (options, extra = {}) => ({
    type: 2,
    id: '1',
    token: 'first',
    guild_id: SERVER_ID,
    member: person(),
    data: { name: 'rolebatch', options: Object.entries(options).map(([name, value]) => ({ name, value })) },
    ...extra,
});

const click = (customId, extra = {}) => ({ type: 3, id: '2', token: 'second', guild_id: SERVER_ID, member: person(), data: { custom_id: customId }, ...extra });

const pendingId = () => lastEdit().payload.components[0].components[0].custom_id.split(':')[2];

test('refuses anyone without the chosen role and other servers', async () => {
    await bot.handle(command({ names: 'x' }, { member: person('50', ['99']) }));
    await bot.handle(command({ names: 'x' }, { guild_id: '999' }));

    assert.equal(responses().length, 2);
    assert.ok(responses().every(({ data }) => data.embeds[0].title === 'Not allowed' && data.flags === 64));
    assert.equal(server.calls, 0);
});

test('refuses everyone until a role is chosen', async () => {
    bot.getSettings = () => ({ serverId: SERVER_ID, commandRoleId: '' });
    await bot.handle(command({ names: 'x' }, { member: person('50', ['']) }));

    assert.equal(responses()[0].data.embeds[0].title, 'Not allowed');
});

test('shows a private preview with the full list and changes nothing', async () => {
    await bot.handle(command({ names: `${members[1].username}, nobody`, add_roles: '<@&5>' }));

    assert.equal(responses()[0].data.flags, 64);

    const { payload, files } = lastEdit();
    assert.equal(payload.embeds[0].title, 'Preview');
    assert.deepEqual(payload.embeds[0].fields.map(({ value }) => value), ['1', '1', '0', '0', '1']);
    assert.match(files[0].text, /Unresolved, skipped \(1\)/);
    assert.equal(server.calls, 0);
});

test('accepts the trailing comma that autofill leaves', async () => {
    await bot.handle(command({ names: `${members[1].username}, `, add_roles: 'Helper, ' }));

    assert.deepEqual(lastEdit().payload.embeds[0].fields.map(({ value }) => value), ['1', '0', '0', '0', '1']);
});

test('offers no Confirm when there is nothing to change', async () => {
    await bot.handle(command({ names: members[1].username, remove_roles: 'Helper' }));

    const buttons = lastEdit().payload.components[0].components;
    assert.deepEqual(buttons.map(({ label }) => label), ['Close']);
    assert.match(lastEdit().payload.embeds[0].description, /nothing to change/);
});

test('reads names from an attached file', async () => {
    const url = 'https://cdn.discordapp.com/attachments/list.csv';
    const resolved = { attachments: { a1: { url, size: 10, filename: 'list.csv' } } };
    downloads[url] = `name,joined\n${members[2].username},2026\n`;

    const interaction = command({ file: 'a1', add_roles: 'Helper' });
    interaction.data.resolved = resolved;
    await bot.handle(interaction);

    assert.equal(lastEdit().payload.embeds[0].fields[0].value, '1');
});

test('refuses a file from anywhere but Discord', async () => {
    const interaction = command({ file: 'a1', add_roles: 'Helper' });
    interaction.data.resolved = { attachments: { a1: { url: 'https://evil.example/list.txt', size: 10, filename: 'list.txt' } } };
    await bot.handle(interaction);

    assert.match(lastEdit().payload.embeds[0].description, /could not be used/);
});

test('explains unknown roles and roles above the bot', async () => {
    await bot.handle(command({ names: 'x', add_roles: 'Ghost' }));
    assert.match(lastEdit().payload.embeds[0].description, /do not exist: Ghost/);

    await bot.handle(command({ names: 'x', add_roles: 'Owner' }));
    assert.match(lastEdit().payload.embeds[0].description, /cannot manage these roles: Owner/);
});

test('Confirm runs the batch with the audit reason and reports in the reply', async () => {
    await bot.handle(command({ names: members.map(({ username }) => username).join(','), add_roles: 'Helper' }));
    await bot.handle(click(`rolebatch:confirm:${pendingId()}`));

    assert.equal(server.calls, 3);
    assert.deepEqual([...server.reasons], ['Zombi Roles batch 1 by Sam (user50)']);
    assert.equal(lastEdit().token, 'second');
    assert.equal(lastEdit().payload.embeds[0].title, 'Batch 1: Finished');
    assert.deepEqual(lastEdit().files, []);
});

test('the audit reason prefers the server nickname and always names the user', async () => {
    const member = { ...person(), nick: 'Boss' };

    await bot.handle(command({ names: members[1].username, add_roles: 'Helper' }, { member }));
    await bot.handle(click(`rolebatch:confirm:${pendingId()}`, { member }));

    assert.deepEqual([...server.reasons], ['Zombi Roles batch 1 by Boss (user50)']);
});

test('Cancel changes nothing, and a used preview cannot run', async () => {
    await bot.handle(command({ names: members[1].username, add_roles: 'Helper' }));

    const id = pendingId();
    await bot.handle(click(`rolebatch:cancel:${id}`));
    await bot.handle(click(`rolebatch:confirm:${id}`));

    assert.equal(server.calls, 0);
    assert.equal(responses().at(-1).data.embeds[0].title, 'Out of date');
});

test('only the person who ran the command can confirm, and previews expire', async () => {
    await bot.handle(command({ names: members[1].username, add_roles: 'Helper' }));

    const id = pendingId();
    await bot.handle(click(`rolebatch:confirm:${id}`, { member: person('60') }));
    assert.equal(server.calls, 0);

    clock += 20 * 60 * 1000;
    await bot.handle(click(`rolebatch:confirm:${id}`));
    assert.equal(server.calls, 0);
});

test('attaches the report and CSV when changes fail', async () => {
    server.failIds.add(members[1].id);
    await bot.handle(command({ names: members[1].username, add_roles: 'Helper' }));
    await bot.handle(click(`rolebatch:confirm:${pendingId()}`));

    assert.deepEqual(lastEdit().files.map(({ name }) => name), ['batch-1-error-report.txt', 'batch-1-errors.csv']);
    assert.match(lastEdit().files[1].text, /Unknown Member/);
});

test('hands off to a direct message after the reply window closes', async () => {
    await bot.handle(command({ names: members[1].username, add_roles: 'Helper' }));

    let finish;
    batches.status = () => (finish ? { state: 'finished', batch: 1, result: 'finished', ok: 1, failed: 0, hasErrors: false } : { state: 'running', batch: 1, done: 0, total: 1 });
    batches.start = () => 1;

    bot.sleep = async () => {
        clock += 15 * 60 * 1000;
        finish = replies.some(({ kind, payload }) => kind === 'edit' && /direct message/.test(payload.embeds[0].description));
    };
    await bot.handle(click(`rolebatch:confirm:${pendingId()}`));

    assert.equal(replies.at(-1).kind, 'dm');
    assert.equal(replies.at(-1).userId, '50');
});

const autofill = (name, value, extra = {}) => ({ type: 4, id: '3', token: 'third', guild_id: SERVER_ID, member: person(), data: { name: 'rolebatch', options: [{ name, value, focused: true }] }, ...extra });

test('suggests only roles the bot can manage', async () => {
    await bot.handle(autofill('add_roles', ''));

    assert.equal(responses()[0].type, 8);
    assert.deepEqual(responses()[0].data.choices, [{ name: 'Helper', value: 'Helper' }]);
});

test('suggests members by name and fills in the username', async () => {
    await bot.handle(autofill('names', 'nick 0'));

    assert.deepEqual(responses()[0].data.choices, [{ name: `Nick 0 (${members[0].username})`, value: members[0].username }]);
});

test('suggests nothing to someone without the role', async () => {
    await bot.handle(autofill('names', '', { member: person('60', []) }));

    assert.deepEqual(responses()[0].data.choices, []);
});

test('keeps a recent copy of the server between keystrokes', async () => {
    let reads = 0;
    const { members: readMembers } = bot.client;
    bot.client.members = async () => {
        reads++;
        return readMembers();
    };

    await bot.handle(autofill('names', 'm'));
    await bot.handle(autofill('names', 'me'));
    assert.equal(reads, 1);

    clock += 61000;
    await bot.handle(autofill('names', 'mem'));
    assert.equal(reads, 2);
});

const pickerId = () => lastEdit().payload.components[3].components[0].custom_id.split(':')[2];
const pick = (action, id, values, extra = {}) => click(`rolebatch:${action}:${id}`, { ...extra, data: { custom_id: `rolebatch:${action}:${id}`, values } });

test('opens pickers when members or roles are missing, keeping what was given', async () => {
    await bot.handle(command({ add_roles: 'Helper' }));

    const [members_, add, remove] = lastEdit().payload.components.map(({ components }) => components[0]);
    assert.deepEqual([members_.type, add.type, remove.type], [5, 6, 6]);
    assert.equal(members_.max_values, 25);
    assert.deepEqual(add.default_values, [{ id: '5', type: 'role' }]);
    assert.equal(server.calls, 0);
});

test('picked members and roles reach the preview and run', async () => {
    await bot.handle(command({}));

    const id = pickerId();
    await bot.handle(pick('members', id, [members[0].id, members[1].id]));
    await bot.handle(pick('add', id, ['5']));
    await bot.handle(click(`rolebatch:preview:${id}`));

    assert.equal(lastEdit().payload.embeds[0].title, 'Preview');
    assert.deepEqual(lastEdit().payload.embeds[0].fields.map(({ value }) => value), ['2', '0', '0', '0', '2']);

    await bot.handle(click(`rolebatch:confirm:${pendingId()}`));
    assert.equal(server.calls, 2);
});

test('picked members add to names from the command', async () => {
    await bot.handle(command({ names: members[0].username }));

    const id = pickerId();
    await bot.handle(pick('members', id, [members[1].id]));
    await bot.handle(pick('add', id, ['5']));
    await bot.handle(click(`rolebatch:preview:${id}`));

    assert.equal(lastEdit().payload.embeds[0].fields[0].value, '2');
});

test('asks for whatever is still missing and keeps the picks', async () => {
    await bot.handle(command({}));

    const id = pickerId();
    await bot.handle(click(`rolebatch:preview:${id}`));
    assert.match(responses().at(-1).data.embeds[0].description, /at least one member/);

    await bot.handle(pick('members', id, [members[0].id]));
    await bot.handle(click(`rolebatch:preview:${id}`));
    assert.match(responses().at(-1).data.embeds[0].description, /at least one role/);
    assert.equal(responses().at(-1).data.components[0].components[0].default_values[0].id, members[0].id);
});

test('a blocked role goes back to the pickers with the reason', async () => {
    await bot.handle(command({}));

    const id = pickerId();
    await bot.handle(pick('members', id, [members[0].id]));
    await bot.handle(pick('add', id, ['8']));
    await bot.handle(click(`rolebatch:preview:${id}`));

    assert.match(lastEdit().payload.embeds[0].description, /cannot manage these roles: Owner/);
    assert.equal(lastEdit().payload.components.length, 4);
});

test('only the person who opened the pickers can use them', async () => {
    await bot.handle(command({}));
    await bot.handle(pick('members', pickerId(), [members[0].id], { member: person('60') }));

    assert.equal(responses().at(-1).data.embeds[0].title, 'Out of date');
});

test('Stop works from the Discord button', async () => {
    let stopped = false;
    batches.stop = () => {
        stopped = true;
    };
    await bot.handle(click('rolebatch:stop'));

    assert.ok(stopped);
});
