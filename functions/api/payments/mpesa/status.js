import { createClient } from "@supabase/supabase-js";
import {
  json, validUuid, enforceRateLimit, getClientIp, bearerToken
} from "../../../../lib/cloudflare-mpesa.js";

export async function onRequestGet({ request, env }) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Payment status is temporarily unavailable." }, 503);
  }

  const orderId = String(new URL(request.url).searchParams.get("orderId") || "").trim();
  if (!validUuid(orderId)) return json({ error: "A valid payment order ID is required." }, 400);

  const token = bearerToken(request);
  if (!token) return json({ error: "Sign in is required." }, 401);

  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "Your login session is invalid." }, 401);

    const userLimit = await enforceRateLimit({
      env, request, scope: "member-payment-status-user", key: auth.user.id, limit: 30, windowSeconds: 60
    });
    if (!userLimit.ok) return userLimit.response;
    const ipLimit = await enforceRateLimit({
      env, request, scope: "member-payment-status-ip", key: getClientIp(request), limit: 60, windowSeconds: 60
    });
    if (!ipLimit.ok) return ipLimit.response;

    const { data, error } = await admin.from("payment_orders")
      .select("id,service_code,amount_kes,currency,status,created_at,confirmed_at")
      .eq("id", orderId).eq("user_id", auth.user.id).maybeSingle();
    if (error) {
      console.error("Tiger Scheme payment status lookup failed:", error.message);
      return json({ error: "Payment status is temporarily unavailable." }, 503);
    }
    if (!data) return json({ error: "Payment order was not found." }, 404);
    return json({ order: data });
  } catch (error) {
    console.error("Tiger Scheme payment status error:", error?.message || "unknown");
    return json({ error: "Could not check payment status." }, 500);
  }
}
