// On-demand office-document parser: converts inbound attachments (docx, pdf,
// pptx, xlsx, csv, ...) to Markdown the model can read. Uses @firecrawl/anydoc
// (Rust core + native binding); falls back to mammoth/pdf-parse if the native
// binding cannot load under the target runtime.
import { defineTool } from "eve/tools";
import { z } from "zod";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const ERROR_MESSAGES: Record<string, string> = {
  unsupported:
    "unsupported document format (scanned or image-only PDFs need OCR, which is not available)",
  malformed: "document is malformed and could not be parsed",
  encrypted: "document is encrypted or password-protected",
  resourceLimit: "document is too large or complex for the parser",
  missingPart: "document is incomplete or its parts are missing",
  io: "could not read the document bytes",
};

export async function parseDocumentBase64(
  name: string,
  mediaType: string,
  base64: string,
): Promise<{ markdown: string }> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("document too large (max 10 MB)");
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  let anydoc: any;
  try {
    anydoc = await import("@firecrawl/anydoc");
  } catch {
    anydoc = null;
  }

  if (anydoc && typeof anydoc.toMarkdownBytes === "function") {
    try {
      const format = typeof anydoc.formatFromExtension === "function" ? anydoc.formatFromExtension(ext) : undefined;
      if (format === null && !ext) throw new Error("unsupported document: no file extension");
      const markdown = await anydoc.toMarkdownBytes(bytes, format ?? undefined);
      return { markdown };
    } catch (err: any) {
      if (err && typeof err === "object" && typeof err.code === "string" && err.code in ERROR_MESSAGES) {
        throw new Error(ERROR_MESSAGES[err.code]);
      }
      if (err instanceof Error && /no file extension/.test(err.message)) throw err;
      // Non-typed error: fall through to the pure-JS path.
    }
  }

  if (ext === "pdf") {
    const { getDocument } = (await import("pdf-parse")) as any;
    const pdf = await getDocument(new Uint8Array(bytes));
    return { markdown: pdf.text as string };
  }
  const { default: mammoth } = (await import("mammoth")) as any;
  const r = await mammoth.extractRawText({ buffer: bytes });
  return { markdown: r.value as string };
}

export const parseDocument = defineTool({
  description:
    "Parse an office document (docx, doc, pptx, xlsx, pdf, csv) into markdown text the model can read. Use on document attachments before quoting or saving them.",
  inputSchema: z.object({
    name: z.string().describe("original file name, used as a fallback for format detection"),
    mediaType: z.string().describe("MIME type of the document"),
    documentBase64: z.string().describe("base64-encoded document bytes"),
  }),
  async execute(input) {
    return parseDocumentBase64(input.name, input.mediaType, input.documentBase64);
  },
});

export default parseDocument;
