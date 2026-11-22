import { csvField } from './results.js';

export const CHAT_COLUMNS = ['time', 'message_id', 'thread_id', 'thread', 'author_id', 'author', 'username', 'content', 'reply_to', 'attachments', 'edited'];

// Discord shows these messages as events rather than text.
const EVENTS = {
    6: 'pinned a message.',
    7: 'joined the server.',
    8: 'boosted the server.',
    9: 'boosted the server.',
    10: 'boosted the server.',
    11: 'boosted the server.',
    18: 'started a thread.',
};
const TEXT_TYPES = new Set([0, 19]);
const SNIPPET_LENGTH = 80;

// Reads a message list that pages from newest to oldest, such as a channel's history.
// fetchPage(before) gets up to pageSize items older than the item ID given, newest first.
// Returns every item, oldest first.
export async function readAllPages(fetchPage, { pageSize = 100, onPage = () => {} } = {}) {
    const items = [];
    let before;

    for (;;) {
        const page = await fetchPage(before);
        items.push(...page);
        onPage(items.length);

        if (page.length < pageSize) {
            return items.reverse();
        }

        before = page.at(-1).id;
    }
}

// Reads a list that says whether more pages are left, such as closed threads.
// fetchPage(before) answers { items, hasMore, next }, where next is what to pass for the page after.
export async function readAllThreadPages(fetchPage) {
    const items = [];
    let before;

    for (;;) {
        const { items: page, hasMore, next } = await fetchPage(before);
        items.push(...page);

        if (!hasMore || page.length === 0) {
            return items;
        }

        before = next;
    }
}

const snowflakeOrder = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

// Open and closed threads, each once, oldest first.
export function mergeThreads(...lists) {
    const byId = new Map(lists.flat().map((thread) => [thread.id, thread]));
    return [...byId.values()].sort(snowflakeOrder);
}

