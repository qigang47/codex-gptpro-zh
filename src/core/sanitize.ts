const MAX_PREVIEW_CHARS = 220;

export function slugify(input: string, fallback = "task"): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

export function truncateText(
  text: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text, bytes: buffer.byteLength, truncated: false };
  }
  const truncatedBuffer = buffer.subarray(0, maxBytes);
  return {
    text: truncatedBuffer.toString("utf8").replace(/\uFFFD$/u, ""),
    bytes: maxBytes,
    truncated: true,
  };
}

export function truncateLinePreview(line: string, maxChars = MAX_PREVIEW_CHARS): string {
  const compact = line.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 1)}...`;
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function sanitizeAuditError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  if (buffer.includes(0)) {
    return true;
  }
  const sampleSize = Math.min(buffer.length, 4096);
  let suspicious = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const byte = buffer[index];
    const allowedControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !allowedControl) {
      suspicious += 1;
    }
  }
  return suspicious / sampleSize > 0.08;
}
