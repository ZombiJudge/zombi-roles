// Runs the panel with 900 made-up members to check the design. It never contacts Discord
// and ignores the real settings. npm run demo
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from '../src/panel/server.js';
import { saveSettings } from '../src/panel/settings.js';
import { FakeServer } from '../test/helpers/fake-discord.js';

const PORT = 4647;
const MEMBER_COUNT = 900;
const DATA_DIR = join('data', 'demo');
const SERVER_ID = '100000';
const FAKE_NAMES = ['Ash', 'Bones', 'Cass', 'Dusk', 'Ember', 'Fern', 'Grim', 'Hollow', 'Ivy', 'Jinx', 'Kit', 'Lark', 'Moss', 'Nyx', 'Onyx', 'Pike', 'Quill', 'Rook', 'Sage', 'Thorn'];
const ROLES = [
    { id: SERVER_ID, name: '@everyone', position: 0, managed: false },
    { id: '200001', name: 'Newcomer', position: 1, managed: false },
    { id: '200002', name: 'Regular', position: 2, managed: false },
    { id: '200003', name: 'Event Team', position: 3, managed: false },
    { id: '200004', name: 'Beta Tester', position: 4, managed: false },
    { id: '200005', name: 'A Very Long Role Name To Check How Wrapping Looks', position: 5, managed: false },
    { id: '200006', name: 'Zombi Roles', position: 6, managed: true },
    { id: '200007', name: 'Moderator', position: 7, managed: false },
];

function fakeMember(i) {
    const name = FAKE_NAMES[i % FAKE_NAMES.length];

    return {
        id: String(300000 + i),
        username: `${name.toLowerCase()}_${i}`,
        nickname: i % 3 === 0 ? name : null,
        globalName: i % 3 === 1 ? `${name} the ${FAKE_NAMES[(i * 7) % FAKE_NAMES.length]}` : null,
        roleIds: i % 4 === 0 ? ['200001'] : [],
        isBot: i % 50 === 0,
    };
}

const members = Array.from({ length: MEMBER_COUNT }, (_, i) => fakeMember(i));
const server = new FakeServer(members, { failIds: [members[11].id, members[12].id] });
const client = {
    applyChange: server.applyChange,
    server: async () => ({ name: 'Demo server, 900 fake members' }),
    roles: async () => ROLES,
    botMember: async () => ({ roleIds: ['200006'] }),
    members: async () => server.snapshot(),
    memberIdsByInvite: async () => ({ ids: members.filter((_, i) => i % 7 === 0).map(({ id }) => id), complete: true }),
};

rmSync(DATA_DIR, { recursive: true, force: true });
saveSettings(DATA_DIR, { token: 'demo', serverId: SERVER_ID, operatorName: 'Demo', retentionDays: 30 });

const panel = createPanel({ dataDir: DATA_DIR, createClient: () => client, delayMs: 100, port: PORT, onShutdown: () => process.exit(0) });

await panel.listen();
console.log(`Demo panel with fake members is running at http://127.0.0.1:${PORT}`);
