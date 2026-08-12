// cli/ui/ui.test.ts
import { describe, expect, test } from "bun:test";
import { card, errorCard } from "./card";
import { table } from "./table";

test("card renders a title and aligned rows", () => {
  expect(card("Ei · dev", [
    { key: "Agent health", value: "● ok" },
    { key: "Active model", value: "groq/llama-3.3-70b-versatile" },
  ])).toMatchSnapshot();
});

test("errorCard renders a red title and lines", () => {
  expect(errorCard("ei failed", ["boom", "run ei doctor"])).toMatchSnapshot();
});

test("table aligns columns", () => {
  expect(table(["name", "base url"], [
    ["groq", "https://api.groq.com/openai/v1"],
    ["moonshot", "https://api.moonshot.ai/v1"],
  ])).toMatchSnapshot();
});
