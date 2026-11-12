import { createClient } from "@supabase/supabase-js";
import { normalizeKenyanPhone, darajaBaseUrl, createNairobiTimestamp, buildStkPassword } from "../../../lib/mpesa.js";
import { buildCheckoutPrice, fetchUsdKesRate } from "../../../lib/service-pricing.js";

async function getAccessToken() {
  const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET } = process.env;
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) throw new Error("M-Pesa credentials are not configured.");
  const response = await fetch(darajaBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + Buffer.from(MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET).toString("base64") },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("M-Pesa authentication failed.");
  return data.access_token;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MPESA_SHORTCODE || !MPESA_PASSKEY || !MPESA_CALLBACK_URL) {
    return res.status(503).json({ error: "M-Pesa checkout is not configured yet." });
  }
  if (!MPESA_CALLBACK_URL.startsWith("https://")) return res.status(503).json({ error: "A secure HTTPS M-Pesa callback URL is required." });
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in is required." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const serviceCode = String(body.serviceCode || "").trim().toUpperCase();
    const phone = normalizeKenyanPhone(body.phoneNumber);
    if (!/^[A-Z0-9_]{2,40}$/.test(serviceCode) || !phone) return res.status(400).json({ error: "Choose a valid service and Kenyan M-Pesa phone number." });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(authHeader.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    const { data: service, error: serviceError } = await admin.from("service_catalog")
      .select("service_code,service_name,price_kes,price_usd,renewal_price_usd,active").eq("service_code", serviceCode).eq("active", true).maybeSingle();
    if (serviceError || !service) return res.status(404).json({ error: "That Traderwin service is unavailable." });
    let priorPaidCount = 0;
    let fx = null;
    if (Number(service.price_usd) > 0) {
      const { count, error: historyError } = await admin.from("payment_orders")
        .select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id).eq("service_code", service.service_code).eq("status", "PAID");
      if (historyError) return res.status(503).json({ error: "Could not verify your subscription purchase history." });
      priorPaidCount = Number(count || 0);
      try { fx = await fetchUsdKesRate(); }
      catch (error) { return res.status(503).json({ error: error.message || "A fresh USD/KES rate is unavailable." }); }
    }
    let pricing;
    try { pricing = buildCheckoutPrice({ service, priorPaidCount, fx }); }
    catch (error) { return res.status(409).json({ error: error.message || "This service is not priced for checkout." }); }
    const amount = pricing.amountKes;
    const { data: order, error: orderError } = await admin.from("payment_orders").insert({
      user_id: auth.user.id, service_code: service.service_code, amount_kes: amount,
      amount_usd: pricing.amountUsd, fx_rate_kes: pricing.fxRateKes,
      fx_source: pricing.fxSource, fx_as_of: pricing.fxAsOf, price_basis: pricing.priceBasis,
      currency: "KES", payment_method: "MPESA", phone_number: phone, status: "PENDING"
    }).select("id").single();
    if (orderError || !order) {
      console.error("M-Pesa order creation failed:", orderError?.message);
      return res.status(503).json({ error: "Could not create the payment order." });
    }
    const timestamp = createNairobiTimestamp();
    const password = buildStkPassword(MPESA_SHORTCODE, MPESA_PASSKEY, timestamp);
    const token = await getAccessToken();
    const stkResponse = await fetch(darajaBaseUrl() + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
        TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
        Amount: amount, PartyA: phone, PartyB: MPESA_SHORTCODE, PhoneNumber: phone,
        CallBackURL: MPESA_CALLBACK_URL, AccountReference: "Traderwin",
        TransactionDesc: service.service_name.slice(0, 50)
      }),
      signal: AbortSignal.timeout(20000)
    });
    const stkResult = await stkResponse.json().catch(() => ({}));
    if (!stkResponse.ok || !stkResult.CheckoutRequestID) {
      await admin.from("payment_orders").update({ status: "FAILED" }).eq("id", order.id).eq("status", "PENDING");
      console.error("M-Pesa STK request rejected:", stkResult.errorMessage || stkResult.ResponseDescription || "Unknown error");
      return res.status(502).json({ error: "M-Pesa could not start the payment prompt. Please try again." });
    }
    const { error: updateError } = await admin.from("payment_orders")
      .update({ checkout_request_id: stkResult.CheckoutRequestID }).eq("id", order.id).eq("status", "PENDING");
    if (updateError) {
      console.error("Could not save M-Pesa checkout reference:", updateError.message);
      return res.status(503).json({ error: "Payment prompt started, but Traderwin could not save its reference. Contact support before retrying." });
    }
    return res.status(200).json({ ok: true, orderId: order.id, amountKes: amount, amountUsd: pricing.amountUsd, priceBasis: pricing.priceBasis, fxRateKes: pricing.fxRateKes, customerMessage: stkResult.CustomerMessage || "Check your phone and enter your M-Pesa PIN." });
  } catch (error) {
    console.error("M-Pesa STK request failed:", error.message);
    return res.status(502).json({ error: "M-Pesa checkout is temporarily unavailable." });
  }
}
