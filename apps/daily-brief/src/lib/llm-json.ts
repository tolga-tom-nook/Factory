/**
 * Tolerant JSON extraction for LLM output.
 *
 * Models frequently wrap their JSON in Markdown code fences (```json … ```),
 * prepend a short preamble ("Here's your brief:"), or append a trailing note.
 * A naive `JSON.parse()` throws on all of these, which silently collapsed the
 * insights and wisdom sections into their degraded fallbacks. This helper
 * strips fences and, failing that, extracts the first balanced top-level
 * `{ … }` object before parsing.
 */
export function parseLlmJson<T>(raw: string): T | null {
  if (!raw) return null;

  // 1. Strip a leading/trailing Markdown code fence if present.
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  // 2. Fast path — the cleaned text is already valid JSON.
  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to brace extraction
  }

  // 3. Extract the first balanced { … } block, ignoring braces inside strings.
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
