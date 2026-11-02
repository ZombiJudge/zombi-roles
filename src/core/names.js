const HEADER_WORDS = new Set(['name', 'names', 'username', 'usernames', 'user', 'member', 'members', 'nickname']);

// The key two names are compared by, so upper and lower case never matter.
export function nameKey(name) {
    return name.normalize('NFC').trim().toLowerCase();
}

function splitColumns(line, format) {
    if (format !== 'csv') {
        return line.split('\t');
    }

    const columns = [];
    let current = '';
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (quoted && char === '"' && line[i + 1] === '"') {
            current += '"';
            i++;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === ',' && !quoted) {
            columns.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    columns.push(current);
    return columns;
}

function cleanName(raw) {
    return raw.trim().replace(/^[@＠]+/, '').trim();
}

// Turns pasted text or a file into a clean list of names, one per member.
// Commas only split columns in 'csv' format, because a pasted display name can contain one.
export function parseNameList(text, { format = 'lines' } = {}) {
    const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const seen = new Set();
    const names = [];
    let isFirstLine = true;

    for (const line of lines) {
        if (line.trim() === '') {
            continue;
        }

        const columns = splitColumns(line, format);
        const name = cleanName(columns[0]);
        const isHeader = isFirstLine && columns.length > 1 && HEADER_WORDS.has(nameKey(name));
        isFirstLine = false;

        if (name === '' || isHeader || seen.has(nameKey(name))) {
            continue;
        }

        seen.add(nameKey(name));
        names.push(name);
    }

    return names;
}
