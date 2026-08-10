// Discord application command definitions for the provider registry.
export interface DiscordOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  options?: DiscordOption[];
}

export interface DiscordCommand {
  name: string;
  description: string;
  options: DiscordOption[];
}

// Discord option types: 3 STRING, 5 BOOLEAN, 1 SUB_COMMAND.
const O_STRING = 3;
const O_BOOL = 5;
const O_SUB = 1;

function nameOpt(required: boolean): DiscordOption {
  return { type: O_STRING, name: "name", description: "Provider name (must already exist)", required };
}

export function buildCommandDefinitions(): DiscordCommand[] {
  return [
    {
      name: "provider",
      description: "Manage BYOK OpenAI-compatible providers and models.",
      options: [
        { type: O_SUB, name: "add", description: "Register a new provider (opens a form).", options: [] },
        { type: O_SUB, name: "list", description: "List providers, cached models, and key status.", options: [] },
        {
          type: O_SUB,
          name: "edit",
          description: "Update a provider.",
          options: [
            nameOpt(true),
            { type: O_STRING, name: "base_url", description: "New OpenAI-compatible base URL" },
            { type: O_STRING, name: "key_env", description: "New Doppler secret name" },
            { type: O_BOOL, name: "enabled", description: "Enable or disable the provider" },
          ],
        },
        { type: O_SUB, name: "remove", description: "Remove a provider and its cached models.", options: [nameOpt(true)] },
        { type: O_SUB, name: "test", description: "Run a one-token completion against the provider.", options: [nameOpt(true)] },
        { type: O_SUB, name: "refresh", description: "Re-discover models from /v1/models + models.dev.", options: [nameOpt(true)] },
        {
          type: O_SUB,
          name: "use",
          description: "Set the active provider+model.",
          options: [
            { type: O_STRING, name: "model", description: "Model id from the cached catalog", required: true, autocomplete: true },
          ],
        },
      ],
    },
  ];
}

export function providerCommandCount(cmd: { options?: DiscordOption[] }): number {
  return (cmd.options ?? []).length;
}
