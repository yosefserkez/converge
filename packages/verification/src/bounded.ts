// Bounded text helpers. Workers-safe: Web Streams and TextDecoder only.

export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_OBSERVED_CHARS = 2048;

export function truncationLabel(omitted: string): string {
  return `\n[truncated by verifier: ${omitted}]`;
}

/** Reads at most `limit` bytes of a body stream and cancels the rest. */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - received;
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room));
        await reader.cancel();
        return text + truncationLabel(`response body exceeded ${limit} bytes`);
      }
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Caps a string for inclusion in an observation. */
export function boundString(value: string, limit: number = MAX_OBSERVED_CHARS): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + truncationLabel(`${value.length - limit} more characters`);
}
