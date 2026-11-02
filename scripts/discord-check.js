// Developer check against a test server. Reads only, unless run with --write.
// npm run check:discord
// npm run check:discord -- --write
// npm run check:discord -- --invite=CODE
import { matchNames } from '../src/core/match.js';
import { buildPlan } from '../src/core/plan.js';
import { checkRoles } from '../src/core/roles.js';
import { auditReason, runBatch } from '../src/core/runner.js';
import { planUndo } from '../src/core/undo.js';
import { DiscordClient } from '../src/discord/client.js';

process.loadEnvFile('data/.env');

const client = new DiscordClient({ token: process.env.DISCORD_TOKEN, serverId: process.env.DISCORD_SERVER_ID });
const [server, roles, bot, members] = await Promise.all([client.server(), client.roles(), client.botMember(), client.members()]);
const { manageable, blocked } = checkRoles(roles, bot.roleIds, client.serverId);

console.log(`Server: ${server.name}`);
console.log(`Bot: ${bot.username}`);
console.log(`Members: ${members.length} (${members.filter(({ isBot }) => isBot).length} bots)`);
console.log(`Roles the bot can manage: ${manageable.map(({ name }) => name).join(', ')}`);
console.log(`Roles it can't: ${blocked.map(({ role, reason }) => `${role.name} (${reason})`).join(', ')}`);

const inviteCode = process.argv.find((arg) => arg.startsWith('--invite='))?.slice('--invite='.length);

try {
    const { ids, complete } = await client.memberIdsByInvite(inviteCode ?? 'not-a-real-code');
    const names = ids.map((id) => members.find((member) => member.id === id)?.username);
    console.log(`Invite search worked: ${ids.length} found${complete ? '' : ' (incomplete)'} ${names.join(', ')}`);
} catch (error) {
    console.log(`Invite search failed: ${error.status ?? ''} ${error.code ?? ''} ${error.message}`);
}

const matches = matchNames(['Zombi Test Member 3', 'Twin', 'nobody here'], members);
console.log(`Matched: ${matches.matched.map(({ member, matchedBy }) => `${member.username} by ${matchedBy}`).join(', ')}`);
console.log(`Ambiguous: ${matches.ambiguous.map(({ name, candidates }) => `${name} (${candidates.length})`).join(', ')}`);
console.log(`Unresolved: ${matches.unresolved.join(', ')}`);

if (process.argv.includes('--write')) {
    const alpha = roles.find(({ name }) => name === 'Test Alpha');
    const gamma = roles.find(({ name }) => name === 'Test Gamma');
    const plan = buildPlan({
        members: matches.matched.map(({ member }) => member),
        addRoleIds: [alpha.id, gamma.id],
        roleNames: { [alpha.id]: alpha.name, [gamma.id]: gamma.name },
    });
    const results = [];
    const applied = await runBatch({
        changes: plan.changes,
        applyChange: client.applyChange,
        reason: auditReason(0, 'Alex'),
        onResult: (row) => results.push(row),
    });

    for (const { memberName, roleName, result, detail } of results) {
        console.log(`Applied: ${memberName} ${roleName}: ${result} ${detail}`);
    }

    console.log(`Batch: ${applied.status}, ${applied.ok} worked, ${applied.failed} failed`);

    const undo = planUndo(results, { members: await client.members() });
    const undone = await runBatch({ changes: undo.changes, applyChange: client.applyChange, reason: auditReason(0, 'Alex') });
    console.log(`Undo: ${undone.status}, ${undone.ok} worked, ${undone.failed} failed`);
}
