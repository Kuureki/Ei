export interface DiscordAddress {
  guildId: string;
  channelId: string;
  threadId?: string;
  scheduleRunId?: string;
}

export function encodeToken(a: DiscordAddress): string {
  const base = a.threadId ? `${a.guildId}:${a.channelId}:${a.threadId}` : `${a.guildId}:${a.channelId}`;
  return a.scheduleRunId ? `${base}:${a.scheduleRunId}` : base;
}

export function decodeToken(token: string): DiscordAddress | null {
  const [guildId, channelId, threadId, scheduleRunId] = token.split(":");
  if (!guildId || !channelId) return null;
  const out: DiscordAddress = { guildId, channelId };
  if (threadId) out.threadId = threadId;
  if (scheduleRunId) out.scheduleRunId = scheduleRunId;
  return out;
}

export function splitReply(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
