import { defineTool } from "eve/tools";
import { z } from "zod";
import { isPublicHttpUrl } from "@ei/shared";

const FETCH_CAP = 40_000;

export const fetchPage = defineTool({
  description:
    "Fetch a public web page and return its readable text as markdown. Use before saving any link to memory.",
  inputSchema: z.object({ url: z.string() }),
  async execute(input) {
    if (!isPublicHttpUrl(input.url)) {
      throw new Error("URL blocked: not a public http(s) URL");
    }
    const res = await fetch(input.url, {
      headers: { "user-agent": "personal-memory-agent/0.1 (+discord private bot)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const html = contentType.includes("text/html")
      ? text
      : `<pre>${escapeHtml(text.slice(0, FETCH_CAP))}</pre>`;

    const { default: TurndownService } = await import("turndown");
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const markdown = td.turndown(html).slice(0, FETCH_CAP);
    return { url: input.url, markdown };
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default fetchPage;
