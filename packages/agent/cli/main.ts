// cli/main.ts
import { parseArgs, ArgsError, type ParsedArgs } from "./args";
import { currentVersion } from "./version";
import { readConfig } from "./config";
import { errorCard } from "./ui/card";

const HELP = `ei — the Ei agent command line

Usage:
  ei <command> [options]

Commands:
  setup        Bootstrap a host (doppler, deps, build, register, systemd)
  upgrade      Self-update the binary, then advance the agent checkout
  status       Health card: agent, systemd, model, providers, schedules
  logs         journalctl tail/follow for the agent unit
  provider     list | test <name> | refresh <name> | use <model>
  evals        Run the eval suite
  doctor       Full preflight report (never mutates)
  version      Print the compiled-in version ("dev" from source)
  help         This help

Options:
  --dry-run    Print the planned steps, mutate nothing
  --json       Machine-readable output
  --debug      Include stack traces on errors
  --checkout <path>, --unit <name>, --project <name>
  --lines <n>  (logs) lines to tail; default 100
  --follow     (logs) follow mode
`;

async function invoke(parsed: ParsedArgs): Promise<number> {
  switch (parsed.command) {
    case "":
    case "help":
      if (parsed.command === "help") process.stdout.write(HELP);
      else process.stderr.write(HELP);
      return parsed.command === "help" ? 0 : 2;
    case "version":
      process.stdout.write(currentVersion() + "\n");
      return 0;
    case "status": {
      const cfg = await readConfig(parsed.flags);
      const { status } = await import("./commands/status");
      return status(cfg, parsed.flags);
    }
    case "logs": {
      const cfg = await readConfig(parsed.flags);
      const { logs } = await import("./commands/logs");
      return logs(cfg, parsed.flags);
    }
    case "doctor": {
      const cfg = await readConfig(parsed.flags);
      const { doctor } = await import("./commands/doctor");
      return doctor(cfg, parsed.flags);
    }
    case "provider": {
      const cfg = await readConfig(parsed.flags);
      const { provider } = await import("./commands/provider");
      return provider(cfg, parsed.flags, parsed.positionals);
    }
    case "setup": {
      const cfg = await readConfig(parsed.flags);
      const { setup } = await import("./commands/setup");
      return setup(cfg, parsed.flags);
    }
    case "upgrade": {
      const cfg = await readConfig(parsed.flags);
      const { upgrade } = await import("./upgrade");
      return upgrade(cfg, parsed.flags);
    }
    case "evals": {
      const cfg = await readConfig(parsed.flags);
      const { evals } = await import("./commands/evals");
      return evals(cfg, parsed.flags);
    }
    default:
      throw new ArgsError(`unknown command "${parsed.command}"`);
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.flags.version) {
      process.stdout.write(currentVersion() + "\n");
      return 0;
    }
    if (parsed.flags.help) {
      process.stdout.write(HELP);
      return 0;
    }
    return await invoke(parsed);
  } catch (err) {
    if (err instanceof ArgsError) {
      process.stderr.write(`ei: ${err.message}\n\n${HELP}`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(errorCard("ei failed", [`${msg}`, `Run "ei doctor" for a preflight report.`]));
    if (argv.includes("--debug") && err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
