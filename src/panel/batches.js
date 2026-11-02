import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildErrorReport } from '../core/report.js';
import { completedKeys, parseResults } from '../core/results.js';
import { auditReason, runBatch } from '../core/runner.js';
import { planUndo } from '../core/undo.js';
import { openResultsFile } from '../storage/results-file.js';

const RESUMABLE = new Set(['running', 'stopped', 'failed']);
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTER_FILE = 'last-batch.txt';

// Runs one batch at a time and keeps everything needed to resume or undo it.
// The panel and the slash command share this, so both behave the same.
export class BatchManager {
    constructor({ dataDir, delayMs = 1000, sleep }) {
        this.folder = join(dataDir, 'batches');
        this.delayMs = delayMs;
        this.sleep = sleep;
        this.active = null;
        this.finished = null;
    }

    path(batch, suffix) {
        return join(this.folder, `batch-${batch}${suffix}`);
    }

    readMeta(batch) {
        return JSON.parse(readFileSync(this.path(batch, '.json'), 'utf8'));
    }

    writeMeta(meta) {
        try {
            mkdirSync(this.folder, { recursive: true });
            writeFileSync(this.path(meta.batch, '.json'), JSON.stringify(meta));
        } catch {
            // Only resume depends on this file, and the batch must not stop for it.
        }
    }

    numbers() {
        if (!existsSync(this.folder)) {
            return [];
        }

        return readdirSync(this.folder)
            .map((file) => /^batch-(\d+)\.json$/.exec(file)?.[1])
            .filter(Boolean)
            .map(Number)
            .sort((a, b) => b - a);
    }

    list() {
        return this.numbers().map((batch) => {
            const { status, kind, createdAt, operator, counts } = this.readMeta(batch);
            const isActive = this.active?.batch === batch;

            return {
                batch,
                kind,
                createdAt,
                operator,
                counts,
                status: isActive ? 'running' : status === 'running' ? 'interrupted' : status,
                canResume: !isActive && (RESUMABLE.has(status) || (counts?.failed ?? 0) > 0),
                hasResults: existsSync(this.path(batch, '.csv')),
                hasErrors: existsSync(this.path(batch, '-errors.csv')),
            };
        });
    }

    status() {
        const current = this.active ?? this.finished;

        if (!current) {
            return { state: 'idle' };
        }

        const { batch, total, done, ok, failed, unsavedCount, summary, report } = current;
        return {
            state: this.active ? 'running' : 'finished',
            batch,
            total,
            done,
            ok,
            failed,
            unsavedCount,
            stopping: this.active?.controller.signal.aborted ?? false,
            result: summary?.status ?? null,
            error: summary?.error ?? null,
            report: report?.text ?? null,
            hasErrors: report !== null && report !== undefined,
        };
    }

    // Kept apart from the batch files, so numbers in the audit log are never reused after cleanup.
    lastNumber() {
        const path = join(this.folder, COUNTER_FILE);
        return existsSync(path) ? Number(readFileSync(path, 'utf8')) || 0 : 0;
    }

    saveLastNumber(batch) {
        try {
            mkdirSync(this.folder, { recursive: true });
            writeFileSync(join(this.folder, COUNTER_FILE), String(batch));
        } catch {
            // Only numbering depends on this file, and the batch must not stop for it.
        }
    }

    // Deletes batch data and results older than the set number of days. The newest date of a
    // batch's files decides, so resuming a batch keeps it. A running batch is never touched.
    deleteOlderThan(days, now = Date.now()) {
        if (!existsSync(this.folder)) {
            return 0;
        }

        const cutoff = now - days * DAY_MS;
        const newest = new Map();

        for (const file of readdirSync(this.folder)) {
            const batch = /^batch-(\d+)[-.]/.exec(file)?.[1];

            if (batch) {
                const entry = newest.get(batch) ?? { files: [], time: 0 };
                entry.files.push(file);
                entry.time = Math.max(entry.time, statSync(join(this.folder, file)).mtimeMs);
                newest.set(batch, entry);
            }
        }

        let deleted = 0;

        for (const [batch, { files, time }] of newest) {
            if (time < cutoff && this.active?.batch !== Number(batch)) {
                files.forEach((file) => rmSync(join(this.folder, file), { force: true }));
                deleted++;
            }
        }

        return deleted;
    }

