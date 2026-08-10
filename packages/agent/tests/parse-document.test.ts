import { describe, expect, test } from "bun:test";
import { parseDocumentBase64, MAX_DOCUMENT_BYTES } from "../agent/tools/parse_document";

describe("parse_document", () => {
  test("rejects documents over 10 MB", async () => {
    const tooBig = "A".repeat(MAX_DOCUMENT_BYTES + 1);
    await expect(
      parseDocumentBase64(
        "x.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Buffer.from(tooBig).toString("base64"),
      ),
    ).rejects.toThrow(/too large/);
  });

  test("rejects unknown media types without an extension", async () => {
    await expect(
      parseDocumentBase64("file.bin", "application/octet-stream", Buffer.from("hi").toString("base64")),
    ).rejects.toThrow(/unsupported|no extension|unrecognized/);
  });
});
