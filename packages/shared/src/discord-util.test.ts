import { describe, expect, test } from "bun:test";
import { decodeToken, encodeToken } from "./discord-util";

describe("discord-util continuation token", () => {
  test("encodes guild:channel[:thread] and round-trips", () => {
    expect(encodeToken({ guildId: "g", channelId: "c" })).toBe("g:c");
    expect(decodeToken("g:c")).toEqual({ guildId: "g", channelId: "c" });
    const withThread = encodeToken({ guildId: "g", channelId: "c", threadId: "t" });
    expect(withThread).toBe("g:c:t");
    expect(decodeToken(withThread)).toEqual({ guildId: "g", channelId: "c", threadId: "t" });
  });

  test("embeds and recovers an optional scheduleRunId as the 4th segment", () => {
    const token = encodeToken({ guildId: "g", channelId: "c", threadId: "t", scheduleRunId: "r1" });
    expect(token).toBe("g:c:t:r1");
    expect(decodeToken(token)).toEqual({ guildId: "g", channelId: "c", threadId: "t", scheduleRunId: "r1" });
  });

  test("tokens without a thread or scheduleRunId stay backward compatible", () => {
    expect(decodeToken("g:c")?.scheduleRunId).toBeUndefined();
    expect(decodeToken("g:c:t")?.scheduleRunId).toBeUndefined();
    expect(decodeToken("not-a-token")).toBeNull();
  });
});
