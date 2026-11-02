import { csvHeader, csvRow } from './results.js';
import { changeKey } from './runner.js';

const describe = ({ action, roleName, memberName, memberId }) =>
    `${action === 'add' ? 'Add' : 'Remove'} ${roleName} ${action === 'add' ? 'to' : 'from'} ${memberName} (${memberId})`;

const changeCount = (count) => (count === 1 ? '1 change' : `${count} changes`);
const resultCount = (count) => (count === 1 ? '1 result' : `${count} results`);

// The error lines as a CSV with the same columns as a results file, one row per change.
function errorCsv(batch, failures, unsaved) {
    const unsavedKeys = new Set(unsaved.map(changeKey));
    const rows = [
        ...failures.filter((row) => !unsavedKeys.has(changeKey(row))),
        ...unsaved.map((row) => ({ ...row, detail: [row.detail, `Not saved: ${row.saveError}`].filter(Boolean).join('; ') })),
    ];

    return csvHeader() + rows.map((row) => csvRow({ ...row, batch })).join('');
}

// Writes a report of what went wrong in a batch for the person who ran it: plain-language
// text to read, plus a CSV of the error lines to download. Null when there is nothing to report.
export function buildErrorReport(batch, { status, error, failures, unsaved }) {
    if (status !== 'failed' && failures.length === 0 && unsaved.length === 0) {
        return null;
    }

    const sections = [`Zombi Roles batch ${batch}: error report`];

    if (status === 'failed') {
        sections.push(`The batch ended early: ${error}\nResume it once this is fixed.`);
    }

    if (failures.length > 0) {
        const lines = failures.map((row) => `- ${describe(row)}: ${row.detail}`);
        sections.push([`Did not work (${changeCount(failures.length)}):`, ...lines].join('\n'));
    }

    if (unsaved.length > 0) {
        const lines = unsaved.map((row) => `- ${describe(row)}: ${row.result === 'ok' ? 'done' : 'not done'}`);
        sections.push(
            [
                `Not saved to the results file (${resultCount(unsaved.length)}). Keep the error CSV, because Undo needs it to reverse these:`,
                `Reason: ${unsaved[0].saveError}`,
                ...lines,
            ].join('\n'),
        );
    }

    return {
        failed: failures.length,
        unsaved: unsaved.length,
        text: `${sections.join('\n\n')}\n`,
        csv: errorCsv(batch, failures, unsaved),
    };
}
