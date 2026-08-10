export interface DiscordAddress {
  guildId: string;
  channelId: string;
  threadId?: string;
}

export function encodeToken(a: DiscordAddress): string {
  return a.threadId ? `${a.guildId}:${a.channelId}:${a.threadId}` : `${a.guildId}:${a.channelId}`;
}

export function decodeToken(token: string): DiscordAddress | null {
  const [guildId, channelId, threadId] = token.split(":");
  if (!guildId || !channelId) return null;
  return { guildId, channelId, threadId };
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
