import { config } from "./config.js";

// Removes <think>…</think> blocks that some open models (Qwen, DeepSeek) put in their answers,
// even when a tag is split across streamed chunks.
function thinkFilter() {
  const OPEN = "<think>", CLOSE = "</think>";
  let buf = "", inThink = false, started = false;
  const partialTail = (s, tag) => {
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) return k;
    return 0;
  };
  const emit = (s) => {
    if (!started) { s = s.replace(/^\s+/, ""); if (s) started = true; }
    return s;
  };
  return {
    push(chunk) {
      buf += chunk;
      let out = "";
      for (;;) {
        if (inThink) {
          const i = buf.indexOf(CLOSE);
          if (i < 0) { buf = buf.slice(-(CLOSE.length - 1)); return emit(out); }
          buf = buf.slice(i + CLOSE.length); inThink = false;
        } else {
          const i = buf.indexOf(OPEN);
          if (i < 0) {
            const keep = partialTail(buf, OPEN);
            out += buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            return emit(out);
          }
          out += buf.slice(0, i); buf = buf.slice(i + OPEN.length); inThink = true;
        }
      }
    },
    flush() { const s = inThink ? "" : buf; buf = ""; return emit(s); }
  };
}

export class AiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * Streams a chat completion from any OpenAI-compatible server.
 * Calls onText(delta) as text arrives and resolves with the full answer.
 * baseUrl/apiKey default to the main AI settings; images can use a separate service (VISION_BASE_URL).
 */
export async function streamChat({ model, messages, maxTokens, signal, onText, baseUrl = config.ai.baseUrl, apiKey = config.ai.apiKey }) {
  const timeout = AbortSignal.timeout(config.ai.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, temperature: 0.7 }),
      signal: combined
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AiError(`Could not reach the AI server at ${baseUrl} (${e.cause?.code || e.name})`, 0);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new AiError(`AI server answered ${res.status}: ${detail.slice(0, 300)}`, res.status);
  }

  const filter = thinkFilter();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", full = "", finish = null;

  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.error) throw new AiError(`AI server error: ${json.error.message || JSON.stringify(json.error)}`, 502);
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const piece = choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "";
    if (piece) {
      const out = filter.push(piece);
      if (out) { full += out; onText(out); }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      handleLine(line);
    }
  }
  if (pending) handleLine(pending);
  const tail = filter.flush();
  if (tail) { full += tail; onText(tail); }
  return { text: full, truncated: finish === "length" };
}
