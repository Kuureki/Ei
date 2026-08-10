// Slash-command handlers for the BYOK provider registry (full body in Task 8).
import type { SqlExecutor } from "./db";

export interface CommandDeps {
  ex: SqlExecutor;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export async function handleCommand(_deps: CommandDeps, _command: string, _options: Record<string, string | boolean>): Promise<{ reply: string }> {
  return { reply: "unknown command" };
}

export async function handleAutocomplete(_deps: CommandDeps, _command: string, _query: string): Promise<{ choices: Array<{ name: string; value: string }> }> {
  return { choices: [] };
}

export async function handleModalSubmit(_deps: CommandDeps, _customId: string, _values: Record<string, string>): Promise<{ reply: string }> {
  return { reply: "unknown modal" };
}
