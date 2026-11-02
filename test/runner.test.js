import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan } from '../src/core/plan.js';
import { auditReason, changeKey, runBatch } from '../src/core/runner.js';
import { FakeServer, fakeSleep, makeMembers } from './helpers/fake-discord.js';

const setup = (count, options) => {
    const members = makeMembers(count);
    const server = new FakeServer(members, options);
    const { changes } = buildPlan({ members, addRoleIds: ['new'] });

    return { server, changes, sleep: fakeSleep(), applyChange: server.applyChange, reason: 'test' };
};

test('waits about a second between changes and not after the last', async () => {
    const { server, changes, sleep, applyChange } = setup(4);
    const summary = await runBatch({ changes, applyChange, sleep });

    assert.deepEqual(sleep.waits, [1000, 1000, 1000]);
    assert.equal(summary.status, 'finished');
    assert.equal(summary.ok, 4);
    assert.ok(server.snapshot().every(({ roleIds }) => roleIds.includes('new')));
});

test('waits out rate limits and retries the same change', async () => {
    const { changes, sleep, applyChange } = setup(3, { rateLimitEvery: 2, retryAfter: 7 });
    const summary = await runBatch({ changes, applyChange, sleep });

    assert.equal(summary.ok, 3);
    assert.ok(sleep.waits.includes(7000));
});

test('gives up on a change after too many rate limits and carries on', async () => {
    const { changes, sleep, applyChange } = setup(1, { rateLimitEvery: 1 });
    const results = [];
    const summary = await runBatch({ changes, applyChange, sleep, onResult: (row) => results.push(row) });

    assert.equal(summary.failed, 1);
    assert.equal(results[0].detail, 'Rate limited too many times');
});

test('records a failed member and carries on', async () => {
    const members = makeMembers(3);
    const server = new FakeServer(members, { failIds: [members[1].id] });
    const { changes } = buildPlan({ members, addRoleIds: ['new'] });
    const results = [];
    const summary = await runBatch({
        changes,
        applyChange: server.applyChange,
        sleep: fakeSleep(),
        onResult: (row) => results.push(row),
    });

    assert.deepEqual([summary.ok, summary.failed], [2, 1]);
    assert.deepEqual(results.map(({ result }) => result), ['ok', 'failed', 'ok']);
    assert.equal(results[1].detail, 'Unknown Member');
});

test('stops between changes when asked', async () => {
    const { changes, sleep, applyChange } = setup(5);
    const controller = new AbortController();
    const summary = await runBatch({
        changes,
        applyChange,
        sleep,
        signal: controller.signal,
        onProgress: ({ done }) => done === 2 && controller.abort(),
    });

    assert.equal(summary.status, 'stopped');
    assert.equal(summary.ok, 2);
});

test('stop interrupts the real wait right away', async () => {
    const { changes, applyChange } = setup(2);
    const controller = new AbortController();
    const started = Date.now();
    const summary = await runBatch({
        changes,
        applyChange,
        delayMs: 60000,
        signal: controller.signal,
        onProgress: () => controller.abort(),
    });

    assert.equal(summary.status, 'stopped');
    assert.ok(Date.now() - started < 5000);
});

test('stops for a problem no later change could survive', async () => {
    const { changes, sleep, applyChange } = setup(5, { fatalAfter: 2 });
    const summary = await runBatch({ changes, applyChange, sleep });

    assert.equal(summary.status, 'failed');
    assert.equal(summary.ok, 2);
    assert.equal(summary.error, 'Token rejected');
});

test('carries on and keeps the result if it cannot be saved', async () => {
    const { server, changes, sleep, applyChange } = setup(3);
    const onResult = ({ memberId }) => {
        if (memberId === changes[1].memberId) {
            throw new Error('Disk full');
        }
    };
    const summary = await runBatch({ changes, applyChange, sleep, onResult });

    assert.equal(server.calls, 3);
    assert.equal(summary.status, 'finished');
    assert.equal(summary.ok, 3);
    assert.deepEqual(summary.unsaved.map(({ memberId, saveError }) => [memberId, saveError]), [[changes[1].memberId, 'Disk full']]);
});

test('skips completed changes when resuming', async () => {
    const { server, changes, sleep, applyChange } = setup(4);
    const summary = await runBatch({ changes, applyChange, sleep, completedKeys: new Set([changeKey(changes[0])]) });

    assert.equal(summary.total, 3);
    assert.equal(server.calls, 3);
});

test('builds the audit log reason within Discord limits', async () => {
    assert.equal(auditReason(12, 'Sam'), 'Zombi Roles batch 12 by Sam');
    assert.equal(auditReason(1, 'x'.repeat(600)).length, 512);
});
