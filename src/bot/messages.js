// Discord messages for /rolebatch. Colors are the zombi.dev dark theme tokens.
const COLOR = { ichor: 0x9be84a, amber: 0xf5b43c, wound: 0xff7a4d, signal: 0x7cc4ff };
const BUTTON = { secondary: 2, success: 3, danger: 4 };
const EPHEMERAL = 64;
const USER_SELECT = 5;
const ROLE_SELECT = 6;
const PICKER_LIMIT = 25;

const button = (label, style, customId) => ({ type: 2, label, style, custom_id: customId });
const row = (...components) => ({ type: 1, components });
const embed = (title, description, color = COLOR.signal, fields) => ({ title, description, color, ...(fields && { fields }) });
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const changeText = ({ action, roleName, memberName }) => `${action === 'add' ? 'Add' : 'Remove'} ${roleName} ${action === 'add' ? 'to' : 'from'} ${memberName}`;

export const privateNotice = (title, description) => ({
    embeds: [embed(title, description, COLOR.wound)],
    flags: EPHEMERAL,
});

export const errorMessage = (description) => ({
    embeds: [embed('Zombi Roles', description, COLOR.wound)],
    components: [],
});

// The whole dry run as a text file, because a Discord message can't hold hundreds of names.
export function previewFile({ changes, alreadySet, unresolved, ambiguous }) {
    const section = (title, lines) => (lines.length ? [`${title} (${lines.length})`, ...lines, ''] : []);

    return [
        ...section('Will change', changes.map(changeText)),
        ...section('Already set, skipped', alreadySet.map(changeText)),
        ...section('Unresolved, skipped', unresolved),
        ...section('Ambiguous, skipped', ambiguous.map(({ name, candidates }) => `${name}: ${candidates.map(({ username }) => username).join(', ')}`)),
    ].join('\n');
}

export function previewMessage(plan, pendingId) {
    const { matched, unresolved, ambiguous, alreadySet, willChange } = plan.counts;
    const fields = [
        ['Matched', matched],
        ['Unresolved', unresolved],
        ['Ambiguous', ambiguous],
        ['Already set', alreadySet],
        ['Will change', willChange],
    ].map(([name, value]) => ({ name, value: String(value), inline: true }));
    const lines = [willChange === 0 ? 'Everything is already set, so there is nothing to change. The attached file has the full list.' : 'Nothing has changed yet. The attached file has the full list.'];

    if (plan.tooLongForDiscordProgress) {
        lines.push('This is over about 900 changes, so Discord can only show progress for the first 15 minutes. You will get a direct message when it finishes, and the control panel shows progress the whole way.');
    }

    return {
        embeds: [embed('Preview', lines.join('\n\n'), plan.tooLongForDiscordProgress ? COLOR.amber : COLOR.signal, fields)],
        components: [
            row(
                ...(willChange > 0 ? [button(`Confirm ${plural(willChange, 'change')}`, BUTTON.success, `rolebatch:confirm:${pendingId}`)] : []),
                button(willChange > 0 ? 'Cancel' : 'Close', BUTTON.secondary, `rolebatch:cancel:${pendingId}`),
            ),
        ],
    };
}

// Discord's own picker menus, which stay open while several things are ticked. Each holds up to 25.
export function pickerMessage(id, { names, memberIds, addRoleIds, removeRoleIds }, notice) {
    const select = (type, placeholder, action, picked, kind) =>
        row({
            type,
            custom_id: `rolebatch:${action}:${id}`,
            placeholder,
            min_values: 0,
            max_values: PICKER_LIMIT,
            default_values: picked.map((value) => ({ id: value, type: kind })),
        });
    const description = names.length > 0 ? `${plural(names.length, 'name')} from the command, plus any members picked here.` : 'Pick up to 25 in each menu. For longer lists, use a file or the control panel.';

    return {
        embeds: [embed('Choose members and roles', notice ?? description, notice ? COLOR.wound : COLOR.signal)],
        components: [
            select(USER_SELECT, 'Members', 'members', memberIds, 'user'),
            select(ROLE_SELECT, 'Roles to add', 'add', addRoleIds, 'role'),
            select(ROLE_SELECT, 'Roles to remove', 'remove', removeRoleIds, 'role'),
            row(button('See preview', BUTTON.success, `rolebatch:preview:${id}`), button('Cancel', BUTTON.secondary, `rolebatch:cancel:${id}`)),
        ],
        attachments: [],
    };
}

export const cancelledMessage = () => ({ embeds: [embed('Cancelled', 'Nothing was changed.')], components: [] });

export const progressMessage = ({ batch, done, total }) => ({
    embeds: [embed(`Batch ${batch}`, `${done} of ${plural(total, 'change')} done.`)],
    components: [row(button('Stop', BUTTON.danger, 'rolebatch:stop'))],
});

export const handedOffMessage = ({ batch, done, total }) => ({
    embeds: [embed(`Batch ${batch}`, `${done} of ${plural(total, 'change')} done. Discord only allows updates here for 15 minutes, so you will get a direct message when it finishes. The control panel still shows live progress.`)],
    components: [],
});

export function finishedMessage({ batch, result, ok, failed, error }) {
    const headline = { finished: 'Finished', stopped: 'Stopped', failed: 'Ended early' }[result];
    const lines = [`${ok} worked, ${failed} did not.`];

    if (error) {
        lines.push(error);
    }

    if (result !== 'finished') {
        lines.push('Resume it from Past batches in the control panel.');
    }

    return {
        embeds: [embed(`Batch ${batch}: ${headline}`, lines.join('\n\n'), failed > 0 || result === 'failed' ? COLOR.amber : COLOR.ichor)],
        components: [],
    };
}
