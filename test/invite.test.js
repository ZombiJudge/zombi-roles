import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInviteCode } from '../src/core/invite.js';

test('accepts a code or any common invite link', () => {
    for (const text of [
        'abc123',
        '  abc123 ',
        'discord.gg/abc123',
        'https://discord.gg/abc123',
        'https://discord.gg/abc123/',
        'https://discord.gg/abc123?event=1',
        'https://discord.com/invite/abc123',
        'https://www.discord.com/invite/abc123',
        'https://discordapp.com/invite/abc123',
    ]) {
        assert.equal(parseInviteCode(text), 'abc123');
    }
});

test('keeps the upper and lower case of a code', () => {
    assert.equal(parseInviteCode('https://discord.gg/xYz12AbC'), 'xYz12AbC');
});

test('rejects anything else', () => {
    for (const text of ['', 'https://example.com/abc123', 'two words', 'discord.gg/']) {
        assert.throws(() => parseInviteCode(text), RangeError);
    }
});
