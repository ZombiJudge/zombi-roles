import { randomBytes } from 'node:crypto';
import { autofillChoices } from '../core/autofill.js';
import { matchNames } from '../core/match.js';
import { parseNameList } from '../core/names.js';
import { buildPlan, memberLabel } from '../core/plan.js';
import { parseRoleInput } from '../core/role-input.js';
import { checkRoles } from '../core/roles.js';
import { cleanOperatorName } from '../panel/settings.js';
import { cancelledMessage, errorMessage, finishedMessage, handedOffMessage, pickerMessage, previewFile, previewMessage, privateNotice, progressMessage } from './messages.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
// Replies stop working at 15 minutes, so leave a margin.
const REPLY_WINDOW_MS = 14 * 60 * 1000;
const PROGRESS_EVERY_MS = 5000;
const MAX_OPERATOR_LENGTH = 80;
// Discord asks for suggestions on every keystroke, so this keeps a recent copy of the server.
const AUTOFILL_CACHE_MS = 60 * 1000;

const COMMAND_TYPE = 2;
const COMPONENT_TYPE = 3;
const AUTOCOMPLETE_TYPE = 4;
const REPLY = { MESSAGE: 4, DEFER_MESSAGE: 5, DEFER_UPDATE: 6, UPDATE: 7, AUTOCOMPLETE: 8 };
const EPHEMERAL = 64;
const OPTION = { STRING: 3, ATTACHMENT: 11 };
const PICKER_FIELDS = { members: 'memberIds', add: 'addRoleIds', remove: 'removeRoleIds' };

export const ROLEBATCH_COMMAND = {
    name: 'rolebatch',
    description: 'Add or remove roles for many members at once',
    contexts: [0],
    options: [
        { type: OPTION.ATTACHMENT, name: 'file', description: 'A .txt or .csv file of names' },
        { type: OPTION.STRING, name: 'names', description: 'Names separated by commas', autocomplete: true },
        { type: OPTION.STRING, name: 'add_roles', description: 'Roles to add, separated by commas', autocomplete: true },
        { type: OPTION.STRING, name: 'remove_roles', description: 'Roles to remove, separated by commas', autocomplete: true },
    ],
};

export class RoleBatchBot {
    constructor({ client, batches, getSettings, fetch = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now }) {
        this.client = client;
        this.batches = batches;
        this.getSettings = getSettings;
        this.fetch = fetch;
        this.sleep = sleep;
        this.now = now;
        this.pending = new Map();
        this.drafts = new Map();
    }

    allowed(interaction) {
        const { serverId, commandRoleId } = this.getSettings();

        return interaction.guild_id === serverId && commandRoleId !== '' && interaction.member?.roles.includes(commandRoleId);
    }

    async handle(interaction) {
        try {
            if (interaction.type === AUTOCOMPLETE_TYPE) {
                await this.autocomplete(interaction);
            } else if (!this.allowed(interaction)) {
                await this.client.respond(interaction, REPLY.MESSAGE, privateNotice('Not allowed', 'You need the role chosen in Zombi Roles settings to use this.'));
            } else if (interaction.type === COMMAND_TYPE && interaction.data.name === ROLEBATCH_COMMAND.name) {
                await this.command(interaction);
            } else if (interaction.type === COMPONENT_TYPE) {
                await this.component(interaction);
            }
        } catch {
            // The interaction may have expired or been answered by another copy of the bot.
        }
    }

    async autofillData() {
        if (!this.cache || this.now() >= this.cache.expires) {
            const [roles, bot, members] = await Promise.all([this.client.roles(), this.client.botMember(), this.client.members()]);
            const { manageable } = checkRoles(roles, bot.roleIds, this.getSettings().serverId);

            this.cache = { manageable, members, expires: this.now() + AUTOFILL_CACHE_MS };
        }

        return this.cache;
    }

