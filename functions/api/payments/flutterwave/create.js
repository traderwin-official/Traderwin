import { createClient } from "@supabase/supabase-js";
import { buildCheckoutPrice, fetchUsdKesRate } from "../../../lib/service-pricing.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export async function onRequestPost({ request, env }) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FLW_SECRET_KEY, FLW_REDIRECT_URL
  } = env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FLW_SECRET_KEY ||
      !FLW_REDIRECT_URL?.startsWith("https://")) {
    return json({ error: "Flutterwave checkout is not configured yet." }, 503);
  }

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return json({ error: "Sign in is required." }, 401);

  try {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "A valid JSON request body is required." }, 400); }

    const serviceCode = String(body?.serviceCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,40}$/.test(serviceCode)) {
      return json({ error: "Choose a valid Tiger Scheme service." }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) return json({ error: "Your login session is invalid." }, 401);
    if (!auth.user.email) {
      return json({ error: "Add and verify an email address before using card checkout." }, 400);
    }

    const { data: service, error: serviceError } = await admin.from("service_catalog")
      .select("service_code,service_name,price_kes,price_usd,renewal_price_usd,active")
      .eq("service_code", serviceCode).eq("active", true).maybeSingle();
    if (serviceError || !service) return json({ error: "That Tiger Scheme service is unavailable." }, 404);

    const { data: pending, error: pendingError } = await admin.from("payment_orders")
      .select("id").eq("user_id", auth.user.id).eq("service_code", serviceCode)
      .eq("payment_method", "FLUTTERWAVE").eq("status", "PENDING").maybeSingle();
    if (pendingError) return json({ error: "Could not check for an existing payment." }, 503);
    if (pending) {
      return json({ error: "You already have a pending Flutterwave payment for this service. Check its status before starting another." }, 409);
    }

    let priorPaidCount = 0;
    let fx = null;
    if (Number(service.price_usd) > 0) {
      const { count, error } = await admin.from("payment_orders")
        .select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id).eq("service_code", serviceCode).eq("status", "PAID");
      if (error) return json({ error: "Could not verify your subscription history." }, 503);
      priorPaidCount = Number(count || 0);
      try { fx = await fetchUsdKesRate(fetch); }
      catch (error) { return json({ error: error.message || "A fresh exchange rate is unavailable." }, 503); }
    }

    let pricing;
    try { pricing = buildCheckoutPrice({ service, priorPaidCount, fx }); }
    catch (error) { return json({ error: error.message || "This service is not priced for checkout." }, 409); }

    const txRef = `TS-FLW-${crypto.randomUUID()}`;
    const { data: order, error: orderError } = await admin.from("payment_orders").insert({
      user_id: auth.user.id, service_code: serviceCode, amount_kes: pricing.amountKes,
      amount_usd: pricing.amountUsd, fx_rate_kes: pricing.fxRateKes, fx_source: pricing.fxSource,
      fx_as_of: pricing.fxAsOf, price_basis: pricing.priceBasis, currency: "KES",
      payment_method: "FLUTTERWAVE", status: "PENDING", flutterwave_tx_ref: txRef
    }).select("id").single();

    if (orderError || !order) {
      console.error("Flutterwave order creation failed:", orderError?.message);
      return json({ error: "Could not create your payment order." }, 503);
    }

    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef, amount: String(pricing.amountKes), currency: "KES",
        redirect_url: FLW_REDIRECT_URL,
        customer: { email: auth.user.email, name: auth.user.user_metadata?.full_name || auth.user.email },
        customizations: { title: "Tiger Scheme", description: service.service_name },
        configurations: { session_duration: 30, max_retry_attempt: 3 },
        meta: { tiger_scheme_order_id: order.id, service_code: serviceCode }
      }),
      signal: AbortSignal.timeout(20000)
    });

    const result = await response.json().catch(() => ({}));
    const checkoutUrl = result?.data?.link;
    if (!response.ok || result?.status !== "success" ||
        typeof checkoutUrl !== "string" || !checkoutUrl.startsWith("https://checkout.flutterwave.com/")) {
      await admin.from("payment_orders").update({ status: "FAILED" })
        .eq("id", order.id).eq("status", "PENDING");
      console.error("Flutterwave checkout creation rejected:", result?.message || "No hosted link returned.");
      return json({ error: "Flutterwave could not start checkout. Please try again." }, 502);
    }

    return json({
      ok: true, orderId: order.id, checkoutUrl, amountKes: pricing.amountKes,
      amountUsd: pricing.amountUsd, priceBasis: pricing.priceBasis,
      fxRateKes: pricing.fxRateKes, currency: "KES"
    });
  } catch (error) {
    console.error("Tiger Scheme Flutterwave checkout error:", error?.message || "unknown");
    return json({ error: "Flutterwave checkout is temporarily unavailable." }, 502);
  }
}
