// Build a live AI SDK LanguageModel for a provider from its config + env.
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

export interface ModelSource {
  provider_id: string;
  base_url: string;
  key_env: string;
  headers_json: string | null;
  model_id: string;
}

export function renderHeaders(
  headersJson: string | null,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!headersJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    out[k] = v.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_m, name: string) => env[name] ?? "");
  }
  return out;
}

// Injects reasoningEffort into every call for the given provider; providers
// that don't understand the option ignore it (OpenAI-compatible convention).
export function reasoningMiddleware(providerId: string, level: string): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const existing = (params.providerOptions?.[providerId] ?? {}) as Record<string, unknown>;
      return {
        ...params,
        providerOptions: {
          ...params.providerOptions,
          [providerId]: { ...existing, reasoningEffort: level },
        },
      };
    },
  };
}

export function buildLanguageModel(
  src: ModelSource,
  env: Record<string, string | undefined>,
  reasoningLevel?: string | null,
): LanguageModel | null {
  const apiKey = env[src.key_env];
  if (!apiKey) return null;
  const headers = renderHeaders(src.headers_json, env);
  const openai = createOpenAI({
    name: src.provider_id,
    baseURL: src.base_url,
    apiKey,
    headers,
  });
  const base = openai.chat(src.model_id);
  if (reasoningLevel && reasoningLevel !== "none") {
    return wrapLanguageModel({ model: base, middleware: reasoningMiddleware(src.provider_id, reasoningLevel) });
  }
  return base;
}

// Step-scoped resolver: a live LanguageModel returned from step.started;
// null degrades to the gateway fallback (never throws through).
import { getActiveModel, getProvider } from "./providers";
import { getExecutor } from "./db";

export async function resolveStepModel(env: Record<string, string | undefined>): Promise<LanguageModel | null> {
  try {
    const ex = getExecutor();
    const active = await getActiveModel(ex);
    if (!active) return null;
    const provider = await getProvider(ex, active.provider_id);
    if (!provider || !provider.enabled) return null;
    return buildLanguageModel(
      {
        provider_id: provider.id,
        base_url: provider.base_url,
        key_env: provider.key_env,
        headers_json: provider.headers_json,
        model_id: active.model_id,
      },
      env,
      active.reasoning_level,
    );
  } catch {
    return null;
  }
}
