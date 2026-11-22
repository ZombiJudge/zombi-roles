import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRoles } from '../src/core/roles.js';
import { FatalBatchError, RateLimitError } from '../src/core/runner.js';
import { DiscordClient } from '../src/discord/client.js';

const respond = (status, body) => ({ status, ok: status < 400, json: async () => body });

const setup = (...responses) => {
    const calls = [];
    const fetch = async (url, options) => {
        calls.push({ url, ...options });
        return responses.shift();
    };
    const waits = [];
    const client = new DiscordClient({ token: 'secret', serverId: '1', fetch, sleep: async (ms) => waits.push(ms) });

    return { client, calls, waits };
};

const rawMember = (id) => ({ user: { id, username: `u${id}` }, roles: [], joined_at: '2026-01-01T00:00:00Z' });

test('adds and removes roles with the audit reason', async () => {
    const { client, calls } = setup(respond(204, null), respond(204, null));

    await client.applyChange({ memberId: '5', action: 'add', roleId: '9' }, 'Zombi Roles batch 12 by Sam');
    await client.applyChange({ memberId: '5', action: 'remove', roleId: '9' }, 'x');

    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[1].method, 'DELETE');
    assert.match(calls[0].url, /\/guilds\/1\/members\/5\/roles\/9$/);
    assert.equal(decodeURIComponent(calls[0].headers['X-Audit-Log-Reason']), 'Zombi Roles batch 12 by Sam');
    assert.equal(calls[0].headers.Authorization, 'Bot secret');
});

test('turns Discord answers into errors the runner understands', async () => {
    const change = { memberId: '5', action: 'add', roleId: '9' };

    await assert.rejects(
        setup(respond(429, { retry_after: 3.5 })).client.applyChange(change),
        (error) => error instanceof RateLimitError && error.retryAfterSeconds === 3.5,
    );
    await assert.rejects(setup(respond(401, {})).client.applyChange(change), FatalBatchError);
    await assert.rejects(setup(respond(403, { message: 'Missing Permissions', code: 50013 })).client.applyChange(change), /Missing Permissions/);
});

test('error messages never contain the token', async () => {
    const { client } = setup(respond(500, null));

    await assert.rejects(client.server(), (error) => !error.message.includes('secret'));
});

test('reads every page of members and waits out rate limits', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => rawMember(String(i + 1)));
    const { client, calls, waits } = setup(respond(200, fullPage), respond(429, { retry_after: 2 }), respond(200, [rawMember('1001')]));
    const members = await client.members();

    assert.equal(members.length, 1001);
    assert.match(calls[1].url, /after=1000$/);
    assert.deepEqual(waits, [2000]);
    assert.equal(members[0].username, 'u1');
});

test('reads every page of an invite search', async () => {
    const page = (id) => ({ members: [{ member: rawMember(id) }], total_result_count: 2 });
    const { client, calls } = setup(respond(200, page('7')), respond(200, page('8')));

    assert.deepEqual(await client.memberIdsByInvite('abc'), { ids: ['7', '8'], complete: true });
    assert.deepEqual(JSON.parse(calls[0].body).and_query, { source_invite_code: { or_query: ['abc'] } });
    assert.deepEqual(JSON.parse(calls[1].body).after, { user_id: '7', guild_joined_at: Date.parse('2026-01-01T00:00:00Z') });
    assert.match(calls[0].url, /\/guilds\/1\/members-search$/);
});

test('flags an invite search that stops short', async () => {
    const page = { members: [{ member: rawMember('7') }], total_result_count: 2 };
    const { client } = setup(respond(200, page), respond(200, page));

    assert.deepEqual(await client.memberIdsByInvite('abc'), { ids: ['7'], complete: false });
});

const rawMessage = (id, fields = {}) => ({ id, type: 0, timestamp: '2026-10-01T18:00:00.000Z', edited_timestamp: null, author: { id: '5', username: 'sam', global_name: 'Sam' }, content: `m${id}`, mentions: [], attachments: [], embeds: [], ...fields });

test('reads every page of a channel, oldest first, and waits out rate limits', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => rawMessage(String(1000 - i)));
    const { client, calls, waits } = setup(respond(200, fullPage), respond(429, { retry_after: 1 }), respond(200, [rawMessage('800')]));
    const counts = [];
    const messages = await client.messages('42', (count) => counts.push(count));

    assert.equal(messages.length, 101);
    assert.equal(messages[0].id, '800');
    assert.equal(messages.at(-1).id, '1000');
    assert.match(calls[0].url, /\/channels\/42\/messages\?limit=100$/);
    assert.match(calls[1].url, /\/channels\/42\/messages\?limit=100&before=901$/);
    assert.deepEqual(waits, [1000]);
    assert.deepEqual(counts, [100, 101]);
});

