import { describe, expect, test } from "bun:test";
import { buildCommandDefinitions, providerCommandCount } from "../lib/registry";

describe("registry payload", () => {
  test("definitions contain one provider command with 7 subcommands", () => {
    const defs = buildCommandDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("provider");
    expect(providerCommandCount(defs[0])).toBe(7);
  });
  test("use subcommand has an autocomplete model option", () => {
    const defs = buildCommandDefinitions();
    const use = (defs[0].options as any[]).find((o: any) => o.name === "use");
    const model = use.options.find((o: any) => o.name === "model");
    expect(model.autocomplete).toBe(true);
    expect(model.required).toBe(true);
  });
});
