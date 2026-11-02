// Discord lets a slash command update its reply for 15 minutes, about 900 changes at 1 per second.
export const DISCORD_PROGRESS_LIMIT = 900;

// Includes the username, which is unique, because two members can share a nickname.
export function memberLabel(member) {
    const name = member.nickname ?? member.globalName;
    return name && name !== member.username ? `${name} (${member.username})` : member.username;
}

// Works out what a batch would do without changing anything.
export function buildPlan({ members, addRoleIds = [], removeRoleIds = [], unresolved = [], ambiguous = [], roleNames = {} }) {
    const inBoth = addRoleIds.filter((roleId) => removeRoleIds.includes(roleId));

    if (inBoth.length > 0) {
        throw new RangeError('A role cannot be added and removed in the same batch.');
    }

    if (addRoleIds.length === 0 && removeRoleIds.length === 0) {
        throw new RangeError('Choose at least one role to add or remove.');
    }

    const actions = [
        ...addRoleIds.map((roleId) => ({ action: 'add', roleId })),
        ...removeRoleIds.map((roleId) => ({ action: 'remove', roleId })),
    ];
    const changes = [];
    const alreadySet = [];

    for (const member of members) {
        for (const { action, roleId } of actions) {
            const item = {
                memberId: member.id,
                memberName: memberLabel(member),
                action,
                roleId,
                roleName: roleNames[roleId] ?? roleId,
            };
            const hasRole = member.roleIds.includes(roleId);

            (hasRole === (action === 'add') ? alreadySet : changes).push(item);
        }
    }

    return {
        changes,
        alreadySet,
        unresolved,
        ambiguous,
        counts: {
            matched: members.length,
            unresolved: unresolved.length,
            ambiguous: ambiguous.length,
            alreadySet: alreadySet.length,
            willChange: changes.length,
        },
        tooLongForDiscordProgress: changes.length > DISCORD_PROGRESS_LIMIT,
    };
}
