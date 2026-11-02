import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autofillChoices } from '../src/core/autofill.js';
import { parseRoleInput } from '../src/core/role-input.js';
import { Gateway } from '../src/discord/gateway.js';

class FakeSocket {
    static last;

    constructor(url) {
        this.url = url;
        this.sent = [];
        FakeSocket.last = this;
    }

    send(text) {
        this.sent.push(JSON.parse(text));
    }

    close() {
        this.closedByUs = true;
    }

    receive(message) {
        this.onmessage({ data: JSON.stringify(message) });
    }
}

const start = async (options = {}) => {
    const gateway = new Gateway({ token: 'secret', getUrl: async () => 'wss://fake', onInteraction: () => {}, WebSocketClass: FakeSocket, reconnectDelayMs: 1, ...options });
    await gateway.start();
    return { gateway, socket: FakeSocket.last };
};

test('connects with no intents and sends the token only to identify', async () => {
    const { gateway, socket } = await start();

    socket.receive({ op: 10, d: { heartbeat_interval: 60000 } });
    gateway.stop();

    assert.match(socket.url, /v=10/);
    assert.equal(socket.sent[0].op, 2);
    assert.equal(socket.sent[0].d.intents, 0);
    assert.equal(socket.sent[0].d.token, 'secret');
});

test('passes on interactions and ignores other events', async () => {
    const received = [];
    const { gateway, socket } = await start({ onInteraction: (interaction) => received.push(interaction) });

    socket.receive({ op: 0, s: 1, t: 'GUILD_CREATE', d: {} });
    socket.receive({ op: 0, s: 2, t: 'INTERACTION_CREATE', d: { id: '9' } });
    gateway.stop();

    assert.deepEqual(received, [{ id: '9' }]);
    assert.equal(gateway.sequence, 2);
});

test('reconnects after a drop but not after a fatal close', async () => {
    const fatal = [];
    const { gateway, socket } = await start({ onFatal: (code) => fatal.push(code) });

    socket.onclose({ code: 1006 });
    await new Promise((done) => setTimeout(done, 20));
    assert.notEqual(FakeSocket.last, socket);

    const second = FakeSocket.last;
    second.onclose({ code: 4004 });
    await new Promise((done) => setTimeout(done, 20));
    gateway.stop();

    assert.equal(FakeSocket.last, second);
    assert.deepEqual(fatal, [4004]);
});

test('reads role mentions and names, and reports unknown ones', () => {
    const roles = [{ id: '11', name: 'Helper' }, { id: '22', name: 'Event Team' }];

    assert.deepEqual(parseRoleInput('<@&11>, event team, @Ghost', roles), { ids: ['11', '22'], unknown: ['Ghost'] });
    assert.deepEqual(parseRoleInput('<@&11> <@&22>', roles), { ids: ['11', '22'], unknown: [] });
    assert.deepEqual(parseRoleInput(undefined, roles), { ids: [], unknown: [] });
});

test('autofill finishes the last entry and keeps the earlier ones', () => {
    const options = ['Alpha', 'Beta', 'Bravo'].map((name) => ({ label: name, value: name, searchText: [name] }));

    assert.deepEqual(autofillChoices('Alpha, b', options).map(({ value }) => value), ['Alpha, Beta', 'Alpha, Bravo']);
    assert.deepEqual(autofillChoices('br', options).map(({ value }) => value), ['Bravo']);
    assert.deepEqual(autofillChoices('Alpha, ', options).map(({ value }) => value), ['Alpha, Beta', 'Alpha, Bravo']);
});

test('autofill stops at Discord limits', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `Role ${i}`, value: `Role ${i}`, searchText: [`Role ${i}`] }));

    assert.equal(autofillChoices('', many).length, 25);
    assert.deepEqual(autofillChoices(`${'x'.repeat(98)}, r`, many), []);
});
