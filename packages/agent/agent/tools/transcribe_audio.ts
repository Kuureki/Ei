import { defineTool } from "eve/tools";
import { z } from "zod";

export const transcribeAudio = defineTool({
  description:
    "Transcribe an audio voice memo into text using Whisper. Use before saving any voice message to memory.",
  inputSchema: z.object({ audioBase64: z.string(), mediaType: z.string() }),
  async execute(input) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    const bytes = Buffer.from(input.audioBase64, "base64");
    if (bytes.length > 25 * 1024 * 1024) throw new Error("audio too large (max 25 MB)");

    const body = new FormData();
    body.append("model", "whisper-1");
    body.append("file", new File([bytes], `voice.${extFromMedia(input.mediaType)}`, {
      type: input.mediaType,
    }));

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`transcription failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    return { transcript: data.text ?? "" };
  },
});

const MEDIA_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

function extFromMedia(mediaType: string): string {
  return MEDIA_EXT[mediaType] ?? "ogg";
}

export default transcribeAudio;
