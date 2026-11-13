import { createClient } from "@supabase/supabase-js";
import { verifyFlutterwaveTransaction, validateFlutterwavePayment } from "../../../lib/flutterwave.js";

async function completePayment(admin, txRef, transactionId) {
  const { FLW_SECRET_KEY } = process.env;
  if (!FLW_SECRET_KEY) throw new Error("Flutterwave secret key is not configured.");
  const { data: order, error } = await admin.from("payment_orders")
    .select("id,user_id,service_code,amount_kes,currency,status,flutterwave_tx_ref,flutterwave_transaction_id")
    .eq("flutterwave_tx_ref", txRef).maybeSingle();
  if (error) throw error;
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (order.status === "PAID") return { ok: true, status: "ALREADY_PAID" };
  const verified = await verifyFlutterwaveTransaction(transactionId, FLW_SECRET_KEY);
  if ((order.flutterwave_transaction_id && String(order.flutterwave_transaction_id) !== String(transactionId)) ||
      !validateFlutterwavePayment(verified, order) || String(verified.id) !== String(transactionId)) {
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
    console.error("Flutterwave service fulfillment failed:", fulfilError.message);
    await admin.from("payment_orders").update({ status: "PAYMENT_REVIEW" })
      .eq("id", order.id).neq("status", "PAID");
    return { ok: false, reason: "FULFILLMENT_REQUIRES_REVIEW" };
  }
  return { ok: true, status: data?.status || "PAID" };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: "Payment verification is not configured." });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  if (req.method === "POST") {
    const expected = process.env.FLW_SECRET_HASH || "";
    const received = req.headers["verif-hash"];
    const { verifyFlutterwaveWebhookSignature } = await import("../../../lib/flutterwave.js");
    if (!verifyFlutterwaveWebhookSignature(received, expected)) return res.status(401).json({ error: "Invalid webhook signature." });
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const event = body?.event || body?.type;
      const txRef = body?.data?.tx_ref;
      const transactionId = body?.data?.id;
      if (event !== "charge.completed" || !txRef || !transactionId) return res.status(200).json({ received: true, ignored: true });
      const result = await completePayment(admin, String(txRef), String(transactionId));
      return res.status(200).json({ received: true, result });
    } catch (error) {
      console.error("Flutterwave webhook processing error:", error?.message || "unknown");
      return res.status(200).json({ received: true, reviewRequired: true });
    }
  }

  const txRef = String(req.query?.tx_ref || "");
  const transactionId = String(req.query?.transaction_id || "");
  if (!txRef || !/^\d+$/.test(transactionId)) return res.status(400).json({ error: "Missing payment reference." });
  try {
    const result = await completePayment(admin, txRef, transactionId);
    const base = process.env.PUBLIC_APP_URL || new URL(req.url, "https://traderwin-naq2.vercel.app").origin;
    const status = result.ok ? "success" : "pending";
    return res.redirect(303, `${base}/?payment=${status}&provider=flutterwave`);
  } catch (error) {
    console.error("Flutterwave return verification error:", error?.message || "unknown");
    const base = process.env.PUBLIC_APP_URL || "https://traderwin-naq2.vercel.app";
    return res.redirect(303, `${base}/?payment=pending&provider=flutterwave`);
  }
}
