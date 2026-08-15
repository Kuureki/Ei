// Zero-dependency Discord gateway client (Bun native WebSocket).
export interface GatewayConfig {
  token: string;
  intents: number;
  ownerId: string;
  onMessage: (msg: InboundMessage) => void;
  onInteraction?: (interaction: InteractionEvent) => void;
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
  messageId: string;
  threadRequested?: boolean;
  text: string;
  attachments: InboundAttachment[];
}

export type InteractionKind = 2 | 4 | 5; // APPLICATION_COMMAND, AUTOCOMPLETE, MODAL_SUBMIT

export interface InteractionEvent {
  id: string;
  type: InteractionKind;
  token: string;
  userId: string;
  guildId?: string;
  channelId: string;
  data: {
    name?: string;
    custom_id?: string;
    options?: unknown[];
    components?: unknown;
    resolved?: unknown;
  };
}

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
  DIRECT_MESSAGES: 1 << 12,
};

const CHANNEL_DM = 1;
const CHANNEL_PUBLIC_THREAD = 11;
const CHANNEL_PRIVATE_THREAD = 12;

function mentionsBot(d: any, botId: string): boolean {
  if (!botId) return false;
  if (Array.isArray(d.mentions) && d.mentions.some((u: any) => String(u?.id) === String(botId))) return true;
  return new RegExp(`<@!?${botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`).test(String(d.content ?? ""));
}

export function mapMessageCreate(
  d: any,
  ownerId: string,
  botId = "",
  knownChannelType?: number | null,
): InboundMessage | null {
  if (d.author?.bot) return null;
  if (String(d.author.id) !== String(ownerId)) return null;
  // MESSAGE_CREATE carries no `channel` object (only channel_id) and, for
  // messages inside a thread, no `thread` object either in this setup — the
  // caller resolves the channel type via REST (cached) and passes it here.
  const channelType = Number(d.channel?.type ?? 0);
  const threadType = Number(d.thread?.type ?? 0);
  const knownThread = knownChannelType === 11 || knownChannelType === 12;
  const isThread =
    typeof d.thread?.id === "string" ||
    channelType === 11 ||
    channelType === 12 ||
    threadType === 11 ||
    threadType === 12 ||
    knownThread;
  const isDm = channelType === 1 || knownChannelType === 1;
  const threadRequested = !isThread && !isDm && mentionsBot(d, botId);
  if (!isThread && !isDm && !threadRequested) return null;
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
    threadId: d.thread?.id
      ? String(d.thread.id)
      : knownThread
        ? String(d.channel_id)
        : undefined,
    messageId: String(d.id ?? ""),
    threadRequested,
    text: [
      typeof d.content === "string" ? d.content : "",
      ...(d.embeds ?? [])
        .map((e: any) => (e.url ? `[link] ${e.url}` : ""))
        .filter(Boolean),
    ].join("\n"),
    attachments,
  };
}

export function mapInteractionCreate(d: unknown, ownerId: string): InteractionEvent | null {
  const raw = (d ?? {}) as {
    id?: unknown;
    type?: unknown;
    token?: unknown;
    channel_id?: unknown;
    guild_id?: unknown;
    member?: { user?: { id?: unknown } };
    user?: { id?: unknown };
    data?: { name?: unknown; custom_id?: unknown; options?: unknown[]; components?: unknown; resolved?: unknown };
  };
  const type = raw.type as InteractionKind | undefined;
  if (type !== 2 && type !== 4 && type !== 5) return null;
  const userId = String(raw.member?.user?.id ?? raw.user?.id ?? "");
  if (!userId || userId !== String(ownerId)) return null;
  if (typeof raw.id !== "string" || typeof raw.token !== "string" || typeof raw.channel_id !== "string") return null;
  const data = raw.data ?? {};
  return {
    id: raw.id,
    type,
    token: raw.token,
    userId,
    guildId: typeof raw.guild_id === "string" ? raw.guild_id : undefined,
    channelId: raw.channel_id,
    data: {
      name: typeof data.name === "string" ? data.name : undefined,
      custom_id: typeof data.custom_id === "string" ? data.custom_id : undefined,
      options: Array.isArray(data.options) ? data.options : undefined,
      components: data.components,
      resolved: data.resolved,
    },
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
  private botId = "";
  private channelTypes = new Map<string, number>();

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
    ws.onmessage = async (ev) => {
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
            this.botId = String(data.d.user?.id ?? "");
            this.cfg.log?.(`READY as ${data.d.user.username}`);
          } else if (data.t === "RESUMED") {
            this.cfg.log?.("RESUMED");
          } else if (data.t === "MESSAGE_CREATE") {
            const type = await this.resolveChannelType(String(data.d.channel_id ?? ""));
            const msg = mapMessageCreate(data.d, this.cfg.ownerId, this.botId, type);
            if (msg) this.cfg.onMessage(msg);
          } else if (data.t === "INTERACTION_CREATE") {
            const ev = mapInteractionCreate(data.d, this.cfg.ownerId);
            if (ev && this.cfg.onInteraction) this.cfg.onInteraction(ev);
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

  // MESSAGE_CREATE events carry only channel_id. The bot does not receive
  // `channel`/`thread` objects for in-thread messages, so resolve the channel
  // type via REST once per channel id and cache it.
  private async resolveChannelType(channelId: string): Promise<number | null> {
    if (!channelId) return null;
    const cached = this.channelTypes.get(channelId);
    if (cached !== undefined) return cached >= 0 ? cached : null;
    try {
      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
        headers: { authorization: `Bot ${this.cfg.token}` },
      });
      if (!res.ok) {
        this.channelTypes.set(channelId, -1);
        return null;
      }
      const ch = (await res.json()) as { type?: number };
      const type = Number(ch.type ?? -1);
      this.channelTypes.set(channelId, type);
      return type >= 0 ? type : null;
    } catch (err) {
      this.cfg.log?.(`channel type resolve failed ${channelId} ${err}`);
      this.channelTypes.set(channelId, -1);
      return null;
    }
  }
}
