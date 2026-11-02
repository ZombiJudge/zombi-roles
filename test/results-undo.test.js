import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { matchNames } from '../src/core/match.js';
import { buildPlan } from '../src/core/plan.js';
import { completedKeys, csvHeader, csvRow, parseResults } from '../src/core/results.js';
import { auditReason, runBatch } from '../src/core/runner.js';
import { planUndo } from '../src/core/undo.js';
import { openResultsFile } from '../src/storage/results-file.js';
import { FakeServer, fakeSleep, makeMembers } from './helpers/fake-discord.js';

const folder = mkdtempSync(join(tmpdir(), 'zombi-roles-'));
after(() => rmSync(folder, { recursive: true }));

const row = (overrides) => ({
    time: 't',
    batch: 1,
    memberId: '1',
    memberName: 'Alice',
    action: 'add',
    roleId: 'r1',
    roleName: 'Helper',
    result: 'ok',
    detail: '',
    ...overrides,
});

test('results survive the trip through a CSV file', () => {
    const original = row({ memberName: 'Smith, "Jo"', detail: 'line\nbreak' });
    const [parsed] = parseResults(csvHeader() + csvRow(original));

    assert.equal(parsed.memberName, original.memberName);
    assert.equal(parsed.detail, original.detail);
});

test('a member name cannot become a spreadsheet formula', () => {
    assert.ok(csvRow(row({ memberName: '=HYPERLINK("x")' })).includes(`"'=HYPERLINK`));
});

test('drops a line cut off by a crash', () => {
    const text = csvHeader() + csvRow(row({ memberId: '1' })) + csvRow(row({ memberId: '2' })).slice(0, 12);

    assert.deepEqual(parseResults(text).map(({ memberId }) => memberId), ['1']);
});

test('saves each change as it happens and adds to the same file after a crash', () => {
    const path = join(folder, 'nested', 'batch-1.csv');
    openResultsFile(path, 1).append(row({ memberId: '1' }));
    appendFileSync(path, 't,1,2,cut off');

    const reopened = openResultsFile(path, 1);
    assert.deepEqual(reopened.rows.map(({ memberId }) => memberId), ['1']);

    reopened.append(row({ memberId: '3' }));
    assert.deepEqual(parseResults(readFileSync(path, 'utf8')).map(({ memberId }) => memberId), ['1', '3']);
});

test('undo reverses only what worked, newest first', () => {
    const { changes } = planUndo([
        row({ memberId: '1', action: 'add' }),
        row({ memberId: '2', action: 'remove' }),
        row({ memberId: '3', result: 'failed' }),
    ]);

    assert.deepEqual(changes.map(({ memberId, action }) => [memberId, action]), [
        ['2', 'add'],
        ['1', 'remove'],
    ]);
});

test('undo counts a change once when a resumed batch repeated it', () => {
    assert.equal(planUndo([row({}), row({})]).changes.length, 1);
});

test('undo leaves out changes already reversed and members who left', () => {
    const rows = [row({ memberId: '1' }), row({ memberId: '2' }), row({ memberId: '3' })];
    const members = [
        { id: '1', roleIds: [] },
        { id: '2', roleIds: ['r1'] },
    ];
    const { changes, alreadySet, missing } = planUndo(rows, { members });

    assert.deepEqual(changes.map(({ memberId }) => memberId), ['2']);
    assert.deepEqual(alreadySet.map(({ memberId }) => memberId), ['1']);
    assert.deepEqual(missing.map(({ memberId }) => memberId), ['3']);
});

test('a 1000 member batch stops, resumes, and undoes cleanly', async () => {
    const members = makeMembers(1000);
    const server = new FakeServer(members, { rateLimitEvery: 97, failIds: [members[500].id] });
    const path = join(folder, 'batch-12.csv');
    const names = [...members.map(({ username }) => username), 'nobody'];
    const { matched, unresolved } = matchNames(names, members);
    const plan = buildPlan({
        members: matched.map(({ member }) => member),
        addRoleIds: ['role-b'],
        removeRoleIds: ['role-a'],
        unresolved,
    });
    const run = (results, signal, done = new Set(), onProgress = () => {}) =>
        runBatch({
            changes: plan.changes,
            applyChange: server.applyChange,
            reason: auditReason(12, 'Sam'),
            onResult: results.append,
            onProgress,
            signal,
            completedKeys: done,
            sleep: fakeSleep(),
        });

    assert.deepEqual(plan.counts, { matched: 1000, unresolved: 1, ambiguous: 0, alreadySet: 750, willChange: 1250 });

    const controller = new AbortController();
    const first = await run(openResultsFile(path, 12), controller.signal, new Set(), ({ done }) => {
        if (done === 400) {
            controller.abort();
        }
    });
    assert.equal(first.status, 'stopped');

    const reopened = openResultsFile(path, 12);
    const second = await run(reopened, undefined, completedKeys(reopened.rows));
    assert.equal(second.status, 'finished');
    assert.equal(second.ok + second.failed, 850);
    assert.equal(second.failed, 2, 'the failing member has one add and one remove');
    assert.deepEqual([...server.reasons], ['Zombi Roles batch 12 by Sam']);

    const finalRows = parseResults(readFileSync(path, 'utf8'));
    const undo = planUndo(finalRows, { members: server.snapshot() });
    await runBatch({ changes: undo.changes, applyChange: server.applyChange, sleep: fakeSleep() });

    const sorted = (list) => list.map(({ id, roleIds }) => [id, roleIds.toSorted()]);
    assert.deepEqual(sorted(server.snapshot()), sorted(members));
});