    assertIdle() {
        if (this.active) {
            throw new RangeError('A batch is already running. Wait for it to finish or stop it first.');
        }
    }

    start({ changes, operator, kind = 'batch', client }) {
        this.assertIdle();

        const batch = Math.max(this.numbers()[0] ?? 0, this.lastNumber()) + 1;
        const meta = { batch, kind, operator, changes, status: 'running', createdAt: new Date().toISOString() };

        this.saveLastNumber(batch);

        this.writeMeta(meta);
        this.run(meta, new Set(), client);
        return batch;
    }

    resume(batch, client) {
        this.assertIdle();

        const meta = this.readMeta(batch);
        const rows = existsSync(this.path(batch, '.csv')) ? parseResults(readFileSync(this.path(batch, '.csv'), 'utf8')) : [];

        this.writeMeta({ ...meta, status: 'running' });
        this.run({ ...meta, status: 'running' }, completedKeys(rows), client);
    }

    stop() {
        this.active?.controller.abort();
    }

    run(meta, done, client) {
        const { batch, changes, operator } = meta;
        const controller = new AbortController();
        let results;

        try {
            results = openResultsFile(this.path(batch, '.csv'), batch);
        } catch (error) {
            results = {
                append() {
                    throw error;
                },
            };
        }

        const current = { batch, controller, total: 0, done: 0, ok: 0, failed: 0, unsavedCount: 0 };
        this.active = current;
        current.total = changes.filter((change) => !done.has(`${change.memberId}:${change.action}:${change.roleId}`)).length;

        this.running = runBatch({
            changes,
            applyChange: client.applyChange,
            reason: auditReason(batch, operator),
            signal: controller.signal,
            completedKeys: done,
            delayMs: this.delayMs,
            sleep: this.sleep,
            onResult: (row) => {
                try {
                    results.append(row);
                } catch (error) {
                    current.unsavedCount++;
                    throw error;
                }
            },
            onProgress: (progress) => Object.assign(current, progress),
        })
            .then((summary) => this.finish(meta, current, summary))
            .catch((error) => this.finish(meta, current, { status: 'failed', error: error.message, failures: [], unsaved: [], ok: current.ok, failed: current.failed }));

        return this.running;
    }

    finish(meta, current, summary) {
        const report = buildErrorReport(meta.batch, summary);

        if (report) {
            try {
                writeFileSync(this.path(meta.batch, '-errors.csv'), report.csv);
            } catch {
                // The report still shows on screen, and its CSV stays downloadable from memory.
            }
        }

        this.writeMeta({ ...meta, status: summary.status, counts: { ok: summary.ok, failed: summary.failed } });
        this.finished = { ...current, summary, report };
        this.active = null;
    }

    errorCsv(batch) {
        if (this.finished?.batch === batch && this.finished.report) {
            return this.finished.report.csv;
        }

        return readFileSync(this.path(batch, '-errors.csv'), 'utf8');
    }

    resultsCsv(batch) {
        return readFileSync(this.path(batch, '.csv'), 'utf8');
    }

    // Results plus the error file, which holds changes that worked but could not be saved.
    resultRows(batch) {
        const read = (suffix) => (existsSync(this.path(batch, suffix)) ? parseResults(readFileSync(this.path(batch, suffix), 'utf8')) : []);
        return [...read('.csv'), ...read('-errors.csv')];
    }

    planUndo(rows, members) {
        return planUndo(rows, { members });
    }
}
