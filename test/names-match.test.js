import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchNames, suggestName } from '../src/core/match.js';
import { parseNameList } from '../src/core/names.js';

const member = (id, username, nickname = null, globalName = null) => ({ id, username, nickname, globalName });

test('cleans pasted names', () => {
    assert.deepEqual(parseNameList('  alice \n@Bob\n＠carol\n\nALICE\r\nbob'), ['alice', 'Bob', 'carol']);
});

test('keeps commas in pasted names but splits them in csv files', () => {
    assert.deepEqual(parseNameList('Smith, Jo'), ['Smith, Jo']);
    assert.deepEqual(parseNameList('Smith, Jo', { format: 'csv' }), ['Smith']);
    assert.deepEqual(parseNameList('"Smith, Jo",2026-01-01', { format: 'csv' }), ['Smith, Jo']);
});

test('ignores tab columns, a file byte order mark, and a header row', () => {
    assert.deepEqual(parseNameList('alice\t2026-01-01\tUnknown'), ['alice']);
    assert.deepEqual(parseNameList('﻿username,joined\nalice,2026\n', { format: 'csv' }), ['alice']);
});

test('does not mistake a member called name for a header', () => {
    assert.deepEqual(parseNameList('name\nalice'), ['name', 'alice']);
});

test('matches username first, then nickname, then display name, ignoring case', () => {
    const members = [member('1', 'alice', 'bob'), member('2', 'bob'), member('3', 'carl', 'Cee'), member('4', 'dan', null, 'Dee')];
    const { matched } = matchNames(['ALICE', 'bob', 'cee', 'dee'], members);

    assert.deepEqual(
        matched.map(({ member: found, matchedBy }) => [found.id, matchedBy]),
        [
            ['1', 'username'],
            ['2', 'username'],
            ['3', 'nickname'],
            ['4', 'display name'],
        ],
    );
});

test('reports unknown and shared names instead of guessing', () => {
    const members = [member('1', 'a1', 'Sam'), member('2', 'a2', 'sam'), member('3', 'a3')];
    const { matched, unresolved, ambiguous } = matchNames(['sam', 'nobody'], members);

    assert.equal(matched.length, 0);
    assert.deepEqual(unresolved, ['nobody']);
    assert.deepEqual(ambiguous[0].candidates.map(({ id }) => id), ['1', '2']);
});

test('counts a member once when two names point to them', () => {
    const { matched, repeated } = matchNames(['alice', 'Ali'], [member('1', 'alice', 'Ali')]);

    assert.equal(matched.length, 1);
    assert.equal(repeated[0].name, 'Ali');
});

test('accepts a mix of usernames, nicknames, and display names', () => {
    const members = [member('1', 'alice'), member('2', 'bob', 'Bobby'), member('3', 'carl', null, 'Carl B')];
    const { matched, unresolved } = matchNames(['alice', 'Bobby', 'carl b'], members);

    assert.equal(matched.length, 3);
    assert.deepEqual(unresolved, []);
});

test('accepts Name (username) labels and uses the username', () => {
    const members = [member('1', 'a1', 'Twin'), member('2', 'a2', 'Twin')];
    const { matched } = matchNames(['Twin (a2)'], members);

    assert.equal(matched[0].member.id, '2');
});

test('keeps brackets that are part of a real name', () => {
    const { matched } = matchNames(['Sam (mod)'], [member('1', 'sam', 'Sam (mod)')]);

    assert.equal(matched[0].member.id, '1');
});

test('suggests the closest name but only when it is close', () => {
    const members = [member('1', 'Zombi Test Member 1'), member('2', 'carl')];

    assert.equal(suggestName('Zombi Test Bot 1', members), 'Zombi Test Member 1');
    assert.equal(suggestName('nobody at all here', members), null);
});
