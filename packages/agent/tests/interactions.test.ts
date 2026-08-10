import { describe, expect, test } from "bun:test";
import {
  deferredAck,
  followupEphemeral,
  isOwner,
  modalValues,
  parseOptions,
  respondAutocomplete,
  respondModal,
  subcommandOf,
} from "../lib/interactions";

const i = { id: "i1", token: "tok", channelId: "c1", userId: "123" } as const;

describe("isOwner", () => {
  test("compares string ids", () => {
    expect(isOwner(i, "123")).toBe(true);
    expect(isOwner(i, "456")).toBe(false);
  });
});

describe("parseOptions / subcommandOf", () => {
  test("flattens subcommand options", () => {
    const parsed = parseOptions([{ name: "model", value: "m1" }, { name: "enabled", value: true }]);
    expect(parsed).toEqual({ model: "m1", enabled: true });
  });
  test("subcommandOf pulls the nested command name", () => {
    expect(subcommandOf([{ type: 1, name: "use", options: [{ name: "model", value: "m1" }] }])).toBe("use");
    expect(subcommandOf(undefined)).toBeUndefined();
    expect(subcommandOf([{ type: 3, name: "foo" }])).toBeUndefined();
  });
});

describe("modalValues", () => {
  test("reads text input values", () => {
    const d = {
      components: [
        { components: [{ custom_id: "name", type: 4, value: "Groq" }, { custom_id: "key_env", type: 4, value: "PROVIDER_GROQ_API_KEY" }] },
        { components: [{ custom_id: "base_url", type: 4, value: "https://api.groq.com/openai/v1" }] },
      ],
    };
    expect(modalValues(d)).toEqual({
      name: "Groq",
      key_env: "PROVIDER_GROQ_API_KEY",
      base_url: "https://api.groq.com/openai/v1",
    });
  });
});

describe("protocol calls", () => {
  test("respondModal posts type 9 with the modal", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("", { status: 204 });
    }) as typeof fetch;
    await respondModal(i, { customId: "provider_add", title: "Add", components: [] }, { fetchImpl });
    expect(bodies[0].type).toBe(9);
    expect((bodies[0].data as any).custom_id).toBe("provider_add");
  });
  test("deferredAck posts type 5 with ephemeral flag", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("", { status: 204 });
    }) as typeof fetch;
    await deferredAck(i, { fetchImpl });
    expect(bodies[0]).toEqual({ type: 5, data: { flags: 1 << 6 } });
  });
  test("followupEphemeral PATCHes content with the app token url", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      const u = String(url);
      const initObj = init as RequestInit;
      calls.push({ url: u, method: initObj.method ?? "GET", body: JSON.parse(String(initObj.body)) });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await followupEphemeral("app1", i, "hello", { fetchImpl });
    expect(calls[0].url).toContain("/webhooks/app1/tok/messages/@original");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body.content).toBe("hello");
  });
  test("respondAutocomplete posts type 8 with choices", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("", { status: 204 });
    }) as typeof fetch;
    await respondAutocomplete(i, [{ name: "a", value: "v" }], { fetchImpl });
    expect(bodies[0].type).toBe(8);
    expect((bodies[0].data as any).choices).toEqual([{ name: "a", value: "v" }]);
  });
});
