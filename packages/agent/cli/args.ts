// cli/args.ts
export class ArgsError extends Error {}

const VALUE_FLAGS = new Set(["checkout", "unit", "project", "config", "lines", "key-env", "api-key", "headers", "reasoning"]);
const BOOL_FLAGS = new Set(["json", "dry-run", "debug", "follow", "help", "version"]);

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
      if (BOOL_FLAGS.has(name)) {
        flags[name] = inline !== undefined ? inline === "true" : true;
      } else if (VALUE_FLAGS.has(name) || inline !== undefined) {
        flags[name] = inline ?? argv[++i];
        if (flags[name] === undefined) throw new ArgsError(`--${name} requires a value`);
      } else {
        throw new ArgsError(`unknown flag --${name}`);
      }
    } else {
      positionals.push(tok);
    }
  }
  const command = positionals.shift() ?? "";
  return { command, positionals, flags };
}