    async autocomplete(interaction) {
        const focused = interaction.data.options?.find((option) => option.focused);
        let choices = [];

        if (focused && this.allowed(interaction)) {
            const { manageable, members } = await this.autofillData();
            const options =
                focused.name === 'names'
                    ? members.map((member) => ({ label: memberLabel(member), value: member.username, searchText: [member.username, member.nickname, member.globalName] }))
                    : manageable.map(({ name }) => ({ label: name, value: name, searchText: [name] }));

            choices = autofillChoices(String(focused.value), options);
        }

        await this.client.respond(interaction, REPLY.AUTOCOMPLETE, { choices });
    }

    async readNames(interaction, options) {
        const typed = parseNameList(String(options.names ?? '').replaceAll(',', '\n'));

        if (options.file === undefined) {
            return typed;
        }

        const { url, size, filename } = interaction.data.resolved.attachments[options.file];
        const format = filename.toLowerCase().endsWith('.csv') ? 'csv' : 'lines';

        if (!/\.(txt|csv)$/i.test(filename)) {
            throw new RangeError('The file must be a .txt or .csv file.');
        }

        if (size > MAX_FILE_BYTES || !FILE_HOSTS.has(new URL(url).hostname)) {
            throw new RangeError('That file could not be used. It may be too large.');
        }

        const response = await this.fetch(url);

        if (!response.ok) {
            throw new RangeError('That file could not be downloaded from Discord.');
        }

        return parseNameList([...typed, ...parseNameList(await response.text(), { format })].join('\n'));
    }

    async readInput(interaction) {
        const options = Object.fromEntries((interaction.data.options ?? []).map(({ name, value }) => [name, value]));
        const roles = await this.client.roles();
        const add = parseRoleInput(options.add_roles, roles);
        const remove = parseRoleInput(options.remove_roles, roles);
        const unknown = [...add.unknown, ...remove.unknown];

        if (unknown.length > 0) {
            throw new RangeError(`These roles do not exist: ${unknown.join(', ')}`);
        }

        return { names: await this.readNames(interaction, options), memberIds: [], addRoleIds: add.ids, removeRoleIds: remove.ids };
    }

    async makePlan({ names, memberIds, addRoleIds, removeRoleIds }) {
        const [roles, bot, members] = await Promise.all([this.client.roles(), this.client.botMember(), this.client.members()]);
        const { manageable, blocked } = checkRoles(roles, bot.roleIds, this.getSettings().serverId);
        const refused = blocked.filter(({ role }) => [...addRoleIds, ...removeRoleIds].includes(role.id));

        if (refused.length > 0) {
            throw new RangeError(`The bot cannot manage these roles: ${refused.map(({ role }) => role.name).join(', ')}`);
        }

        const { matched, unresolved, ambiguous } = matchNames(names, members);
        const chosen = new Map(matched.map(({ member }) => [member.id, member]));
        const picked = new Set(memberIds);

        for (const member of members) {
            if (picked.has(member.id)) {
                chosen.set(member.id, member);
            }
        }

        return buildPlan({
            members: [...chosen.values()],
            addRoleIds,
            removeRoleIds,
            unresolved,
            ambiguous,
            roleNames: Object.fromEntries(manageable.map(({ id, name }) => [id, name])),
        });
    }

    async showPreview(token, input, userId) {
        const plan = await this.makePlan(input);
        const id = randomBytes(8).toString('hex');

        this.pending.set(id, { plan, userId, expires: this.now() + REPLY_WINDOW_MS });
        await this.client.editReply(token, previewMessage(plan, id), [{ name: 'preview.txt', text: previewFile(plan) }]);
    }

    async command(interaction) {
        await this.client.respond(interaction, REPLY.DEFER_MESSAGE, { flags: EPHEMERAL });

        const userId = interaction.member.user.id;

        try {
            const input = await this.readInput(interaction);
            const hasRoles = input.addRoleIds.length > 0 || input.removeRoleIds.length > 0;

            if (input.names.length > 0 && hasRoles) {
                await this.showPreview(interaction.token, input, userId);
                return;
            }

            const id = randomBytes(8).toString('hex');

            this.drafts.set(id, { ...input, userId, expires: this.now() + REPLY_WINDOW_MS });
            await this.client.editReply(interaction.token, pickerMessage(id, input));
        } catch (error) {
            await this.client.editReply(interaction.token, errorMessage(error instanceof RangeError ? error.message : 'Something went wrong. Check the control panel.'));
        }
    }

