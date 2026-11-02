const RECONNECT_DELAY_MS = 5000;
// Discord closes with these when retrying can't help, such as a wrong token.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

// The always-open connection Discord uses to deliver slash commands to a local bot.
// It uses Node's built-in WebSocket, so the app installs nothing. Intents are 0 because
// interactions arrive without any.
export class Gateway {
    constructor({ token, getUrl, onInteraction, onFatal = () => {}, WebSocketClass = globalThis.WebSocket, reconnectDelayMs = RECONNECT_DELAY_MS }) {
        this.token = token;
        this.getUrl = getUrl;
        this.onInteraction = onInteraction;
        this.onFatal = onFatal;
        this.WebSocketClass = WebSocketClass;
        this.reconnectDelayMs = reconnectDelayMs;
        this.sequence = null;
        this.stopped = false;
    }

    async start() {
        try {
            const url = await this.getUrl();
            this.socket = new this.WebSocketClass(`${url}/?v=10&encoding=json`);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.socket.onmessage = ({ data }) => this.handle(JSON.parse(data));
        this.socket.onclose = ({ code }) => this.closed(code);
        this.socket.onerror = () => {};
    }

    stop() {
        this.stopped = true;
        clearInterval(this.heartbeat);
        clearTimeout(this.retry);
        this.socket?.close();
    }

    send(op, d) {
        this.socket.send(JSON.stringify({ op, d }));
    }

    handle({ op, d, s, t }) {
        if (s !== null && s !== undefined) {
            this.sequence = s;
        }

        if (op === OP.HELLO) {
            this.beginHeartbeat(d.heartbeat_interval);
            this.send(OP.IDENTIFY, { token: this.token, intents: 0, properties: { os: process.platform, browser: 'zombi-roles', device: 'zombi-roles' } });
        } else if (op === OP.HEARTBEAT) {
            this.send(OP.HEARTBEAT, this.sequence);
        } else if (op === OP.HEARTBEAT_ACK) {
            this.acknowledged = true;
        } else if (op === OP.RECONNECT || op === OP.INVALID_SESSION) {
            this.socket.close();
        } else if (op === OP.DISPATCH && t === 'INTERACTION_CREATE') {
            this.onInteraction(d);
        }
    }

    beginHeartbeat(intervalMs) {
        clearInterval(this.heartbeat);
        this.acknowledged = true;
        this.heartbeat = setInterval(() => {
            if (!this.acknowledged) {
                this.socket.close();
                return;
            }

            this.acknowledged = false;
            this.send(OP.HEARTBEAT, this.sequence);
        }, intervalMs);
    }

    closed(code) {
        clearInterval(this.heartbeat);

        if (this.stopped) {
            return;
        }

        if (FATAL_CLOSE_CODES.has(code)) {
            this.onFatal(code);
            return;
        }

        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (!this.stopped) {
            this.retry = setTimeout(() => this.start(), this.reconnectDelayMs);
        }
    }
}
