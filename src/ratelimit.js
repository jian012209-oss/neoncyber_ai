import { HttpError } from "./http.js";

// Small in-memory sliding-window limiter. Fine for a single server process.
// max can be a number or a function of the request (for example, a higher limit for Premium members).
export function rateLimit({ windowMs, max, key, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, windowMs).unref();

  return (req, res) => {
    const k = key(req);
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    const limit = typeof max === "function" ? max(req) : max;
    if (arr.length >= limit) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      throw new HttpError(429, message || "Too many requests. Wait a moment and try again.", { code: "rate_limited" });
    }
    arr.push(now);
    hits.set(k, arr);
  };
}
