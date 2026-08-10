import { describe, expect, test } from "bun:test";
import { serviceAdminEvent } from "../lib/admin";
import type { InteractionEvent } from "../lib/gateway/gateway";
import type { CommandModule } from "../lib/admin";

function fakeCommands(overrides: Partial<CommandModule> = {}): CommandModule {
  return {
    handleCommand: async () => ({ reply: "done" }),
    handleAutocomplete: async () => ({ choices: [{ name: "provider/model — 128k ctx", value: "model-id" }] }),
    handleModalSubmit: async () => ({ reply: "added" }),
    ...overrides,
  };
}

function captureFetch() {
  const calls: Array<{ body: Record<string, any> }> = [];
  const fetchImpl = (async (_url: unknown, init?: unknown) => {
    calls.push({ body: JSON.parse(String((init as RequestInit).body)) });
    return new Response("", { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deps(overrides: { commands?: CommandModule; fetchImpl?: typeof fetch } = {}) {
  const ex = { query: async () => ({ rows: [], rowCount: 0 }) } as any;
  return {
    appId: "app1",
    ex,
    env: {},
    fetchImpl: overrides.fetchImpl,
    commands: overrides.commands ?? fakeCommands(),
  };
}

const owner = (data: Record<string, unknown>): InteractionEvent => ({
  id: "i",
  type: 2,
  token: "tok",
  userId: "1",
  channelId: "c",
  data: data as any,
});

describe("serviceAdminEvent", () => {
  test("command: defers, runs, follows up", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "list", options: [] }] }),
      deps({ fetchImpl }),
    );
    expect(calls.map((c) => c.body.type)).toEqual([5]);
    expect(calls[1].body.content).toBe("done");
    expect(calls).toHaveLength(2);
  });

  test("add command: opens the provider_add modal", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "add", options: [] }] }),
      deps({ fetchImpl }),
    );
    expect(calls[0].body.type).toBe(9);
    expect(calls[0].body.data.custom_id).toBe("provider_add");
    expect(calls).toHaveLength(1);
  });

  test("modal submit: acks and runs the add handler", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      {
        id: "i",
        type: 5,
        token: "tok",
        userId: "1",
        channelId: "c",
        data: { custom_id: "provider_add", components: [{ components: [{ type: 4, custom_id: "name", value: "Groq" }] }] } as any,
      },
      deps({ fetchImpl }),
    );
    expect(calls[0].body.type).toBe(5);
    expect(calls[1].body.content).toBe("added");
  });

  test("autocomplete: answers type 8 from the cache", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      {
        id: "i",
        type: 4,
        token: "tok",
        userId: "1",
        channelId: "c",
        data: { options: [{ type: 1, name: "use", options: [{ type: 3, name: "model", value: "ll" }] }] } as any,
      },
      deps({ fetchImpl }),
    );
    expect(calls[0].body.type).toBe(8);
    expect(calls[0].body.data.choices).toHaveLength(1);
  });

  test("errors reply through the followup", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "bogus", options: [] }] }),
      deps({ commands: fakeCommands({ handleCommand: async () => { throw new Error("boom"); } }), fetchImpl }),
    );
    expect(calls[0].body.type).toBe(5);
    expect(calls[1].body.content).toContain("Error: boom");
  });

  test("unknown subcommand defers and follows up with the handler reply", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "bogus", options: [] }] }),
      deps({ commands: fakeCommands({ handleCommand: async () => ({ reply: "Unknown provider command." }) }), fetchImpl }),
    );
    expect(calls[1].body.content).toBe("Unknown provider command.");
  });
});