    async draftAction(interaction, action, id) {
        const draft = this.drafts.get(id);

        if (draft.userId !== interaction.member.user.id || draft.expires < this.now()) {
            await this.client.respond(interaction, REPLY.MESSAGE, privateNotice('Out of date', 'Run /rolebatch again to start over.'));
            return;
        }

        if (action === 'cancel') {
            this.drafts.delete(id);
            await this.client.respond(interaction, REPLY.UPDATE, cancelledMessage());
            return;
        }

        if (action in PICKER_FIELDS) {
            draft[PICKER_FIELDS[action]] = interaction.data.values;
            await this.client.respond(interaction, REPLY.DEFER_UPDATE);
            return;
        }

        const missing = draft.names.length + draft.memberIds.length === 0 ? 'Pick at least one member.' : draft.addRoleIds.length + draft.removeRoleIds.length === 0 ? 'Pick at least one role to add or remove.' : null;

        if (missing) {
            await this.client.respond(interaction, REPLY.UPDATE, pickerMessage(id, draft, missing));
            return;
        }

        await this.client.respond(interaction, REPLY.DEFER_UPDATE);

        try {
            await this.showPreview(interaction.token, draft, draft.userId);
            this.drafts.delete(id);
        } catch (error) {
            await this.client.editReply(interaction.token, pickerMessage(id, draft, error instanceof RangeError ? error.message : 'Something went wrong. Check the control panel.'));
        }
    }

    async component(interaction) {
        const [, action, id] = interaction.data.custom_id.split(':');

        if (action === 'stop') {
            this.batches.stop();
            await this.client.respond(interaction, REPLY.DEFER_UPDATE);
            return;
        }

        if (this.drafts.has(id)) {
            await this.draftAction(interaction, action, id);
            return;
        }

        const pending = this.pending.get(id);
        const userId = interaction.member.user.id;

        if (!pending || pending.userId !== userId || pending.expires < this.now()) {
            await this.client.respond(interaction, REPLY.MESSAGE, privateNotice('Out of date', 'Run /rolebatch again to make a new preview.'));
            return;
        }

        this.pending.delete(id);

        if (action === 'cancel') {
            await this.client.respond(interaction, REPLY.UPDATE, cancelledMessage());
            return;
        }

        const { nick, user } = interaction.member;
        const operator = memberLabel({ nickname: nick ?? null, globalName: user.global_name ?? null, username: user.username });
        let batch;

        try {
            batch = this.batches.start({ changes: pending.plan.changes, operator: cleanOperatorName(operator, MAX_OPERATOR_LENGTH), client: this.client });
        } catch (error) {
            await this.client.respond(interaction, REPLY.UPDATE, errorMessage(error.message));
            return;
        }

        await this.client.respond(interaction, REPLY.UPDATE, progressMessage({ batch, done: 0, total: pending.plan.changes.length }));
        await this.follow(batch, interaction.token, userId);
    }

    // Keeps the Discord message current, then reports where it can: in the reply if it still
    // works, otherwise by direct message.
    async follow(batch, token, userId) {
        const started = this.now();
        let replyOpen = true;
        let status = this.batches.status();

        while (status.state === 'running' && status.batch === batch) {
            if (replyOpen && this.now() - started >= REPLY_WINDOW_MS) {
                replyOpen = false;
                await this.client.editReply(token, handedOffMessage(status)).catch(() => {});
            } else if (replyOpen) {
                await this.client.editReply(token, progressMessage(status)).catch(() => {});
            }

            await this.sleep(PROGRESS_EVERY_MS);
            status = this.batches.status();
        }

        const files = status.hasErrors ? this.errorFiles(batch, status) : [];

        if (replyOpen) {
            await this.client.editReply(token, finishedMessage(status), files).catch(() => {});
        } else {
            await this.client.sendDm(userId, finishedMessage(status), files).catch(() => {});
        }
    }

    errorFiles(batch, { report }) {
        return [
            { name: `batch-${batch}-error-report.txt`, text: report },
            { name: `batch-${batch}-errors.csv`, text: this.batches.errorCsv(batch) },
        ];
    }
}
