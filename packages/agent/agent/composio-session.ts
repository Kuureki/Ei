// Composio client + owner-scoped Tool Router session. Lazily constructed so
// the agent boots (and tests copy the module) without a COMPOSIO_API_KEY.
import { Composio, type SessionWithoutMcp } from "@composio/core";
import { EveProvider } from "@composio/experimental/eve";

export const COMPOSIO_OWNER_ID: string | undefined = process.env.AGENT_OWNER_DISCORD_ID;

export function getComposioSessionKey(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  return env.COMPOSIO_API_KEY;
}

export async function createComposioSession(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<SessionWithoutMcp<any, any, any> | null> {
  const key = getComposioSessionKey(env);
  const ownerId = env.AGENT_OWNER_DISCORD_ID;
  if (!key || !ownerId) return null;
  const client = getComposioClient(key);
  if (!client) return null;
  try {
    return await client.sessions.create(ownerId, {
      toolkits: ["googlecalendar", "gmail", "todoist"],
      manageConnections: { enable: true, waitForConnections: false },
      sandbox: { enable: false },
      preload: { tools: "all" },
    });
  } catch {
    return null;
  }
}

let _client: Composio<any> | null = null;
export function getComposioClient(
  apiKey?: string | undefined,
): Composio<any> | null {
  const key = apiKey ?? process.env.COMPOSIO_API_KEY;
  if (!key) return null;
  if (!_client) {
    _client = new Composio({
      provider: new EveProvider(),
      apiKey: key,
    });
  }
  return _client;
}
export const composioClient = getComposioClient();

let _session: SessionWithoutMcp<any, any, any> | null | undefined;
export async function getComposioSession(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<SessionWithoutMcp<any, any, any> | null> {
  if (_session === undefined) _session = await createComposioSession(env);
  return _session;
}

// Test only: clear the memoized session so tests run in any order.
export function __resetComposioSessionForTests(): void {
  _session = undefined;
}
