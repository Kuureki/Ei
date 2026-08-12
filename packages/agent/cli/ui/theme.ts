// cli/ui/theme.ts
import pc from "picocolors";

export interface Theme {
  ok: (s: string) => string;
  warn: (s: string) => string;
  err: (s: string) => string;
  dim: (s: string) => string;
  strong: (s: string) => string;
  heading: (s: string) => string;
  label: (s: string) => string;
}

export const theme: Theme = {
  ok: pc.green,
  warn: pc.yellow,
  err: pc.red,
  dim: pc.dim,
  strong: pc.bold,
  heading: pc.bold,
  label: pc.cyan,
};
