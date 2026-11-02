import { nameKey } from './names.js';

const MAX_CHOICES = 25;
const MAX_VALUE_LENGTH = 100;

// Suggests how to finish the last entry in a comma-separated field, keeping what is
// already typed. Each option is { label, value, searchText: [...] }.
export function autofillChoices(typed, options) {
    const lastComma = typed.lastIndexOf(',');
    const earlier = lastComma === -1 ? '' : typed.slice(0, lastComma);
    const before = earlier.trim() === '' ? '' : `${earlier.trim()}, `;
    const current = nameKey(typed.slice(lastComma + 1).replace(/^\s*[@＠]*/, ''));
    const taken = new Set(earlier.split(',').map(nameKey).filter(Boolean));
    const choices = [];

    for (const { label, value, searchText } of options) {
        const full = `${before}${value}`;
        const keys = searchText.filter(Boolean).map(nameKey);

        if (full.length > MAX_VALUE_LENGTH || keys.some((key) => taken.has(key)) || !keys.some((key) => key.includes(current))) {
            continue;
        }

        choices.push({ name: label.slice(0, MAX_VALUE_LENGTH), value: full });

        if (choices.length === MAX_CHOICES) {
            break;
        }
    }

    return choices;
}
