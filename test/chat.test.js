import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCsv, chatHtml, mergeThreads, messageText, missingContentWarning, readAllPages, readAllThreadPages, readableContent } from '../src/core/chat.js';
import { makeMessages } from './helpers/fake-discord.js';

const message = (fields) => ({ ...makeMessages(1)[0], type: 0, editedTime: null, replyTo: null, attachments: [], mentions: {}, ...fields });
const chat = (messages, threads = []) => ({ channel: { id: '9', name: 'general' }, messages, threads });
const lookups = { channels: { 77: 'rules' }, roles: { 88: 'Judges' } };
const html = (value) => chatHtml(value, { serverName: 'Test', exportedAt: '2026-11-21T10:00:00.000Z', lookups });

test('reads pages backwards until a short page, and returns them oldest first', async () => {
    const pages = [
        [{ id: '6' }, { id: '5' }],
        [{ id: '4' }, { id: '3' }],
        [{ id: '2' }],
    ];
    const asked = [];
    const counts = [];
    const items = await readAllPages(
        async (before) => {
            asked.push(before);
            return pages.shift();
        },
        { pageSize: 2, onPage: (count) => counts.push(count) },
    );

    assert.deepEqual(asked, [undefined, '5', '3']);
    assert.deepEqual(items.map(({ id }) => id), ['2', '3', '4', '5', '6']);
    assert.deepEqual(counts, [2, 4, 5]);
});

test('an empty channel needs one page', async () => {
    let calls = 0;
    assert.deepEqual(await readAllPages(async () => (calls++, [])), []);
    assert.equal(calls, 1);
});

test('reads thread pages until Discord says there are no more', async () => {
    const pages = [
        { items: [{ id: '1' }], hasMore: true, next: '2026-01-02' },
        { items: [{ id: '2' }], hasMore: false },
    ];
    const asked = [];
    const items = await readAllThreadPages(async (before) => {
        asked.push(before);
        return pages.shift();
    });

    assert.deepEqual(asked, [undefined, '2026-01-02']);
    assert.deepEqual(items.map(({ id }) => id), ['1', '2']);
});

test('lists each thread once, oldest first, even past the size of a normal number', () => {
    const threads = mergeThreads([{ id: '1200000000000000002', name: 'b' }], [{ id: '1200000000000000001', name: 'a' }, { id: '1200000000000000002', name: 'b' }]);
    assert.deepEqual(threads.map(({ name }) => name), ['a', 'b']);
});

test('shows mentions as names and keeps unknown ones as they are', () => {
    const text = readableContent({ content: 'Hi <@5> and <@!6>, see <#77> and <@&88>, not <@9> <:zombi:123>', mentions: { 5: 'Sam', 6: 'Alex' } }, lookups);
    assert.equal(text, 'Hi @Sam and @Alex, see #rules and @Judges, not <@9> :zombi:');
});

test('writes events such as joins as text', () => {
    assert.equal(messageText(message({ type: 7, content: '', authorName: 'Fern' })), 'Fern joined the server.');
    assert.equal(messageText(message({ content: 'gg', stickerNames: ['Zombi'] })), 'gg\n[Sticker: Zombi]');
});

test('warns when text is missing, as it is without the Message Content intent', () => {
    const empty = Array.from({ length: 10 }, () => message({ content: '' }));

    assert.equal(missingContentWarning(chat(empty)), true);
    assert.equal(missingContentWarning(chat(empty.slice(0, 8), [{ id: '1', name: 't', messages: [message({ content: 'hi' }), message({ content: 'yo' })] }])), false);
    assert.equal(missingContentWarning(chat([message({ content: '', attachments: [{ name: 'a.png', url: 'https://x' }] })])), false);
    assert.equal(missingContentWarning(chat([])), false);
});

test('CSV has one row per message, with thread columns and formula protection', () => {
    const value = chat(
        [message({ id: '1', authorName: '=HYPERLINK("x")', content: '+1 for this', attachments: [{ name: 'a.png', url: 'https://cdn/a.png' }], editedTime: '2026-10-01T18:01:00.000Z' })],
        [{ id: '50', name: '@thread', messages: [message({ id: '2', replyTo: { id: '1' }, content: 'line one\nline two' })] }],
    );
    const lines = chatCsv(value, lookups).split('\n');

    assert.equal(lines[0], 'time,message_id,thread_id,thread,author_id,author,username,content,reply_to,attachments,edited');
    assert.match(lines[1], /,1,,,/);
    assert.match(lines[1], /,"'=HYPERLINK\(""x""\)",/);
    assert.match(lines[1], /,'\+1 for this,/);
    assert.match(lines[1], /,https:\/\/cdn\/a\.png,2026-10-01T18:01:00\.000Z$/);
    assert.match(lines[2], /,2,50,'@thread,/);
    assert.match(chatCsv(value, lookups), /"line one\nline two",1,/);
});

test('HTML escapes everything members write', () => {
    const page = html(chat([message({ authorName: '<img src=x onerror=alert(1)>', content: '<script>alert(1)</script> "quoted"', attachments: [{ name: '<b>.png', url: 'javascript:alert(1)' }] })]));

    assert.ok(!page.includes('<img src=x'));
    assert.ok(!page.includes('<script>alert'));
    assert.ok(!page.includes('href="javascript:'));
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;quoted&quot;/);
    assert.match(page, /<li>&lt;b&gt;\.png<\/li>/);
});

test('HTML has a search box, replies, links and thread sections', () => {
    const page = html(
        chat(
            [message({ id: '1', authorName: 'Sam', content: 'See https://zombi.dev/rules', startsThreadId: '50' }), message({ id: '2', type: 19, replyTo: { id: '1', authorName: 'Sam', snippet: 'See the rules' }, content: 'ok' })],
            [{ id: '50', name: 'Side events', messages: [message({ id: '3', content: 'in a thread' })] }],
        ),
    );

    assert.match(page, /<input id="search" type="search"/);
    assert.match(page, /<label for="search">/);
    assert.match(page, /Replying to <a href="#m-1">Sam<\/a>: See the rules/);
    assert.match(page, /<a href="https:\/\/zombi\.dev\/rules" rel="noopener noreferrer">/);
    assert.match(page, /<a href="#t-50">Thread: Side events<\/a>/);
    assert.match(page, /<section id="t-50"[^>]*>\n<h2 id="h-50">Thread: Side events<\/h2>/);
    assert.match(page, /3 messages/);
    assert.match(page, /data-search="[^"]*in a thread/);
});

test('a forum has no channel section, only its posts', () => {
    const page = html(chat([], [{ id: '50', name: 'Post', messages: [message({ id: '3' })] }]));
    assert.ok(!page.includes('aria-label="Channel messages"'));
});
