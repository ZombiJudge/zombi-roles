import { nameKey } from './names.js';

// Reads a slash command's role text: role mentions or role names, separated by commas.
// Roles are one-per-option in Discord, so this is how one option can hold several.
export function parseRoleInput(text, roles) {
    const ids = [];
    const unknown = [];
    const parts = String(text ?? '')
        .replace(/<@&(\d+)>/g, ',$1,')
        .split(',')
        .map((part) => part.trim().replace(/^[@＠]+/, ''))
        .filter(Boolean);

    for (const part of parts) {
        const role = roles.find(({ id, name }) => id === part || nameKey(name) === nameKey(part));

        if (!role) {
            unknown.push(part);
        } else if (!ids.includes(role.id)) {
            ids.push(role.id);
        }
    }

    return { ids, unknown };
}
