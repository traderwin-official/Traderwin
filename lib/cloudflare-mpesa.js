export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      ...extraHeaders
    }
  });
}

export function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function getClientIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 100);
}

export function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function enforceRateLimit({ env, request, scope, key, limit, windowSeconds = 60 }) {
  const limiter = env?.MPESA_RATE_LIMITER;
  const token = env?.MPESA_RATE_LIMITER_TOKEN;
  if (!limiter || typeof limiter.fetch !== "function" || !token) {
    return {
      ok: false,
      response: json({ error: "Payment services are temporarily unavailable while rate protection is configured." }, 503)
    };
  }

  const safeScope = String(scope || "mpesa").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const safeKey = String(key || getClientIp(request)).slice(0, 200);
  try {
    const response = await limiter.fetch("https://rate-limit.internal/check", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: safeScope + ":" + safeKey,
        limit: Number(limit),
        windowSeconds: Number(windowSeconds)
      })
    });
    if (!response.ok) {
      return {
        ok: false,
        response: json({ error: "Payment rate protection is unavailable. Please try again later." }, 503)
      };
    }
    const result = await response.json().catch(() => null);
    if (!result || typeof result.allowed !== "boolean") {
      return {
        ok: false,
        response: json({ error: "Payment rate protection returned an invalid response." }, 503)
      };
    }
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.min(120, Number(result.retryAfterSeconds) || windowSeconds));
      return {
        ok: false,
        response: json(
          { error: "Too many requests. Please wait before trying again.", retryAfterSeconds: retryAfter },
          429,
          { "Retry-After": String(retryAfter) }
        )
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      response: json({ error: "Payment rate protection is unavailable. Please try again later." }, 503)
    };
  }
}
