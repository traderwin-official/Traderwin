import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildCheckoutPrice, fetchUsdKesRate } from "../../../lib/service-pricing.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FLW_SECRET_KEY, FLW_REDIRECT_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FLW_SECRET_KEY || !FLW_REDIRECT_URL?.startsWith("https://")) {
    return res.status(503).json({ error: "Flutterwave checkout is not configured yet." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in is required." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const serviceCode = String(body.serviceCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,40}$/.test(serviceCode)) return res.status(400).json({ error: "Choose a valid Traderwin service." });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    if (!auth.user.email) return res.status(400).json({ error: "Add and verify an email address before using card checkout." });
    const { data: service, error: serviceError } = await admin.from("service_catalog")
      .select("service_code,service_name,price_kes,price_usd,renewal_price_usd,active")
      .eq("service_code", serviceCode).eq("active", true).maybeSingle();
    if (serviceError || !service) return res.status(404).json({ error: "That Traderwin service is unavailable." });
    const { data: pending, error: pendingError } = await admin.from("payment_orders")
      .select("id").eq("user_id", auth.user.id).eq("service_code", serviceCode)
      .eq("payment_method", "FLUTTERWAVE").eq("status", "PENDING").maybeSingle();
    if (pendingError) return res.status(503).json({ error: "Could not check for an existing payment." });
    if (pending) return res.status(409).json({ error: "You already have a pending Flutterwave payment for this service. Check its status before starting another." });

    let priorPaidCount = 0, fx = null;
    if (Number(service.price_usd) > 0) {
      const { count, error } = await admin.from("payment_orders").select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id).eq("service_code", serviceCode).eq("status", "PAID");
      if (error) return res.status(503).json({ error: "Could not verify your subscription history." });
      priorPaidCount = Number(count || 0);
      try { fx = await fetchUsdKesRate(); }
      catch (error) { return res.status(503).json({ error: error.message || "A fresh exchange rate is unavailable." }); }
    }
    const pricing = buildCheckoutPrice({ service, priorPaidCount, fx });
    const txRef = `TW-FLW-${randomUUID()}`;
    const { data: order, error: orderError } = await admin.from("payment_orders").insert({
      user_id: auth.user.id, service_code: serviceCode, amount_kes: pricing.amountKes,
      amount_usd: pricing.amountUsd, fx_rate_kes: pricing.fxRateKes, fx_source: pricing.fxSource,
      fx_as_of: pricing.fxAsOf, price_basis: pricing.priceBasis, currency: "KES",
      payment_method: "FLUTTERWAVE", status: "PENDING", flutterwave_tx_ref: txRef
    }).select("id").single();
    if (orderError || !order) {
      console.error("Flutterwave order creation failed:", orderError?.message);
      return res.status(503).json({ error: "Could not create your payment order." });
    }

    const origin = new URL(FLW_REDIRECT_URL).origin;
    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef, amount: String(pricing.amountKes), currency: "KES",
        redirect_url: FLW_REDIRECT_URL,
        customer: { email: auth.user.email, name: auth.user.user_metadata?.full_name || auth.user.email },
        customizations: { title: "Traderwin", description: service.service_name },
        configurations: { session_duration: 30, max_retry_attempt: 3 },
        meta: { traderwin_order_id: order.id, service_code: serviceCode }
      }),
      signal: AbortSignal.timeout(20000)
    });
    const result = await response.json().catch(() => ({}));
    const checkoutUrl = result?.data?.link;
    if (!response.ok || result?.status !== "success" || typeof checkoutUrl !== "string" ||
        !checkoutUrl.startsWith("https://checkout.flutterwave.com/")) {
      await admin.from("payment_orders").update({ status: "FAILED" }).eq("id", order.id).eq("status", "PENDING");
      console.error("Flutterwave checkout creation rejected:", result?.message || "No hosted link returned.");
      return res.status(502).json({ error: "Flutterwave could not start checkout. Please try again." });
    }
    return res.status(200).json({
      ok: true, orderId: order.id, checkoutUrl, amountKes: pricing.amountKes,
      amountUsd: pricing.amountUsd, priceBasis: pricing.priceBasis,
      fxRateKes: pricing.fxRateKes, currency: "KES"
    });
  } catch (error) {
    console.error("Flutterwave checkout error:", error?.message || "unknown");
    return res.status(502).json({ error: error?.message || "Flutterwave checkout is temporarily unavailable." });
  }
}
