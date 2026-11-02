import { changeKey } from './runner.js';

export const RESULT_COLUMNS = ['time', 'batch', 'member_id', 'member', 'action', 'role_id', 'role', 'result', 'detail'];

// Member names are chosen by members, and a spreadsheet would run one starting
// with these characters as a formula, so it gets a harmless leading quote.
function csvField(value) {
    let text = String(value ?? '');

    if (/^[=+\-@\t\r]/.test(text)) {
        text = `'${text}`;
    }

    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvHeader() {
    return `${RESULT_COLUMNS.join(',')}\n`;
}

export function csvRow({ time, batch, memberId, memberName, action, roleId, roleName, result, detail }) {
    const fields = [time, batch, memberId, memberName, action, roleId, roleName, result, detail];
    return `${fields.map(csvField).join(',')}\n`;
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (quoted && char === '"' && text[i + 1] === '"') {
            field += '"';
            i++;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === ',' && !quoted) {
            row.push(field);
            field = '';
        } else if (char === '\n' && !quoted) {
            row.push(field.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += char;
        }
    }

    return rows;
}

// Reads a results file. A last line with no line ending, or any row with the wrong
// number of columns, was cut off by a crash and is left out.
export function parseResults(text) {
    const [header = [], ...rows] = parseCsv(text);

    return rows
        .filter((row) => row.length === header.length)
        .map((row) => Object.fromEntries(header.map((column, index) => [column, row[index]])))
        .map((row) => ({
            time: row.time,
            batch: row.batch,
            memberId: row.member_id,
            memberName: row.member,
            action: row.action,
            roleId: row.role_id,
            roleName: row.role,
            result: row.result,
            detail: row.detail,
        }));
}

// Everything already done, for resuming a stopped batch. Failed changes are tried again.
export function completedKeys(rows) {
    return new Set(rows.filter((row) => row.result === 'ok').map(changeKey));
}
