import { createClient } from "@supabase/supabase-js";
import { deliverPendingBotLicenseEmails } from "../../lib/standalone-bot-licenses.js";
import { json, validUuid, enforceRateLimit, getClientIp } from "../../lib/cloudflare-mpesa.js";

export async function onRequestGet({ request, env }) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
  const orderId = String(new URL(request.url).searchParams.get("orderId") || "").trim();
  if (!validUuid(orderId)) return json({ error: "Invalid order reference." }, 400);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Status is temporarily unavailable." }, 503);
  }

  const rate = await enforceRateLimit({
    env, request, scope: "standalone-bot-status-ip", key: getClientIp(request),
    limit: 60, windowSeconds: 60
  });
  if (!rate.ok) return rate.response;

  try {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: order, error } = await db.from("bot_license_orders")
      .select("status").eq("id", orderId).maybeSingle();
    if (error) throw error;
    if (!order) return json({ error: "Order not found." }, 404);

    if (order.status === "FULFILLED") {
      try { await deliverPendingBotLicenseEmails({ orderId, limit: 1, env }); }
      catch (error) {
        console.error("Tiger Scheme license email retry deferred:", error?.message || "unknown");
      }
    }

    const { data: delivery, error: deliveryError } = await db.from("bot_license_delivery_outbox")
      .select("status").eq("order_id", orderId).maybeSingle();
    if (deliveryError) throw deliveryError;
    return json({
      status: order.status,
      paid: ["PAID", "FULFILLED"].includes(order.status),
      delivered: delivery?.status === "SENT"
    });
  } catch (error) {
    console.error("Tiger Scheme bot order status error:", error?.message || "unknown");
    return json({ error: "Could not check order status." }, 503);
  }
}
