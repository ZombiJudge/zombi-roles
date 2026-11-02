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
