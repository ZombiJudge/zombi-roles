const OPPOSITE = { add: 'remove', remove: 'add' };

// Builds the reverse of a finished or stopped batch from its results, newest change first.
// Only changes that worked are reversed. Pass current members to leave out any change
// someone has already reversed by hand.
export function planUndo(rows, { members } = {}) {
    const membersById = new Map(members?.map((member) => [member.id, member]));
    const seen = new Set();
    const changes = [];
    const alreadySet = [];
    const missing = [];

    for (const row of rows.filter(({ result }) => result === 'ok').toReversed()) {
        const change = {
            memberId: row.memberId,
            memberName: row.memberName,
            action: OPPOSITE[row.action],
            roleId: row.roleId,
            roleName: row.roleName,
        };
        const key = `${change.memberId}:${change.roleId}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        if (!members) {
            changes.push(change);
            continue;
        }

        const member = membersById.get(change.memberId);

        if (!member) {
            missing.push(change);
        } else if (member.roleIds.includes(change.roleId) === (change.action === 'add')) {
            alreadySet.push(change);
        } else {
            changes.push(change);
        }
    }

    return { changes, alreadySet, missing };
}
