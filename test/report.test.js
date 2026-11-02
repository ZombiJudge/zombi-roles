import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan } from '../src/core/plan.js';
import { buildErrorReport } from '../src/core/report.js';
import { parseResults } from '../src/core/results.js';
import { runBatch } from '../src/core/runner.js';
import { FakeServer, fakeSleep, makeMembers } from './helpers/fake-discord.js';

const clean = { status: 'finished', error: null, failures: [], unsaved: [] };
const change = { action: 'add', roleName: 'Helper', memberName: 'Alice', memberId: '1' };

test('has nothing to report for a clean batch', () => {
    assert.equal(buildErrorReport(1, clean), null);
});

test('lists changes that did not work with the reason', () => {
    const report = buildErrorReport(12, { ...clean, failures: [{ ...change, detail: 'Unknown Member' }] });

    assert.equal(report.failed, 1);
    assert.match(report.text, /batch 12/);
    assert.match(report.text, /Add Helper to Alice \(1\): Unknown Member/);
});

test('tells people to keep the error CSV for unsaved results', () => {
    const unsaved = [{ ...change, action: 'remove', result: 'ok', saveError: 'Disk full' }];
    const report = buildErrorReport(12, { ...clean, unsaved });

    assert.equal(report.unsaved, 1);
    assert.match(report.text, /Keep the error CSV/);
    assert.match(report.text, /Reason: Disk full/);
    assert.match(report.text, /Remove Helper from Alice \(1\): done/);
});

test('explains a batch that ended early', () => {
    const report = buildErrorReport(12, { ...clean, status: 'failed', error: 'Token rejected' });

    assert.match(report.text, /ended early: Token rejected/);
});

test('offers the error lines as a CSV, one row per change', () => {
    const failed = { ...change, roleId: 'r1', result: 'failed', detail: 'Unknown Member' };
    const unsaved = [
        { ...failed, saveError: 'Disk full' },
        { ...change, memberId: '2', roleId: 'r1', result: 'ok', detail: '', saveError: 'Disk full' },
    ];
    const { csv } = buildErrorReport(12, { ...clean, failures: [failed, { ...failed, memberId: '3' }], unsaved });
    const rows = parseResults(csv);

    assert.deepEqual(rows.map(({ batch, memberId, result, detail }) => [batch, memberId, result, detail]), [
        ['12', '3', 'failed', 'Unknown Member'],
        ['12', '1', 'failed', 'Unknown Member; Not saved: Disk full'],
        ['12', '2', 'ok', 'Not saved: Disk full'],
    ]);
});

test('reports on a real batch with every kind of problem', async () => {
    const members = makeMembers(4);
    const server = new FakeServer(members, { failIds: [members[1].id] });
    const { changes } = buildPlan({ members, addRoleIds: ['new'] });
    const onResult = ({ memberId }) => {
        if (memberId === members[2].id) {
            throw new Error('Disk full');
        }
    };
    const summary = await runBatch({ changes, applyChange: server.applyChange, onResult, sleep: fakeSleep() });
    const report = buildErrorReport(1, summary);

    assert.deepEqual([report.failed, report.unsaved], [1, 1]);
    assert.ok(parseResults(report.csv).every(({ time }) => !Number.isNaN(Date.parse(time))));
});
