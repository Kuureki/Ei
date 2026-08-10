// Zero-dependency Discord gateway client (Bun native WebSocket).
export interface GatewayConfig {
  token: string;
  intents: number;
  ownerId: string;
  onMessage: (msg: InboundMessage) => void;
  gatewayUrl?: string;
  log?: (line: string) => void;
}

export interface InboundAttachment {
  name: string;
  mediaType: string;
  url: string;
  size: number;
}

export interface InboundMessage {
  userId: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  text: string;
  attachments: InboundAttachment[];
}

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
  DIRECT_MESSAGES: 1 << 12,
};

export function mapMessageCreate(d: any, ownerId: string): InboundMessage | null {
  if (d.author?.bot) return null;
  if (String(d.author.id) !== String(ownerId)) return null;
  const attachments: InboundAttachment[] = (d.attachments ?? [])
    .filter((a: any) => a.size <= 10 * 1024 * 1024)
    .map((a: any) => ({
      name: a.filename as string,
      mediaType: (a.content_type as string) ?? "application/octet-stream",
      url: a.url as string,
      size: a.size as number,
    }));
  return {
    userId: String(d.author.id),
    guildId: d.guild_id ? String(d.guild_id) : "0",
    channelId: String(d.channel_id),
    threadId: d.thread?.id ? String(d.thread.id) : undefined,
    text: [
      typeof d.content === "string" ? d.content : "",
      ...(d.embeds ?? [])
        .map((e: any) => (e.url ? `[link] ${e.url}` : ""))
        .filter(Boolean),
    ].join("\n"),
    attachments,
  };
}

export class DiscordGateway {
  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private heartbeatIntervalMs = 41_250;
  private stopped = false;
  private resumeUrl = DEFAULT_GATEWAY_URL;

  constructor(private cfg: GatewayConfig) {
    if (cfg.gatewayUrl) this.resumeUrl = cfg.gatewayUrl;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, "shutdown");
  }

  private connect(): void {
    this.cfg.log?.(`connecting to ${this.resumeUrl}`);
    const ws = new WebSocket(this.resumeUrl);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          this.sessionId
            ? {
                op: 6,
                d: { token: this.cfg.token, session_id: this.sessionId, seq: this.sequence },
              }
            : {
                op: 2,
                d: {
                  token: this.cfg.token,
                  intents: this.cfg.intents,
                  properties: { os: "linux", browser: "ei-connector", device: "ei-connector" },
                },
              },
        ),
      );
    };
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data)) as { op: number; s?: number | null; t?: string; d?: any };
      if (typeof data.s === "number") this.sequence = data.s;
      switch (data.op) {
        case 10:
          this.heartbeatIntervalMs = data.d.heartbeat_interval as number;
          this.startHeartbeat();
          break;
        case 0: {
          if (data.t === "READY") {
            this.sessionId = data.d.session_id;
            this.cfg.log?.(`READY as ${data.d.user.username}`);
          } else if (data.t === "RESUMED") {
            this.cfg.log?.("RESUMED");
          } else if (data.t === "MESSAGE_CREATE") {
            const msg = mapMessageCreate(data.d, this.cfg.ownerId);
            if (msg) this.cfg.onMessage(msg);
          }
          break;
        }
      }
    };
    ws.onclose = (ev) => {
      if (this.stopped) return;
      if (ev.code === 4004 || ev.code === 4010) {
        this.cfg.log?.(`fatal gateway close ${ev.code}, exiting`);
        process.exit(1);
      }
      const backoff = this.sessionId ? 1_000 : 5_000;
      this.cfg.log?.(`gateway closed ${ev.code}; reconnecting in ${backoff}ms`);
      this.stopHeartbeat();
      setTimeout(() => this.connect(), backoff);
    };
    ws.onerror = () => this.cfg.log?.("gateway error");
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
