export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost") return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.startsWith("[")) host = host.slice(1, -1);
  if (host.includes(":")) return false; // IPv6 literal without allowlist

  const isDottedIPv4 = /^\d+(\.\d+){3}$/.test(host);
  if (isDottedIPv4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
  }
  return true;
}
