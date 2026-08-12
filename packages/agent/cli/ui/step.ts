// cli/ui/step.ts
import { spinner } from "@clack/prompts";
import { theme } from "./theme";

export async function runStep(label: string, fn: () => Promise<void>): Promise<void> {
  const s = spinner();
  s.start(label);
  try {
    await fn();
    s.stop(`${theme.ok("✔")} ${label}`);
  } catch (err) {
    s.stop(`${theme.err("✖")} ${label}`);
    throw err;
  }
}

export function plugStep(label: string, ok: boolean, detail = ""): void {
  const mark = ok ? theme.ok("✔") : theme.err("✖");
  const suffix = detail ? theme.dim(` ${detail}`) : "";
  process.stdout.write(`  ${mark} ${label}${suffix}\n`);
}