test('turns a Discord message into plain fields', async () => {
    const raw = rawMessage('7', {
        type: 19,
        edited_timestamp: '2026-10-01T18:05:00.000Z',
        author: { id: '5', username: 'sam', global_name: null, bot: true },
        mentions: [{ id: '6', username: 'alex', global_name: 'Alex' }],
        message_reference: { message_id: '3' },
        referenced_message: { author: { id: '6', username: 'alex' }, content: 'first' },
        attachments: [{ filename: 'deck.png', url: 'https://cdn.discordapp.com/deck.png' }],
        embeds: [{}],
        sticker_items: [{ name: 'Zombi' }],
        thread: { id: '99' },
    });
    const [message] = await setup(respond(200, [raw])).client.messages('42');

    assert.deepEqual(message, {
        id: '7',
        type: 19,
        time: '2026-10-01T18:00:00.000Z',
        editedTime: '2026-10-01T18:05:00.000Z',
        authorId: '5',
        authorName: 'sam',
        authorUsername: 'sam',
        isBot: true,
        content: 'm7',
        mentions: { 6: 'Alex' },
        replyTo: { id: '3', authorName: 'alex', snippet: 'first' },
        attachments: [{ name: 'deck.png', url: 'https://cdn.discordapp.com/deck.png' }],
        embedCount: 1,
        stickerNames: ['Zombi'],
        startsThreadId: '99',
    });
});

test('lists channels people can read, in Discord order', async () => {
    const { client } = setup(
        respond(200, [
            { id: '3', name: 'forum', type: 15, position: 2 },
            { id: '1', name: 'Category', type: 4, position: 0 },
            { id: '2', name: 'general', type: 0, position: 1 },
            { id: '4', name: 'Voice', type: 2, position: 3 },
        ]),
    );

    assert.deepEqual(await client.channels(), [
        { id: '2', name: 'general', type: 0, isForum: false, hasThreads: true },
        { id: '3', name: 'forum', type: 15, isForum: true, hasThreads: true },
        { id: '4', name: 'Voice', type: 2, isForum: false, hasThreads: false },
    ]);
});

const rawThread = (id, archived) => ({ id, name: `t${id}`, parent_id: '42', thread_metadata: { archive_timestamp: archived } });

test('finds open, closed and closed private threads, paging closed ones', async () => {
    const { client, calls } = setup(
        respond(200, { threads: [rawThread('10'), { ...rawThread('11'), parent_id: 'other' }] }),
        respond(200, { threads: [rawThread('12', '2026-10-02T00:00:00.000Z')], has_more: true }),
        respond(200, { threads: [rawThread('13', '2026-10-01T00:00:00.000Z')], has_more: false }),
        respond(200, { threads: [rawThread('14', '2026-09-01T00:00:00.000Z')], has_more: false }),
    );
    const { threads, privateSkipped } = await client.threads({ id: '42', type: 0 });

    assert.deepEqual(threads.map(({ id }) => id), ['10', '12', '13', '14']);
    assert.equal(privateSkipped, false);
    assert.match(calls[0].url, /\/guilds\/1\/threads\/active$/);
    assert.match(calls[1].url, /\/channels\/42\/threads\/archived\/public\?limit=100$/);
    assert.match(calls[2].url, /archived\/public\?limit=100&before=2026-10-02T00%3A00%3A00\.000Z$/);
    assert.match(calls[3].url, /archived\/private\?limit=100$/);
});

test('leaves out closed private threads when Discord refuses them', async () => {
    const { client } = setup(respond(200, { threads: [] }), respond(200, { threads: [rawThread('12')], has_more: false }), respond(403, { message: 'Missing Access' }));
    const { threads, privateSkipped } = await client.threads({ id: '42', type: 0 });

    assert.deepEqual(threads.map(({ id }) => id), ['12']);
    assert.equal(privateSkipped, true);
});

test('a forum has no private threads to ask for', async () => {
    const { client, calls } = setup(respond(200, { threads: [] }), respond(200, { threads: [], has_more: false }));

    assert.deepEqual(await client.threads({ id: '42', type: 15 }), { threads: [], privateSkipped: false });
    assert.equal(calls.length, 2);
});

test('sorts roles by what the bot can manage', () => {
    const roles = [
        { id: '1', position: 0, managed: false },
        { id: '10', position: 1, managed: false },
        { id: '20', position: 2, managed: true },
        { id: '30', position: 3, managed: false },
        { id: '15', position: 2, managed: false },
        { id: '40', position: 2, managed: false },
    ];
    const { manageable, blocked } = checkRoles(roles, ['20'], '1');

    assert.deepEqual(manageable.map(({ id }) => id), ['10', '40']);
    assert.deepEqual(blocked.map(({ role }) => role.id), ['20', '30', '15']);
});
