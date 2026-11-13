import { createClient } from "@supabase/supabase-js";
import {
  verifyFlutterwaveTransaction,
  validateFlutterwavePayment,
  verifyFlutterwaveWebhookSignature
} from "../../../../lib/flutterwave.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

async function completePayment(admin, env, txRef, transactionId) {
  const { FLW_SECRET_KEY } = env;
  if (!FLW_SECRET_KEY) throw new Error("Flutterwave secret key is not configured.");

  const { data: order, error } = await admin.from("payment_orders")
    .select("id,user_id,service_code,amount_kes,currency,status,flutterwave_tx_ref,flutterwave_transaction_id")
    .eq("flutterwave_tx_ref", txRef).maybeSingle();
  if (error) throw error;
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (order.status === "PAID") return { ok: true, status: "ALREADY_PAID" };

  const verified = await verifyFlutterwaveTransaction(transactionId, FLW_SECRET_KEY);
  if ((order.flutterwave_transaction_id &&
       String(order.flutterwave_transaction_id) !== String(transactionId)) ||
      !validateFlutterwavePayment(verified, order) ||
      String(verified.id) !== String(transactionId)) {
    await admin.from("payment_orders").update({ status: "PAYMENT_REVIEW" })
      .eq("id", order.id).eq("status", "PENDING");
    return { ok: false, reason: "PAYMENT_REQUIRES_REVIEW" };
  }

  const { error: saveError } = await admin.from("payment_orders").update({
    flutterwave_transaction_id: String(transactionId),
    payment_verified_at: new Date().toISOString()
  }).eq("id", order.id).in("status", ["PENDING", "PAYMENT_REVIEW"]);
  if (saveError) throw saveError;

  const { data, error: fulfilError } = await admin.rpc("fulfill_traderwin_service_payment", {
    p_order_id: order.id, p_receipt: `FLW-${transactionId}`,
    p_amount: Number(verified.amount), p_phone: null
  });
  if (fulfilError) {
    console.error("Tiger Scheme Flutterwave fulfillment failed:", fulfilError.message);
    await admin.from("payment_orders").update({ status: "PAYMENT_REVIEW" })
      .eq("id", order.id).neq("status", "PAID");
    return { ok: false, reason: "FULFILLMENT_REQUIRES_REVIEW" };
  }
  return { ok: true, status: data?.status || "PAID" };
}

export async function onRequestPost({ request, env }) {
  const expected = env.FLW_SECRET_HASH || "";
  const received = request.headers.get("verif-hash") || "";
  if (!verifyFlutterwaveWebhookSignature(received, expected)) {
    return json({ error: "Invalid webhook signature." }, 401);
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Payment verification is not configured." }, 503);
  }

  try {
    const body = await request.json();
    const event = body?.event || body?.type;
    const txRef = body?.data?.tx_ref;
    const transactionId = body?.data?.id;
    if (event !== "charge.completed" || !txRef || !/^\d+$/.test(String(transactionId || ""))) {
      return json({ received: true, ignored: true });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const result = await completePayment(admin, env, String(txRef), String(transactionId));
    return json({ received: true, result });
  } catch (error) {
    console.error("Tiger Scheme Flutterwave webhook processing error:", error?.message || "unknown");
    return json({ received: true, reviewRequired: true });
  }
}

export async function onRequestGet({ request, env }) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
  const url = new URL(request.url);
  const txRef = String(url.searchParams.get("tx_ref") || "");
  const transactionId = String(url.searchParams.get("transaction_id") || "");
  if (!txRef || !/^\d+$/.test(transactionId)) {
    return json({ error: "Missing payment reference." }, 400);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Payment verification is not configured." }, 503);
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const result = await completePayment(admin, env, txRef, transactionId);
    const base = env.PUBLIC_APP_URL || url.origin;
    const destination = new URL("/", base);
    destination.searchParams.set("payment", result.ok ? "success" : "pending");
    destination.searchParams.set("provider", "flutterwave");
    return Response.redirect(destination.toString(), 303);
  } catch (error) {
    console.error("Tiger Scheme Flutterwave return verification error:", error?.message || "unknown");
    const base = env.PUBLIC_APP_URL || url.origin;
    const destination = new URL("/", base);
    destination.searchParams.set("payment", "pending");
    destination.searchParams.set("provider", "flutterwave");
    return Response.redirect(destination.toString(), 303);
  }
}
