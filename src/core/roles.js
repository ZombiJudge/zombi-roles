// Discord ranks roles by position. On a tie, the older role (lower ID) ranks higher.
function ranksAbove(a, b) {
    if (a.position !== b.position) {
        return a.position > b.position;
    }

    return BigInt(a.id) < BigInt(b.id);
}

// Splits roles into those the bot can give or take away and those it can't, with the reason.
export function checkRoles(roles, botRoleIds, serverId) {
    const botRoles = roles.filter(({ id }) => botRoleIds.includes(id));
    const manageable = [];
    const blocked = [];

    for (const role of roles) {
        if (role.id === serverId) {
            continue;
        }

        if (role.managed) {
            blocked.push({ role, reason: 'Discord manages this role itself.' });
        } else if (botRoles.some((botRole) => ranksAbove(botRole, role))) {
            manageable.push(role);
        } else {
            blocked.push({ role, reason: "This role is above the bot's own role." });
        }
    }

    return { manageable, blocked };
}