// Discord writes mentions as <@id>, <#id> and <@&id>. Shows them as names where known.
export function readableContent({ content, mentions = {} }, { channels = {}, roles = {} } = {}) {
    return String(content ?? '')
        .replace(/<@!?(\d+)>/g, (match, id) => (mentions[id] ? `@${mentions[id]}` : match))
        .replace(/<#(\d+)>/g, (match, id) => (channels[id] ? `#${channels[id]}` : match))
        .replace(/<@&(\d+)>/g, (match, id) => (roles[id] ? `@${roles[id]}` : match))
        .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

// The text to show for a message, including events like joins, which have no text of their own.
export function messageText(message, lookups) {
    const event = EVENTS[message.type];
    const text = readableContent(message, lookups);

    if (!TEXT_TYPES.has(message.type) && event && text === '') {
        return `${message.authorName} ${event}`;
    }

    const stickers = (message.stickerNames ?? []).map((name) => `[Sticker: ${name}]`);
    return [text, ...stickers].filter(Boolean).join('\n');
}

const allMessages = (chat) => [...chat.messages, ...chat.threads.flatMap(({ messages }) => messages)];

// Without the Message Content intent, Discord still sends every message but leaves out
// its text, attachments and embeds. That looks like a channel full of empty messages.
export function missingContentWarning(chat) {
    const typed = allMessages(chat).filter((message) => TEXT_TYPES.has(message.type));

    if (typed.length === 0) {
        return false;
    }

    const empty = typed.filter(({ content, attachments = [], embedCount = 0, stickerNames = [] }) => !content && attachments.length === 0 && embedCount === 0 && stickerNames.length === 0);
    return empty.length / typed.length >= 0.9;
}

export function messageCount(chat) {
    return allMessages(chat).length;
}

function csvLine(fields) {
    return `${fields.map(csvField).join(',')}\n`;
}

// One row per message: the channel first, then each thread. Names are chosen by members,
// so csvField protects spreadsheets from names and text that start like a formula.
export function chatCsv(chat, lookups) {
    const row = (message, thread) =>
        csvLine([
            message.time,
            message.id,
            thread?.id ?? '',
            thread?.name ?? '',
            message.authorId,
            message.authorName,
            message.authorUsername,
            messageText(message, lookups),
            message.replyTo?.id ?? '',
            (message.attachments ?? []).map(({ url }) => url).join(' '),
            message.editedTime ?? '',
        ]);

    return [csvLine(CHAT_COLUMNS), ...chat.messages.map((message) => row(message)), ...chat.threads.flatMap((thread) => thread.messages.map((message) => row(message, thread)))].join('');
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Only web links become clickable, so a message can't sneak in a javascript: link.
function safeUrl(url) {
    return /^https:\/\//i.test(url ?? '') ? url : null;
}

function linkify(text) {
    return escapeHtml(text).replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`);
}

const shortTime = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function snippet(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}...` : flat || 'a message';
}

function messageHtml(message, { lookups, threadNames, ids }) {
    const text = messageText(message, lookups);
    const isEvent = !TEXT_TYPES.has(message.type) && EVENTS[message.type];
    const reply = message.replyTo
        ? `<p class="reply">Replying to ${
              ids.has(message.replyTo.id)
                  ? `<a href="#m-${escapeHtml(message.replyTo.id)}">${escapeHtml(message.replyTo.authorName ?? 'a message')}</a>`
                  : escapeHtml(message.replyTo.authorName ?? 'a deleted message')
          }${message.replyTo.snippet ? `: ${escapeHtml(snippet(message.replyTo.snippet))}` : ''}</p>`
        : '';
    const attachments = (message.attachments ?? [])
        .map(({ name, url }) => {
            const href = safeUrl(url);
            return href ? `<li><a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(name)}</a></li>` : `<li>${escapeHtml(name)}</li>`;
        })
        .join('');
    const thread = message.startsThreadId && threadNames.has(message.startsThreadId) ? `<p class="thread-link"><a href="#t-${escapeHtml(message.startsThreadId)}">Thread: ${escapeHtml(threadNames.get(message.startsThreadId))}</a></p>` : '';
    const search = [message.authorName, message.authorUsername, text, ...(message.attachments ?? []).map(({ name }) => name)].join(' ').toLowerCase();

    return `<article class="msg${isEvent ? ' event' : ''}" id="m-${escapeHtml(message.id)}" data-search="${escapeHtml(search)}">
${reply}<header><strong class="author">${escapeHtml(message.authorName)}</strong> <span class="username">${escapeHtml(message.authorUsername)}</span>${message.isBot ? ' <span class="tag">Bot</span>' : ''} <time datetime="${escapeHtml(message.time)}">${escapeHtml(shortTime(message.time))}</time>${message.editedTime ? ' <span class="edited">(edited)</span>' : ''}</header>
${text ? `<div class="text">${linkify(text)}</div>` : ''}${attachments ? `<ul class="files">${attachments}</ul>` : ''}${message.embedCount ? `<p class="note">${message.embedCount === 1 ? '1 embed' : `${message.embedCount} embeds`} not shown</p>` : ''}${thread}
</article>`;
}

const STYLE = `
:root { color-scheme: light dark; --surface: #f3f1e8; --raised: #ffffff; --line: #d3cfbf; --ink: #151915; --muted: #545d53; --accent: #336a0e; --focus: #22460a; }
@media (prefers-color-scheme: dark) { :root { --surface: #0e120f; --raised: #171d18; --line: #2b352d; --ink: #ebe7d6; --muted: #a3ad9f; --accent: #9be84a; --focus: #9be84a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 1rem/1.5 system-ui, sans-serif; }
header.top { position: sticky; top: 0; background: var(--surface); border-bottom: 1px solid var(--line); padding: 1rem; }
@media (max-height: 40rem) { header.top { position: static; } }
h1, h2 { margin: 0 0 0.25rem; font-size: 1.25rem; }
h2 { font-size: 1.1rem; }
main { max-width: 60rem; margin: 0 auto; padding: 1rem; }
label { display: block; font-weight: 600; margin-top: 0.75rem; }
input { width: 100%; max-width: 30rem; padding: 0.5rem; font: inherit; color: inherit; background: var(--raised); border: 1px solid var(--muted); border-radius: 0.25rem; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
a { color: var(--accent); }
.meta, .username, time, .edited, .note, .reply { color: var(--muted); font-size: 0.875rem; }
.msg { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); background: var(--raised); }
.msg:target { outline: 2px solid var(--accent); }
.event { font-style: italic; }
.author { color: var(--accent); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.files { margin: 0.25rem 0 0; padding-left: 1.25rem; }
.tag { font-size: 0.75rem; border: 1px solid var(--muted); border-radius: 0.25rem; padding: 0 0.25rem; }
.reply, .thread-link, .note { margin: 0; }
section { margin-top: 1.5rem; }
section > h2 { padding: 0.5rem 0; }
.empty { color: var(--muted); }
`;

// Hides messages that don't match, and threads with nothing left to show.
const SCRIPT = `
const box = document.getElementById('search');
const count = document.getElementById('count');
const messages = [...document.querySelectorAll('.msg')];
box.addEventListener('input', () => {
    const words = box.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let shown = 0;
    for (const message of messages) {
        const match = words.every((word) => message.dataset.search.includes(word));
        message.hidden = !match;
        shown += match ? 1 : 0;
    }
    for (const section of document.querySelectorAll('section')) {
        section.hidden = words.length > 0 && !section.querySelector('.msg:not([hidden])');
    }
    count.textContent = words.length ? shown + ' of ' + messages.length + ' messages match' : messages.length + ' messages';
});
for (const time of document.querySelectorAll('time')) {
    time.textContent = new Date(time.dateTime).toLocaleString();
}
`;

// One file that opens in any browser, offline, with a search box.
export function chatHtml(chat, { serverName, exportedAt, lookups }) {
    const ids = new Set(allMessages(chat).map(({ id }) => id));
    const threadNames = new Map(chat.threads.map(({ id, name }) => [id, name]));
    const render = (messages) => (messages.length ? messages.map((message) => messageHtml(message, { lookups, threadNames, ids })).join('\n') : '<p class="empty">No messages.</p>');
    const title = `#${chat.channel.name}`;
    const total = messageCount(chat);
    const threads = chat.threads
        .map(
            (thread) => `<section id="t-${escapeHtml(thread.id)}" aria-labelledby="h-${escapeHtml(thread.id)}">
<h2 id="h-${escapeHtml(thread.id)}">Thread: ${escapeHtml(thread.name)}</h2>
${render(thread.messages)}
</section>`,
        )
        .join('\n');
    const main = chat.messages.length || chat.threads.length === 0 ? `<section aria-label="Channel messages">\n${render(chat.messages)}\n</section>` : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - ${escapeHtml(serverName)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(serverName)}. Saved ${escapeHtml(shortTime(exportedAt))} by Zombi Roles. Attachment links point to Discord and stop working after about a day.</p>
<label for="search">Search messages, names and file names</label>
<input id="search" type="search" autocomplete="off">
<p class="meta" id="count" role="status">${total} messages</p>
</header>
<main>
${main}
${threads}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
