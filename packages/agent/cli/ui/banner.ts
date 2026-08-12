// cli/ui/banner.ts
import pc from "picocolors";
import { currentVersion } from "../version";

export function banner(): void {
  process.stdout.write(pc.bold("Ei") + pc.dim(` · ${currentVersion()}`) + "\n\n");
}
