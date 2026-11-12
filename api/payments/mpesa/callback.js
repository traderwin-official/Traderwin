import { createClient } from "@supabase/supabase-js";
import { darajaBaseUrl, createNairobiTimestamp, buildStkPassword } from "../../../lib/mpesa.js";
function darajaBaseUrl() { return process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke"; }
function createNairobiTimestamp() { return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14); }
async function getAccessToken() {
  const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET } = process.env;
  const response = await fetch(darajaBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + Buffer.from(MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET).toString("base64") },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("M-Pesa authentication failed.");
  return data.access_token;
}
function metadataItems(callback) {
  const items = callback?.CallbackMetadata?.Item;
  return Array.isArray(items) ? Object.fromEntries(items.map(x => [x.Name, x.Value])) : {};
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ ResultCode: 1, ResultDesc: "Method not allowed" }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MPESA_SHORTCODE || !MPESA_PASSKEY || !MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
    return res.status(503).json({ ResultCode: 1, ResultDesc: "Callback configuration unavailable" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const callback = body?.Body?.stkCallback;
    const checkoutId = callback?.CheckoutRequestID;
    if (!checkoutId) return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback received" });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: order, error: orderError } = await admin.from("payment_orders")
      .select("id,user_id,service_code,amount_kes,phone_number,status").eq("checkout_request_id", checkoutId).maybeSingle();
    if (orderError || !order || order.status !== "PENDING") return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback acknowledged" });
    // The public callback is not trusted by itself. Verify the checkout with Daraja.
    const timestamp = createNairobiTimestamp();
    const password = buildStkPassword(MPESA_SHORTCODE, MPESA_PASSKEY, timestamp);
    const token = await getAccessToken();
    const verifyResponse = await fetch(darajaBaseUrl() + "/mpesa/stkpushquery/v1/query", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutId }),
      signal: AbortSignal.timeout(15000)
    });
    const verification = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || String(verification.ResultCode) !== "0") {
      console.warn("M-Pesa callback received; provider verification is not yet successful.");
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback acknowledged; verification pending" });
    }
    if (String(callback.ResultCode) !== "0") {
      await admin.from("payment_orders").update({ status: "FAILED" }).eq("id", order.id).eq("status", "PENDING");
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Payment result recorded" });
    }
    const items = metadataItems(callback);
    const callbackAmount = Number(items.Amount);
    const callbackPhone = String(items.PhoneNumber || "");
    const receipt = String(items.MpesaReceiptNumber || "");
    if (!receipt || callbackAmount !== Number(order.amount_kes) || callbackPhone !== String(order.phone_number)) {
      console.error("M-Pesa callback metadata did not match the pending order.");
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback acknowledged for manual review" });
    }
    const { data: paidOrder, error: updateError } = await admin.from("payment_orders").update({
      status: "PAID", provider_reference: receipt, confirmed_at: new Date().toISOString()
    }).eq("id", order.id).eq("status", "PENDING")
      .select("id,user_id,service_code").maybeSingle();
    if (updateError) {
      console.error("Verified M-Pesa payment could not be recorded:", updateError.message);
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Verified payment received; recording pending" });
    }
    if (paidOrder) {
      const { data: service, error: serviceError } = await admin.from("service_catalog")
        .select("billing_period").eq("service_code", paidOrder.service_code).maybeSingle();
      if (serviceError || !service) {
        console.error("Paid service entitlement could not be resolved:", serviceError?.message || "Service missing");
      } else {
        const startsAt = new Date();
        const endsAt = new Date(startsAt);
        if (service.billing_period === "MONTHLY") endsAt.setMonth(endsAt.getMonth() + 1);
        else if (service.billing_period === "YEARLY") endsAt.setFullYear(endsAt.getFullYear() + 1);
        else endsAt.setTime(0);
        const { error: entitlementError } = await admin.from("user_subscriptions").upsert({
          user_id: paidOrder.user_id,
          service_code: paidOrder.service_code,
          status: "ACTIVE",
          starts_at: startsAt.toISOString(),
          ends_at: service.billing_period === "ONE_TIME" ? null : endsAt.toISOString(),
          payment_order_id: paidOrder.id
        }, { onConflict: "user_id,service_code" });
        if (entitlementError) {
          console.error("Paid service entitlement activation failed:", entitlementError.message);
        }
      }
    }
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Payment verification completed" });
  } catch (error) {
    console.error("M-Pesa callback processing failed:", error.message);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback received; verification pending" });
  }
}
