import { createClient } from "@supabase/supabase-js";
import {
  darajaBaseUrl, createNairobiTimestamp, buildStkPassword, normalizeKenyanPhone
} from "../../../../lib/mpesa.js";
import {
  createLicenseKey, hashLicenseKey, encryptLicenseKey, deliverPendingBotLicenseEmails
} from "../../../../lib/standalone-bot-licenses.js";
import { json, enforceRateLimit, getClientIp } from "../../../../lib/cloudflare-mpesa.js";

function metadataItems(callback) {
  const items = callback?.CallbackMetadata?.Item;
  return Array.isArray(items) ? Object.fromEntries(items.map((item) => [item.Name, item.Value])) : {};
}

async function verifyDarajaCheckout(checkoutId, env) {
  const base = darajaBaseUrl(env.DARAJA_ENV);
  const auth = await fetch(base + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: {
      Authorization: "Basic " + Buffer.from(
        env.DARAJA_CONSUMER_KEY + ":" + env.DARAJA_CONSUMER_SECRET
      ).toString("base64")
    },
    signal: AbortSignal.timeout(12000)
  });
  const tokenData = await auth.json().catch(() => ({}));
  if (!auth.ok || !tokenData.access_token) throw new Error("Daraja OAuth failed.");

  const timestamp = createNairobiTimestamp();
  const password = buildStkPassword(env.DARAJA_SHORTCODE, env.DARAJA_PASSKEY, timestamp);
  const response = await fetch(base + "/mpesa/stkpushquery/v1/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + tokenData.access_token, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: env.DARAJA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutId
    }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  return response.ok &&
    String(data.ResultCode) === "0" &&
    String(data.CheckoutRequestID || "") === checkoutId;
}

async function updateOrderStatus(db, table, orderId, status, allowedStatuses) {
  const { error } = await db.from(table).update({ status })
    .eq("id", orderId).in("status", allowedStatuses);
  if (error) throw error;
}

export async function onRequestPost({ request, env }) {
  if (request.method !== "POST") {
    return json({ ResultCode: 1, ResultDesc: "Method not allowed" }, 405, { Allow: "POST" });
  }

  const required = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DARAJA_SHORTCODE",
    "DARAJA_PASSKEY", "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET"
  ];
  if (required.some((key) => !env[key])) {
    return json({ ResultCode: 1, ResultDesc: "Payment callback is not configured" }, 503);
  }

  const rate = await enforceRateLimit({
    env, request, scope: "mpesa-callback-ip", key: getClientIp(request), limit: 60, windowSeconds: 60
  });
  if (!rate.ok) return rate.response;

  try {
    let body;
    try { body = await request.json(); }
    catch { return json({ ResultCode: 0, ResultDesc: "Invalid callback acknowledged" }); }

    const callback = body?.Body?.stkCallback;
    const checkoutId = String(callback?.CheckoutRequestID || "");
    if (!checkoutId) return json({ ResultCode: 0, ResultDesc: "Callback acknowledged" });

    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: botOrder, error: botError } = await db.from("bot_license_orders")
      .select("id,product_code,amount_kes,customer_phone,payment_phone,status")
      .eq("mpesa_checkout_request_id", checkoutId).maybeSingle();
    if (botError) throw botError;

    let serviceOrder = null;
    if (!botOrder) {
      const { data, error } = await db.from("payment_orders")
        .select("id,user_id,service_code,amount_kes,phone_number,status")
        .eq("checkout_request_id", checkoutId).maybeSingle();
      if (error) throw error;
      serviceOrder = data;
    }

    const order = botOrder || serviceOrder;
    if (!order) {
      // Daraja may call back before the checkout reference update is committed.
      // Ask it to retry rather than silently acknowledging an order we cannot yet match.
      return json(
        { ResultCode: 1, ResultDesc: "Checkout reference is not available yet; retry later" },
        503,
        { "Retry-After": "5" }
      );
    }
    if (order.status === "FULFILLED" || order.status === "PAID") {
      return json({ ResultCode: 0, ResultDesc: "Already processed" });
    }

    const table = botOrder ? "bot_license_orders" : "payment_orders";
    const allowedStatuses = botOrder
      ? ["PENDING_PAYMENT", "PAYMENT_PROCESSING", "PAYMENT_REVIEW"]
      : ["PENDING", "PAYMENT_REVIEW"];

    if (Number(callback?.ResultCode) !== 0) {
      await updateOrderStatus(
        db, table, order.id, botOrder ? "PAYMENT_FAILED" : "FAILED", allowedStatuses
      );
      return json({ ResultCode: 0, ResultDesc: "Failed payment recorded" });
    }

    const meta = metadataItems(callback);
    const amount = Number(meta.Amount);
    const receipt = String(meta.MpesaReceiptNumber || "").trim();
    const paidPhone = normalizeKenyanPhone(meta.PhoneNumber);
    const expectedPhone = normalizeKenyanPhone(
      botOrder ? (order.payment_phone || order.customer_phone) : order.phone_number
    );

    if (!receipt || !Number.isFinite(amount) || amount !== Number(order.amount_kes) ||
        !paidPhone || !expectedPhone || paidPhone !== expectedPhone) {
      await updateOrderStatus(db, table, order.id, "PAYMENT_REVIEW", allowedStatuses);
      return json({ ResultCode: 0, ResultDesc: "Payment requires reconciliation" });
    }

    const verified = await verifyDarajaCheckout(checkoutId, env);
    if (!verified) {
      await updateOrderStatus(db, table, order.id, "PAYMENT_REVIEW", allowedStatuses);
      return json({ ResultCode: 0, ResultDesc: "Payment verification pending" });
    }

    if (botOrder) {
      const licenseKey = createLicenseKey();
      const encryptedKey = encryptLicenseKey(licenseKey, env);
      const { data: fulfillment, error: fulfillmentError } = await db.rpc(
        "fulfill_standalone_bot_order",
        {
          p_order_id: order.id,
          p_receipt: receipt,
          p_amount: amount,
          p_phone: paidPhone,
          p_license_key_hash: hashLicenseKey(licenseKey),
          p_encrypted_license_key: encryptedKey
        }
      );
      if (fulfillmentError) throw fulfillmentError;
      try { await deliverPendingBotLicenseEmails({ orderId: order.id, limit: 1, env }); }
      catch (error) {
        console.error("Tiger Scheme license email deferred:", error?.message || "unknown");
      }
      return json({
        ResultCode: 0,
        ResultDesc: fulfillment?.status === "FULFILLED"
          ? "Standalone bot payment fulfilled" : "Standalone bot payment already fulfilled"
      });
    }

    const { data: fulfillment, error: fulfillmentError } = await db.rpc(
      "fulfill_traderwin_service_payment",
      { p_order_id: order.id, p_receipt: receipt, p_amount: amount, p_phone: paidPhone }
    );
    if (fulfillmentError) {
      console.error("Tiger Scheme service payment fulfillment failed:", fulfillmentError.message);
      await updateOrderStatus(db, "payment_orders", order.id, "PAYMENT_REVIEW", ["PENDING", "PAYMENT_REVIEW"]);
      return json({ ResultCode: 0, ResultDesc: "Payment verified; service activation needs reconciliation" });
    }
    return json({
      ResultCode: 0,
      ResultDesc: fulfillment?.status === "PAID"
        ? "Payment confirmed and service activated" : "Payment already processed"
    });
  } catch (error) {
    console.error("Tiger Scheme unified M-Pesa callback error:", error?.message || "unknown");
    return json({ ResultCode: 0, ResultDesc: "Callback acknowledged; payment may require reconciliation" });
  }
}
