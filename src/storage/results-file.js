import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { csvHeader, csvRow, parseResults } from '../core/results.js';

// Opens a batch's results file, keeping what is already there so a batch can resume.
// Writes are synchronous so each change is on disk before the next one starts.
export function openResultsFile(path, batch) {
    mkdirSync(dirname(path), { recursive: true });

    if (!existsSync(path)) {
        writeFileSync(path, csvHeader());
    }

    const existing = readFileSync(path, 'utf8');

    if (!existing.endsWith('\n')) {
        appendFileSync(path, '\n');
    }

    return {
        rows: parseResults(existing),
        append(result) {
            appendFileSync(path, csvRow({ time: new Date().toISOString(), batch, ...result }));
        },
    };
}
