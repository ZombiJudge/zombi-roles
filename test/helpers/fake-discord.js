import { FatalBatchError, RateLimitError } from '../../src/core/runner.js';

// Made-up members.
export function makeMembers(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: String(1000 + i),
        username: `member_${i}`,
        nickname: i % 10 === 0 ? `Nick ${i}` : null,
        globalName: i % 5 === 0 ? `Global ${i}` : null,
        roleIds: i % 4 === 0 ? ['role-a'] : [],
    }));
}

// Stands in for Discord. Options make it answer with rate limits and errors on demand.
export class FakeServer {
    constructor(members, { rateLimitEvery = 0, retryAfter = 2, failIds = [], fatalAfter = Infinity } = {}) {
        this.members = new Map(members.map((member) => [member.id, structuredClone(member)]));
        this.rateLimitEvery = rateLimitEvery;
        this.retryAfter = retryAfter;
        this.failIds = new Set(failIds);
        this.fatalAfter = fatalAfter;
        this.calls = 0;
        this.reasons = new Set();
    }

    applyChange = async ({ memberId, action, roleId }, reason) => {
        this.calls++;

        if (this.calls > this.fatalAfter) {
            throw new FatalBatchError('Token rejected');
        }

        if (this.rateLimitEvery > 0 && this.calls % this.rateLimitEvery === 0) {
            throw new RateLimitError(this.retryAfter);
        }

        if (this.failIds.has(memberId)) {
            throw new Error('Unknown Member');
        }

        const member = this.members.get(memberId);
        this.reasons.add(reason);
        member.roleIds = member.roleIds.filter((id) => id !== roleId);

        if (action === 'add') {
            member.roleIds.push(roleId);
        }
    };

    snapshot() {
        return [...this.members.values()];
    }
}

// A sleep that records how long the batch waited, so tests finish instantly.
export function fakeSleep() {
    const sleep = async (ms) => {
        sleep.total += ms;
        sleep.waits.push(ms);
    };

    sleep.total = 0;
    sleep.waits = [];
    return sleep;
}

const CHAT_NAMES = ['Ash', 'Bones', 'Cass', 'Dusk', 'Ember', 'Fern', '=Grim', 'Hollow'];
const CHAT_LINES = ['Who is bringing the playmats?', 'Round 3 pairings are up.', 'GG, that was close!', 'Deck list check is at the front desk.', 'Can someone explain the stack again?\nI keep forgetting.', 'Top 8 starts in 10 minutes.'];

// Made-up messages in the shape DiscordClient.messages() returns, oldest first.
// Includes replies, edits, attachments, mentions, a join, and a name that starts like a spreadsheet formula.
export function makeMessages(count, { idStart = 5000, startsThreadId = null } = {}) {
    const start = Date.parse('2026-10-01T18:00:00Z');

    return Array.from({ length: count }, (_, i) => {
        const name = CHAT_NAMES[i % CHAT_NAMES.length];
        const id = String(idStart + i);
        const replyTo = i > 0 && i % 7 === 0 ? { id: String(idStart + i - 3), authorName: CHAT_NAMES[(i - 3) % CHAT_NAMES.length], snippet: CHAT_LINES[(i - 3) % CHAT_LINES.length] } : null;

        return {
            id,
            type: i % 50 === 1 ? 7 : replyTo ? 19 : 0,
            time: new Date(start + i * 60_000).toISOString(),
            editedTime: i % 11 === 0 ? new Date(start + i * 60_000 + 30_000).toISOString() : null,
            authorId: String(300000 + (i % CHAT_NAMES.length)),
            authorName: name,
            authorUsername: name.replace('=', '').toLowerCase(),
            isBot: false,
            content: i % 50 === 1 ? '' : i % 13 === 0 ? `<@300001> ${CHAT_LINES[i % CHAT_LINES.length]}` : CHAT_LINES[i % CHAT_LINES.length],
            mentions: i % 13 === 0 ? { 300001: 'Bones' } : {},
            replyTo,
            attachments: i % 17 === 0 ? [{ name: `decklist-${i}.png`, url: `https://cdn.discordapp.com/attachments/1/${id}/decklist-${i}.png` }] : [],
            embedCount: 0,
            stickerNames: [],
            startsThreadId: i === 4 ? startsThreadId : null,
        };
    });
}
