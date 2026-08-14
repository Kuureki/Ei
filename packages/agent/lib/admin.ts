// Interaction orchestration: one entry point services every admin interaction event.
import type { SqlExecutor } from "./db";
import type { InteractionEvent } from "./gateway/gateway";
import {
  deferredAck,
  followupEphemeral,
  modalValues,
  parseOptions,
  respondAutocomplete,
  respondModal,
  subcommandOf,
  type OptionValue,
} from "./interactions";
import type { CommandDeps } from "./commands";

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export interface CommandModule {
  handleCommand(deps: CommandDeps, command: string, options: Record<string, string | boolean>): Promise<{ reply: string }>;
  handleAutocomplete(deps: CommandDeps, command: string, query: string): Promise<{ choices: AutocompleteChoice[] }>;
  handleModalSubmit(deps: CommandDeps, customId: string, values: Record<string, string>): Promise<{ reply: string }>;
}

export interface AdminDeps {
  appId: string;
  ex: SqlExecutor;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  commands: CommandModule;
}

const TEXT_INPUT = { type: 4, style: 1 };

export async function serviceAdminEvent(interaction: InteractionEvent, deps: AdminDeps): Promise<void> {
  const f = deps.fetchImpl;
  const commandDeps: CommandDeps = { ex: deps.ex, env: deps.env, fetchImpl: f };
  const options = (interaction.data.options ?? []) as OptionValue[];

  if (interaction.type === 4) {
    const command = subcommandOf(options);
    const inner = options[0] && (options[0] as { type?: number; options?: unknown[] }).type === 1
      ? (options[0] as { options?: unknown[] }).options
      : options;
    const parsed = parseOptions(inner as never);
    const query = typeof parsed.model === "string" ? parsed.model : "";
    const { choices } = await deps.commands
      .handleAutocomplete(commandDeps, command ?? "", query)
      .catch(() => ({ choices: [] as AutocompleteChoice[] }));
    await respondAutocomplete(interaction, choices.slice(0, 25), { fetchImpl: f });
    return;
  }

  if (interaction.type === 5) {
    try {
      await deferredAck(interaction, { fetchImpl: f });
      const values = modalValues((interaction.data.components as never) ?? { components: [] });
      const { reply } = await deps.commands.handleModalSubmit(commandDeps, interaction.data.custom_id ?? "", values);
      await followupEphemeral(deps.appId, interaction, reply, { fetchImpl: f });
    } catch (err) {
      await followupEphemeral(deps.appId, interaction, `Error: ${err instanceof Error ? err.message : String(err)}`, { fetchImpl: f }).catch(() => {});
    }
    return;
  }

  // type 2 command
  try {
    const command = subcommandOf(options);
    if (command === "add") {
      await respondModal(interaction, {
        customId: "provider_add",
        title: "Add BYOK provider",
        components: [
          { ...TEXT_INPUT, custom_id: "name", label: "Provider name", required: true, min_length: 1, max_length: 40 },
          { ...TEXT_INPUT, custom_id: "base_url", label: "Base URL (OpenAI-compatible)", required: true, max_length: 200 },
          { ...TEXT_INPUT, custom_id: "key_env", label: "Doppler secret name (e.g. PROVIDER_GROQ_API_KEY)", required: true, max_length: 80 },
          { ...TEXT_INPUT, custom_id: "api_key", label: "API key (value; saved to Doppler by default)", required: false, max_length: 2000 },
          { ...TEXT_INPUT, custom_id: "headers", label: "Extra headers JSON (optional; ${env:NAME} refs)", required: false, max_length: 500 },
        ],
      }, { fetchImpl: f });
      return;
    }
    await deferredAck(interaction, { fetchImpl: f });
    const inner = options[0] && (options[0] as { type?: number; options?: unknown[] }).type === 1
      ? (options[0] as { options?: unknown[] }).options
      : options;
    const parsed = parseOptions(inner as never);
    const { reply } = await deps.commands.handleCommand(commandDeps, command ?? "", parsed);
    await followupEphemeral(deps.appId, interaction, reply, { fetchImpl: f });
  } catch (err) {
    await followupEphemeral(deps.appId, interaction, `Error: ${err instanceof Error ? err.message : String(err)}`, { fetchImpl: f }).catch(() => {});
  }
}
