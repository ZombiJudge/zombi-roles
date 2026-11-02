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
