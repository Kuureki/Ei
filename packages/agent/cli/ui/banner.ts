// cli/ui/banner.ts
import { theme } from "./theme";
import { currentVersion } from "../version";

export function banner(): void {
  process.stdout.write(theme.strong("Ei") + theme.dim(` · ${currentVersion()}`) + "\n\n");
}
