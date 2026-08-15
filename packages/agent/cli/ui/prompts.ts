// cli/ui/prompts.ts
import { confirm as cConfirm, isCancel, password as cPassword, select as cSelect, text as cText, type Option } from "@clack/prompts";

function interactive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
}

export async function confirm(message: string, initial = true): Promise<boolean | null> {
  if (!interactive()) return initial;
  const r = await cConfirm({ message, initialValue: initial });
  return isCancel(r) ? null : Boolean(r);
}

export async function select<T extends string>(
  message: string,
  options: Option<T>[],
  initial?: T,
): Promise<T | null> {
  if (!interactive()) return (initial ?? options[0]?.value ?? null) as T | null;
  const r = await cSelect({ message, options, initialValue: initial });
  return isCancel(r) ? null : r;
}

export async function text(message: string, placeholder?: string, initial?: string): Promise<string | null> {
  if (!interactive()) return initial ?? "";
  const r = await cText({ message, placeholder, initialValue: initial });
  return isCancel(r) ? null : r;
}

export async function secretText(message: string, _placeholder?: string, initial?: string): Promise<string | null> {
  if (!interactive()) return initial ?? "";
  const r = await cPassword({ message, mask: "*" });
  return isCancel(r) ? null : r;
}
