// Discord interaction REST protocol (v10). All network calls take an injectable fetch.

export const DISCORD_API = "https://discord.com/api/v10";
export const EPHEMERAL = 1 << 6;

export function isOwner(interaction: { userId: string }, ownerId: string): boolean {
  return interaction.userId === String(ownerId);
}

export interface OptionValue {
  name?: string;
  value?: unknown;
  type?: number;
  options?: unknown[];
}

export function parseOptions(options: OptionValue[] | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const o of options ?? []) {
    if (typeof o.name !== "string") continue;
    if (typeof o.value === "string" || typeof o.value === "boolean") out[o.name] = o.value;
  }
  return out;
}

export function subcommandOf(options: OptionValue[] | undefined): string | undefined {
  const first = options?.[0];
  if (first && first.type === 1 && typeof first.name === "string") return first.name;
  return undefined;
}

export interface ModalTextInput {
  custom_id: string;
  type: number;
  value?: string;
}

export function modalValues(data: { components?: Array<{ components?: ModalTextInput[] }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of data.components ?? []) {
    for (const comp of row.components ?? []) {
      if (comp.type === 4 && typeof comp.custom_id === "string" && typeof comp.value === "string") {
        out[comp.custom_id] = comp.value;
      }
    }
  }
  return out;
}

async function postCallback(
  interaction: { id: string; token: string },
  body: unknown,
  opts: { fetchImpl?: typeof fetch },
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  return f(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface TextInputSpec {
  type: number;
  custom_id: string;
  label: string;
  style?: number;
  required?: boolean;
  value?: string;
  min_length?: number;
  max_length?: number;
}

export async function respondModal(
  interaction: { id: string; token: string },
  modal: { customId: string; title: string; components: TextInputSpec[] },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await postCallback(interaction, { type: 9, data: { custom_id: modal.customId, title: modal.title, components: [{ type: 1, components: modal.components }] } }, opts);
}

export async function deferredAck(
  interaction: { id: string; token: string },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await postCallback(interaction, { type: 5, data: { flags: EPHEMERAL } }, opts);
}

export async function respondAutocomplete(
  interaction: { id: string; token: string },
  choices: Array<{ name: string; value: string }>,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await postCallback(interaction, { type: 8, data: { choices } }, opts);
}

export async function followupEphemeral(
  appId: string,
  interaction: { token: string },
  content: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  return f(`${DISCORD_API}/webhooks/${appId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}
