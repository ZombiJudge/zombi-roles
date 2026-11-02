import { nameKey } from './names.js';

// Checked in this order. The first tier with any match decides the result.
const TIERS = [
    { field: 'username', label: 'username' },
    { field: 'nickname', label: 'nickname' },
    { field: 'globalName', label: 'display name' },
];

function buildIndex(members, field) {
    const index = new Map();

    for (const member of members) {
        if (!member[field]) {
            continue;
        }

        const key = nameKey(member[field]);
        index.set(key, [...(index.get(key) ?? []), member]);
    }

    return index;
}

// Never guesses: a name with no match or more than one match is reported, not applied.
export function matchNames(names, members) {
    const indexes = TIERS.map((tier) => ({ ...tier, index: buildIndex(members, tier.field) }));
    const matched = [];
    const unresolved = [];
    const ambiguous = [];
    const repeated = [];
    const matchedIds = new Set();

    for (const name of names) {
        // Also accepts this app's own "Name (username)" labels, such as from a results file.
        const key = nameKey(/\(([^()]+)\)\s*$/.exec(name)?.[1] ?? '');
        const labelled = key !== '' && indexes[0].index.has(key);
        const lookup = labelled ? key : nameKey(name);
        const tier = indexes.find(({ index }) => index.has(lookup));
        const candidates = tier?.index.get(lookup) ?? [];

        if (candidates.length === 0) {
            unresolved.push(name);
        } else if (candidates.length > 1) {
            ambiguous.push({ name, candidates });
        } else if (matchedIds.has(candidates[0].id)) {
            repeated.push({ name, member: candidates[0] });
        } else {
            matchedIds.add(candidates[0].id);
            matched.push({ name, member: candidates[0], matchedBy: tier.label });
        }
    }

    return { matched, unresolved, ambiguous, repeated };
}

function editDistance(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];

        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }

        previous = current;
    }

    return previous[b.length];
}

// The closest real name to one that matched nobody, for a "did you mean" hint. Never applied by itself.
export function suggestName(name, members) {
    const key = nameKey(name);
    let best = null;

    for (const member of members) {
        for (const candidate of [member.username, member.nickname, member.globalName]) {
            if (!candidate) {
                continue;
            }

            const distance = editDistance(key, nameKey(candidate));

            if (distance <= Math.max(key.length, candidate.length) * 0.4 && (!best || distance < best.distance)) {
                best = { candidate, distance };
            }
        }
    }

    return best?.candidate ?? null;
}
