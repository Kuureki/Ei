// cli/ui/card.ts
import pc from "picocolors";

export function errorCard(title: string, lines: string[]): string {
  const body = lines.map((l) => `  ${l}`).join("\n");
  return `${pc.red(pc.bold(`✖ ${title}`))}\n${body}\n`;
}
