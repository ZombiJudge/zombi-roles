const MAX_REASON_LENGTH = 512;
const MAX_RATE_LIMIT_RETRIES = 5;

// Thrown by applyChange when Discord answers 429.
export class RateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super(`Rate limited for ${retryAfterSeconds} seconds`);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// Thrown by applyChange when no later change can work either, such as a rejected token.
export class FatalBatchError extends Error {}

export function auditReason(batchNumber, operator) {
    return `Zombi Roles batch ${batchNumber} by ${operator}`.slice(0, MAX_REASON_LENGTH);
}

export function changeKey({ memberId, action, roleId }) {
    return `${memberId}:${action}:${roleId}`;
}

function wait(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }

        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);

        signal?.addEventListener('abort', finish, { once: true });
    });
}

// Applies one change, waiting out rate limits. Returns null if stopped while waiting.
async function applyWithRetries(change, { applyChange, reason, signal, sleep }) {
    for (let attempt = 0; ; attempt++) {
        try {
            await applyChange(change, reason);
            return { result: 'ok', detail: '' };
        } catch (error) {
            if (error instanceof FatalBatchError) {
                throw error;
            }

            if (!(error instanceof RateLimitError)) {
                return { result: 'failed', detail: error.message };
            }

            if (attempt === MAX_RATE_LIMIT_RETRIES) {
                return { result: 'failed', detail: 'Rate limited too many times' };
            }

            await sleep(error.retryAfterSeconds * 1000, signal);

            if (signal?.aborted) {
                return null;
            }
        }
    }
}

// Applies changes one at a time. onResult runs after every change. If it throws, the batch
// carries on and the result is kept in summary.unsaved for the error report.
// Changes in completedKeys are skipped, which is how a batch resumes.
export async function runBatch({
    changes,
    applyChange,
    reason,
    onResult = () => {},
    onProgress = () => {},
    signal,
    completedKeys = new Set(),
    delayMs = 1000,
    sleep = wait,
}) {
    const pending = changes.filter((change) => !completedKeys.has(changeKey(change)));
    const summary = { status: 'finished', total: pending.length, ok: 0, failed: 0, error: null, failures: [], unsaved: [] };

    for (const [index, change] of pending.entries()) {
        if (signal?.aborted) {
            summary.status = 'stopped';
            break;
        }

        let outcome;

        try {
            outcome = await applyWithRetries(change, { applyChange, reason, signal, sleep });
        } catch (error) {
            if (!(error instanceof FatalBatchError)) {
                throw error;
            }

            summary.status = 'failed';
            summary.error = error.message;
            break;
        }

        if (outcome === null) {
            summary.status = 'stopped';
            break;
        }

        const row = { ...change, ...outcome, time: new Date().toISOString() };
        summary[outcome.result]++;

        if (outcome.result === 'failed') {
            summary.failures.push(row);
        }

        try {
            await onResult(row);
        } catch (error) {
            summary.unsaved.push({ ...row, saveError: error.message });
        }

        onProgress({ done: summary.ok + summary.failed, total: pending.length, ok: summary.ok, failed: summary.failed });

        if (index < pending.length - 1) {
            await sleep(delayMs, signal);
        }
    }

    return summary;
}
