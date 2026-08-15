// cli/commands/provider.ts
import type { SqlExecutor } from "../../lib/db";
import {
  cacheCounts,
  getActiveModel,
  getProvider,
  isValidReasoningLevel,
  listModelsForAutocomplete,
  listProviders,
  replaceModels,
  setActiveModel,
  REASONING_LEVELS,
} from "../../lib/providers";
import { discoverModels } from "../../lib/discovery";
import { handleModalSubmit, testProvider as libTestProvider, type CommandDeps } from "../../lib/commands";
import { setSecretInDoppler } from "../../lib/doppler";
import type { EiConfig } from "../config";
import { openDb, safeSecrets, mergedEnv } from "../env";
import { card, errorCard } from "../ui/card";
import { table } from "../ui/table";
import { theme } from "../ui/theme";
import { secretText } from "../ui/prompts";
import { ArgsError } from "../args";

export interface ProviderListRow {
  name: string;
  baseUrl: string;
  keySet: boolean;
  models: number;
  endpoint: number;
  catalog: number;
  active: boolean;
}

export async function providerList(ex: SqlExecutor, env: Record<string, string | undefined>): Promise<{ providers: ProviderListRow[]; activeModel: string | null }> {
  const providers = await listProviders(ex);
  const active = await getActiveModel(ex);
  const rows: ProviderListRow[] = [];
  for (const p of providers) {
    const counts = await cacheCounts(ex, p.id);
    rows.push({
      name: p.name,
      baseUrl: p.base_url,
      keySet: Boolean(env[p.key_env]),
      models: counts.endpoint + counts.catalog,
      endpoint: counts.endpoint,
      catalog: counts.catalog,
      active: active?.provider_id === p.id,
    });
  }
  return { providers: rows, activeModel: active ? `${active.provider_id}/${active.model_id}` : null };
}

export async function providerUse(
  ex: SqlExecutor,
  modelId: string,
  reasoningLevel?: string,
): Promise<{ modelId: string; reasoning: string | null }> {
  const rows = await listModelsForAutocomplete(ex, modelId);
  const match = rows.find((r) => r.model_id === modelId);
  if (!match) throw new Error(`Unknown model "${modelId}". Run ei provider list first.`);
  const level = reasoningLevel ?? null;
  if (level !== null && !isValidReasoningLevel(level)) {
    throw new Error(`Invalid --reasoning "${level}". Choose from: ${REASONING_LEVELS.join(", ")}.`);
  }
  await setActiveModel(ex, { provider_id: match.provider_id, model_id: modelId, reasoning_level: level });
  return { modelId, reasoning: level };
}

export async function provider(
  cfg: EiConfig,
  flags: Record<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const sub = positionals[0] ?? "";
  const ex = await openDb(cfg);
  if (!ex) {
    process.stderr.write(errorCard("provider", ["Postgres unreachable — is doppler configured and WORKFLOW_POSTGRES_URL set?"]));
    return 1;
  }
  const secrets = await safeSecrets(cfg);
  const env = mergedEnv(secrets);
  switch (sub) {
    case "list": {
      const { providers, activeModel } = await providerList(ex, env);
      if (flags.json) {
        process.stdout.write(JSON.stringify({ activeModel, providers }, null, 2) + "\n");
        return 0;
      }
      if (!providers.length) {
        process.stdout.write("No providers configured. Run `ei setup` then add providers in Discord.\n");
        return 0;
      }
      process.stdout.write(
        table(["name", "key", "models", "endpoint", "catalog", "active"], providers.map((p) => [
          p.name,
          p.keySet ? theme.ok("set") : theme.warn("unset"),
          String(p.models),
          String(p.endpoint),
          String(p.catalog),
          p.active ? theme.ok("★") : "—",
        ])) + "\n",
      );
      if (activeModel) process.stdout.write(theme.dim(`active: ${activeModel}\n`));
      return 0;
    }
    case "add": {
      const name = positionals[1];
      const baseUrl = positionals[2];
      if (!name || !baseUrl) throw new ArgsError("usage: ei provider add <name> <base_url> [--key-env NAME] [--api-key KEY] [--headers JSON]");
      const defaultKeyEnv = `PROVIDER_${name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`;
      const keyEnv = typeof flags["key-env"] === "string" ? flags["key-env"] : defaultKeyEnv;
      const headers = typeof flags.headers === "string" ? flags.headers : "";
      let apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : "";
      if (!apiKey) {
        const entered = await secretText(`API key for ${name} (optional; saved to Doppler as ${keyEnv})`, "", "");
        apiKey = entered ?? "";
      }
      const deps: CommandDeps = { ex, env, fetchImpl: fetch, setSecret: setSecretInDoppler(env) };
      const { reply } = await handleModalSubmit(deps, "provider_add", {
        name,
        base_url: baseUrl,
        key_env: keyEnv,
        api_key: apiKey,
        headers,
      });
      process.stdout.write(reply + "\n");
      return 0;
    }
    case "test": {
      const name = positionals[1];
      if (!name) throw new ArgsError("usage: ei provider test <name>");
      const reply = await libTestProvider({ ex, env }, { name });
      process.stdout.write(reply.reply + "\n");
      return 0;
    }
    case "refresh": {
      const name = positionals[1];
      if (!name) throw new ArgsError("usage: ei provider refresh <name>");
      const p = await getProvider(ex, name);
      if (!p) throw new Error(`No provider named "${name}".`);
      const apiKey = env[p.key_env];
      const result = await discoverModels({ baseUrl: p.base_url, name: p.name, apiKey, ex, forceCatalog: true });
      await replaceModels(ex, p.id, result.rows);
      const note = result.endpointError ? theme.warn(` (endpoint: ${result.endpointError})`) : "";
      process.stdout.write(`Refreshed "${p.name}": ${theme.ok(String(result.rows.length))} model(s).${note}\n`);
      return 0;
    }
    case "use": {
      const modelId = positionals[1];
      if (!modelId) throw new ArgsError("usage: ei provider use <model> [--reasoning none|minimal|low|medium|high|xhigh|max]");
      const reasoning = typeof flags.reasoning === "string" ? flags.reasoning : undefined;
      const { modelId: used, reasoning: level } = await providerUse(ex, modelId, reasoning);
      const suffix = level ? ` with reasoning=${theme.ok(level)}` : "";
      process.stdout.write(`${theme.ok("✔")} Active model set to ${used}${suffix}. Applies from your next message.\n`);
      return 0;
    }
    default: {
      process.stderr.write(card("ei provider", [
        { key: "add <name> <base_url>", value: "register a provider (--key-env, --api-key, --headers)" },
        { key: "list", value: "show providers, key status, model counts" },
        { key: "test <name>", value: "one-token probe against the provider" },
        { key: "refresh <name>", value: "re-discover models from /v1/models + models.dev" },
        { key: "use <model>", value: "set the active model (--reasoning none|minimal|low|medium|high|xhigh|max)" },
      ]));
      return sub ? 2 : 0;
    }
  }
}
