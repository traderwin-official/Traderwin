function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function digestName(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MpesaRateLimiter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid limiter request." }, 400); }

    const limit = Number(body?.limit);
    const windowSeconds = Number(body?.windowSeconds);
    const now = Number(body?.now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 120 ||
        !Number.isInteger(windowSeconds) || windowSeconds < 10 || windowSeconds > 3600 ||
        !Number.isFinite(now) || now < 0) {
      return json({ error: "Invalid rate-limit policy." }, 400);
    }

    const windowMs = windowSeconds * 1000;
    const windowId = Math.floor(now / windowMs);
    const storage = this.ctx.storage.kv;
    const previous = storage.get("counter");
    const count = previous?.windowId === windowId ? Number(previous.count || 0) : 0;
    if (count >= limit) {
      return json({
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(((windowId + 1) * windowMs - now) / 1000))
      });
    }
    storage.put("counter", { windowId, count: count + 1 });
    return json({ allowed: true, remaining: limit - count - 1 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }
    const expected = env.MPESA_RATE_LIMITER_TOKEN || "";
    const received = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    if (!constantTimeEqual(received, expected)) {
      return json({ error: "Unauthorized." }, 401);
    }
    if (!env.LIMITERS) return json({ error: "Rate limiter storage is not configured." }, 503);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid limiter request." }, 400); }
    const key = String(body?.key || "");
    const limit = Number(body?.limit);
    const windowSeconds = Number(body?.windowSeconds);
    if (!key || key.length > 240 || !Number.isInteger(limit) || limit < 1 || limit > 120 ||
        !Number.isInteger(windowSeconds) || windowSeconds < 10 || windowSeconds > 3600) {
      return json({ error: "Invalid rate-limit policy." }, 400);
    }

    const id = env.LIMITERS.idFromName(await digestName(key));
    const stub = env.LIMITERS.get(id);
    return stub.fetch("https://rate-limit.internal/counter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, windowSeconds, now: Date.now() })
    });
  }
};
