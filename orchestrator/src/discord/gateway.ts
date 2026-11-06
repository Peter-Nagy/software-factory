/**
 * Discord gateway connection (v10, JSON) using Node's built-in WebSocket: hello, heartbeat, identify,
 * resume after drops, re-identify when the session is invalid. Events are handed to `onDispatch`.
 */

export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15, // privileged: enable "Message Content Intent" in the developer portal
};
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** Close codes after which reconnecting can't help (bad token, intents not allowed). */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

interface Payload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export interface GatewayOptions {
  token: string;
  intents: number;
  onDispatch: (event: string, data: unknown) => void;
  onFatal?: (reason: string) => void;
  log?: (msg: string) => void;
  socketFactory?: SocketFactory;
  /** Delay before reconnecting (ms); tests set 0. */
  reconnectDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class Gateway {
  private ws: SocketLike | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: unknown = null;
  private acked = true;
  private stopped = false;
  private readonly o: Required<Omit<GatewayOptions, 'onFatal'>> & Pick<GatewayOptions, 'onFatal'>;

  constructor(opts: GatewayOptions) {
    this.o = {
      log: () => undefined,
      socketFactory: (url) => new WebSocket(url) as unknown as SocketLike,
      reconnectDelayMs: 2000,
      setTimer: (fn, ms) => setInterval(fn, ms),
      clearTimer: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      ...opts,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.ws?.close(1000);
  }

  get canResume(): boolean {
    return this.sessionId !== null && this.seq !== null;
  }

  private connect(resume: boolean): void {
    const url = resume && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;
    const ws = this.o.socketFactory(url);
    this.ws = ws;
    ws.onmessage = (ev) => this.handle(JSON.parse(String(ev.data)) as Payload, resume);
    ws.onerror = () => this.o.log('gateway socket error');
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // an old socket we already replaced
      this.stopHeartbeat();
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(ev.code)) {
        this.stopped = true;
        this.o.onFatal?.(`Discord closed the connection with code ${ev.code} ${ev.reason ?? ''}`.trim());
        return;
      }
      this.o.log(`gateway closed (${ev.code}); reconnecting`);
      setTimeout(() => this.connect(this.canResume), this.o.reconnectDelayMs);
    };
  }

  private send(p: Payload): void {
    this.ws?.send(JSON.stringify(p));
  }

  private handle(p: Payload, resume: boolean): void {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: {
        // Hello: start heartbeating, then identify or resume.
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        this.acked = true;
        this.heartbeat = this.o.setTimer(() => this.beat(), interval);
        if (resume && this.canResume) {
          this.send({ op: 6, d: { token: this.o.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.send({ op: 2, d: { token: this.o.token, intents: this.o.intents, properties: { os: 'darwin', browser: 'software-factory', device: 'software-factory' } } });
        }
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.send({ op: 1, d: this.seq });
        return;
      case 7: // server asks us to reconnect
        this.reconnect(true);
        return;
      case 9: // invalid session; d = whether it can be resumed
        if (!p.d) {
          this.sessionId = null;
          this.seq = null;
        }
        this.reconnect(Boolean(p.d));
        return;
      case 0: {
        if (p.t === 'READY') {
          const d = p.d as { session_id: string; resume_gateway_url: string };
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url;
        }
        if (p.t) this.o.onDispatch(p.t, p.d);
        return;
      }
    }
  }

  private beat(): void {
    if (!this.acked) {
      // Zombie connection: no ack since the last beat.
      this.o.log('heartbeat not acknowledged; reconnecting');
      this.reconnect(true);
      return;
    }
    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  private reconnect(resume: boolean): void {
    this.stopHeartbeat();
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.close(4000);
    }
    if (!this.stopped) setTimeout(() => this.connect(resume && this.canResume), this.o.reconnectDelayMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.o.clearTimer(this.heartbeat);
    this.heartbeat = null;
  }
}
