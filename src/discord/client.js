import { FatalBatchError, RateLimitError } from '../core/runner.js';

const API = 'https://discord.com/api/v10';
const PAGE_SIZE = 1000;

function toMember({ user, nick, roles }) {
    return {
        id: user.id,
        username: user.username,
        nickname: nick ?? null,
        globalName: user.global_name ?? null,
        roleIds: roles,
        isBot: user.bot === true,
    };
}

// Talks to Discord's REST API with built-in fetch, so it installs nothing and is easy to port.
export class DiscordClient {
    constructor({ token, serverId, fetch = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
        this.token = token;
        this.serverId = serverId;
        this.fetch = fetch;
        this.sleep = sleep;
    }

    async request(method, path, { body, form, reason } = {}) {
        const response = await this.fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bot ${this.token}`,
                'User-Agent': 'DiscordBot (https://zombi.dev, 0.1.0)',
                ...(body && { 'Content-Type': 'application/json' }),
                ...(reason && { 'X-Audit-Log-Reason': encodeURIComponent(reason) }),
            },
            body: form ?? (body && JSON.stringify(body)),
        });
        const data = await response.json().catch(() => null);

        if (response.status === 429) {
            throw new RateLimitError(data?.retry_after ?? 1);
        }

        if (response.status === 401) {
            throw new FatalBatchError('Discord rejected the bot token.');
        }

        if (!response.ok) {
            const error = new Error(data?.message ?? `Discord answered ${response.status}`);
            error.status = response.status;
            error.code = data?.code;
            throw error;
        }

        return data;
    }

    // For calls outside a batch, which have no runner to wait out rate limits for them.
    async patiently(call) {
        for (;;) {
            try {
                return await call();
            } catch (error) {
                if (!(error instanceof RateLimitError)) {
                    throw error;
                }

                await this.sleep(error.retryAfterSeconds * 1000);
            }
        }
    }

    gatewayUrl() {
        return this.patiently(() => this.request('GET', '/gateway/bot')).then(({ url }) => url);
    }

    async applicationId() {
        const { id } = await this.patiently(() => this.request('GET', '/oauth2/applications/@me'));
        return id;
    }

    async registerCommand(command) {
        const id = await this.applicationId();
        this.appId = id;
        return this.patiently(() => this.request('PUT', `/applications/${id}/guilds/${this.serverId}/commands`, { body: [command] }));
    }

    respond({ id, token }, type, data) {
        return this.request('POST', `/interactions/${id}/${token}/callback`, { body: { type, ...(data && { data }) } });
    }

    // Replies with files go as a form, as Discord requires.
    withFiles(payload, files) {
        const form = new FormData();

        form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map(({ name }, id) => ({ id, filename: name })) }));
        files.forEach(({ name, text }, index) => form.append(`files[${index}]`, new Blob([text], { type: 'text/plain' }), name));
        return form;
    }

    async editReply(token, payload, files = []) {
        const id = this.appId ?? (this.appId = await this.applicationId());
        const path = `/webhooks/${id}/${token}/messages/@original`;

        return this.patiently(() => this.request('PATCH', path, files.length ? { form: this.withFiles(payload, files) } : { body: payload }));
    }

    async sendDm(userId, payload, files = []) {
        const channel = await this.patiently(() => this.request('POST', '/users/@me/channels', { body: { recipient_id: userId } }));
        const path = `/channels/${channel.id}/messages`;

        return this.patiently(() => this.request('POST', path, files.length ? { form: this.withFiles(payload, files) } : { body: payload }));
    }

    server() {
        return this.patiently(() => this.request('GET', `/guilds/${this.serverId}`));
    }

    roles() {
        return this.patiently(() => this.request('GET', `/guilds/${this.serverId}/roles`));
    }

    async botMember() {
        const { id } = await this.patiently(() => this.request('GET', '/users/@me'));
        return toMember(await this.patiently(() => this.request('GET', `/guilds/${this.serverId}/members/${id}`)));
    }

    async members() {
        const members = [];
        let after = '0';

        for (;;) {
            const path = `/guilds/${this.serverId}/members?limit=${PAGE_SIZE}&after=${after}`;
            const page = await this.patiently(() => this.request('GET', path));
            members.push(...page.map(toMember));

            if (page.length < PAGE_SIZE) {
                return members;
            }

            after = page.at(-1).user.id;
        }
    }

    applyChange = ({ memberId, action, roleId }, reason) => {
        const method = action === 'add' ? 'PUT' : 'DELETE';
        return this.request(method, `/guilds/${this.serverId}/members/${memberId}/roles/${roleId}`, { reason });
    };

    // Experimental: not officially supported by Discord, so callers must expect this to fail.
    searchMembers(body) {
        return this.patiently(() => this.request('POST', `/guilds/${this.serverId}/members-search`, { body }));
    }

    // Reads every page. complete is false if a page brought nothing new, so the caller can warn.
    async memberIdsByInvite(code) {
        const ids = new Set();
        let after;

        for (;;) {
            const found = await this.searchMembers({
                limit: PAGE_SIZE,
                ...(after && { after }),
                and_query: { source_invite_code: { or_query: [code] } },
            });
            const countBefore = ids.size;
            found.members.forEach(({ member }) => ids.add(member.user.id));

            if (ids.size >= found.total_result_count) {
                return { ids: [...ids], complete: true };
            }

            if (ids.size === countBefore) {
                return { ids: [...ids], complete: false };
            }

            const last = found.members.at(-1).member;
            after = { user_id: last.user.id, guild_joined_at: Date.parse(last.joined_at) };
        }
    }
}
