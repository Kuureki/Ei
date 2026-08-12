// cli/ui/table.ts
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  const sep = "─".repeat(widths.reduce((a, b) => a + b + 2, 0) - 2);
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n") + "\n";
}
