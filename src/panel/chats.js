import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatCsv, chatHtml, mergeThreads, messageCount, missingContentWarning } from '../core/chat.js';
import { FatalBatchError } from '../core/runner.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTER_FILE = 'last-chat.txt';

function failureMessage(error) {
    if (error instanceof FatalBatchError) {
        return 'Discord rejected the bot token. Check it in Settings.';
    }

    if (error.status === 403 || error.status === 404) {
        return 'The bot cannot read this channel. In Discord, give the bot View Channel and Read Message History there.';
    }

    return `The chat could not be saved: ${error.message}`;
}

// Saves a channel's whole history as HTML and CSV, one channel at a time. The files are
// personal data, so they live in the data folder and go in the same cleanup as batch files.
export class ChatExports {
    constructor({ dataDir }) {
        this.folder = join(dataDir, 'chats');
        this.active = null;
        this.finished = null;
    }

    path(number, extension) {
        return join(this.folder, `chat-${number}.${extension}`);
    }

    numbers() {
        if (!existsSync(this.folder)) {
            return [];
        }

        return readdirSync(this.folder)
            .map((file) => /^chat-(\d+)\.json$/.exec(file)?.[1])
            .filter(Boolean)
            .map(Number)
            .sort((a, b) => b - a);
    }

    list() {
        return this.numbers().map((number) => JSON.parse(readFileSync(this.path(number, 'json'), 'utf8')));
    }

    status() {
        const current = this.active ?? this.finished;

        if (!current) {
            return { state: 'idle' };
        }

        return { state: this.active ? 'running' : 'finished', ...current };
    }

    // Kept apart from the chat files, so a number is never reused after cleanup.
    nextNumber() {
        const counter = join(this.folder, COUNTER_FILE);
        const last = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0;
        const number = Math.max(this.numbers()[0] ?? 0, last) + 1;

        writeFileSync(counter, String(number));
        return number;
    }

    start({ client, channel, serverName, lookups }) {
        if (this.active) {
            throw new RangeError('A chat download is already running. Wait for it to finish.');
        }

        mkdirSync(this.folder, { recursive: true });

        const number = this.nextNumber();
        const current = { number, channelName: channel.name, read: 0, threadsDone: 0, threadsTotal: 0 };

        this.active = current;
        this.running = this.read(client, channel, current)
            .then((chat) => this.save(chat, { number, serverName, lookups }))
            .then((meta) => {
                this.finished = { ...current, ...meta, result: 'done' };
            })
            .catch((error) => {
                this.finished = { ...current, result: 'failed', error: failureMessage(error) };
            })
            .finally(() => {
                this.active = null;
            });

        return number;
    }

    async read(client, channel, current) {
        const messages = channel.isForum ? [] : await client.messages(channel.id, (count) => (current.read = count));
        const found = channel.hasThreads ? await client.threads(channel) : { threads: [], privateSkipped: false };
        const list = mergeThreads(found.threads);
        const threads = [];
        let skippedThreads = 0;

        current.threadsTotal = list.length;

        for (const thread of list) {
            try {
                const before = current.read;
                threads.push({ ...thread, messages: await client.messages(thread.id, (count) => (current.read = before + count)) });
            } catch (error) {
                if (error.status !== 403) {
                    throw error;
                }

                skippedThreads++;
            }

            current.threadsDone++;
        }

        return { channel, messages, threads, privateSkipped: found.privateSkipped, skippedThreads };
    }

    save(chat, { number, serverName, lookups }) {
        const exportedAt = new Date().toISOString();
        const meta = {
            number,
            channelId: chat.channel.id,
            channelName: chat.channel.name,
            createdAt: exportedAt,
            messages: messageCount(chat),
            threads: chat.threads.length,
            privateSkipped: chat.privateSkipped,
            skippedThreads: chat.skippedThreads,
            missingContent: missingContentWarning(chat),
        };

        writeFileSync(this.path(number, 'html'), chatHtml(chat, { serverName, exportedAt, lookups }));
        writeFileSync(this.path(number, 'csv'), chatCsv(chat, lookups));
        writeFileSync(this.path(number, 'json'), JSON.stringify(meta));
        return meta;
    }

    file(number, extension) {
        return readFileSync(this.path(number, extension), 'utf8');
    }

    // Same rule as batches: files older than the set number of days are deleted.
    deleteOlderThan(days, now = Date.now()) {
        if (!existsSync(this.folder)) {
            return 0;
        }

        const cutoff = now - days * DAY_MS;
        const newest = new Map();

        for (const file of readdirSync(this.folder)) {
            const number = /^chat-(\d+)\./.exec(file)?.[1];

            if (number) {
                const entry = newest.get(number) ?? { files: [], time: 0 };
                entry.files.push(file);
                entry.time = Math.max(entry.time, statSync(join(this.folder, file)).mtimeMs);
                newest.set(number, entry);
            }
        }

        let deleted = 0;

        for (const [number, { files, time }] of newest) {
            if (time < cutoff && this.active?.number !== Number(number)) {
                files.forEach((file) => rmSync(join(this.folder, file), { force: true }));
                deleted++;
            }
        }

        if (this.finished && !existsSync(this.path(this.finished.number, 'json'))) {
            this.finished = null;
        }

        return deleted;
    }
}
