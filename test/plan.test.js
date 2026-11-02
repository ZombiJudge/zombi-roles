import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan, memberLabel } from '../src/core/plan.js';
import { makeMembers } from './helpers/fake-discord.js';

test('counts what a batch would do and changes nothing', () => {
    const members = makeMembers(8);
    const before = structuredClone(members);
    const plan = buildPlan({
        members,
        addRoleIds: ['role-a'],
        removeRoleIds: ['role-b'],
        unresolved: ['nobody'],
        ambiguous: [{ name: 'sam', candidates: [] }],
    });

    assert.deepEqual(plan.counts, { matched: 8, unresolved: 1, ambiguous: 1, alreadySet: 10, willChange: 6 });
    assert.deepEqual(members, before);
});

test('splits changes from roles already set for add and remove', () => {
    const [hasRole, noRole] = makeMembers(2);
    const adding = buildPlan({ members: [hasRole, noRole], addRoleIds: ['role-a'] });
    const removing = buildPlan({ members: [hasRole, noRole], removeRoleIds: ['role-a'] });

    assert.deepEqual(adding.changes.map(({ memberId }) => memberId), [noRole.id]);
    assert.deepEqual(removing.changes.map(({ memberId }) => memberId), [hasRole.id]);
});

test('labels members so a shared nickname stays clear', () => {
    assert.equal(memberLabel({ nickname: 'Twin', username: 'member_1' }), 'Twin (member_1)');
    assert.equal(memberLabel({ globalName: 'Sam', username: 'sam' }), 'Sam (sam)');
    assert.equal(memberLabel({ username: 'sam' }), 'sam');
});

test('refuses a role in both lists or no roles at all', () => {
    assert.throws(() => buildPlan({ members: [], addRoleIds: ['x'], removeRoleIds: ['x'] }), RangeError);
    assert.throws(() => buildPlan({ members: [] }), RangeError);
});

test('warns when Discord cannot show progress for the whole batch', () => {
    assert.equal(buildPlan({ members: makeMembers(900), addRoleIds: ['new'] }).tooLongForDiscordProgress, false);
    assert.equal(buildPlan({ members: makeMembers(901), addRoleIds: ['new'] }).tooLongForDiscordProgress, true);
});
