// cli/main.ts
import { parseArgs, ArgsError, type ParsedArgs } from "./args";
import { currentVersion } from "./version";
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
    case "setup":
    case "upgrade":
    case "status":
    case "logs":
    case "doctor":
    case "evals":
    case "provider":
      // Implemented in later tasks; fail loudly until then.
      throw new Error(`command "${parsed.command}" not implemented yet`);
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
