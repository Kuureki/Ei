// cli/ui/card.ts
import pc from "picocolors";

export interface CardRow {
  key: string;
  value: string;
  color?: (s: string) => string;
}

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function fit(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(1, width - 3)) + "...";
}

export function card(title: string, rows: CardRow[], opts: { minWidth?: number } = {}): string {
  const minWidth = opts.minWidth ?? 46;
  const maxKey = rows.reduce((n, r) => Math.max(n, r.key.length), 0);
  const rendered: string[] = [];
  for (const r of rows) {
    const value = r.color ? r.color(fit(r.value, 40)) : fit(r.value, 40);
    rendered.push(`│ ${r.key.padEnd(maxKey)}  ${value}`);
  }
  const plain = rendered.map((l) => strip(l));
  const width = Math.max(minWidth, title.length + 6, ...plain.map((l) => l.length + 2));
  const rowsOut = rendered.map((l, i) => {
    const pad = width - plain[i].length - 2;
    return `${l}${" ".repeat(Math.max(0, pad))} │`;
  });
  const top = `╭─ ${pc.bold(title)} ${"─".repeat(Math.max(0, width - title.length - 4))}╮`;
  const bottom = `╰${"─".repeat(width)}╯`;
  return [top, ...rowsOut, bottom].join("\n") + "\n";
}

export function errorCard(title: string, lines: string[]): string {
  const body = lines.map((l) => `  ${l}`).join("\n");
  return pc.red(pc.bold(`✖ ${title}`)) + "\n" + body + "\n";
}
