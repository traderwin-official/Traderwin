import { createClient } from "@supabase/supabase-js";
import {
  normalizeKenyanPhone,
  darajaBaseUrl,
  createNairobiTimestamp,
  buildStkPassword
} from "../../../../lib/mpesa.js";
import { buildCheckoutPrice, fetchUsdKesRate } from "../../../../lib/service-pricing.js";
import { json, enforceRateLimit, getClientIp, bearerToken } from "../../../../lib/cloudflare-mpesa.js";

async function getAccessToken(env) {
  const key = env.DARAJA_CONSUMER_KEY;
  const secret = env.DARAJA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error("Daraja credentials are not configured.");
  const response = await fetch(darajaBaseUrl(env.DARAJA_ENV) + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64") },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("M-Pesa authentication failed.");
  return data.access_token;
}

export async function onRequestPost({ request, env }) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { Allow: "POST" });

  const required = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DARAJA_SHORTCODE",
    "DARAJA_PASSKEY", "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET",
    "DARAJA_CALLBACK_URL"
  ];
  if (required.some((key) => !env[key])) {
    return json({ error: "M-Pesa checkout is not configured yet." }, 503);
  }
  let callbackUrl;
  try { callbackUrl = new URL(env.DARAJA_CALLBACK_URL); }
  catch { return json({ error: "A secure HTTPS M-Pesa callback URL is required." }, 503); }
  if (callbackUrl.protocol !== "https:" ||
      callbackUrl.pathname !== "/api/payments/mpesa/bot-shop-callback") {
    return json({ error: "The secure M-Pesa callback URL must point to the Tiger Scheme unified callback." }, 503);
  }

  const accessToken = bearerToken(request);
  if (!accessToken) return json({ error: "Sign in is required." }, 401);

  try {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "A valid JSON request body is required." }, 400); }

    const serviceCode = String(body?.serviceCode || "").trim().toUpperCase();
    const phone = normalizeKenyanPhone(body?.phoneNumber);
    if (!/^[A-Z0-9_]{2,40}$/.test(serviceCode) || !phone) {
      return json({ error: "Choose a valid service and Kenyan M-Pesa phone number." }, 400);
    }

    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(accessToken);
    if (authError || !auth.user) return json({ error: "Your login session is invalid." }, 401);

    const userLimit = await enforceRateLimit({
      env, request, scope: "member-checkout-user", key: auth.user.id, limit: 3, windowSeconds: 60
    });
    if (!userLimit.ok) return userLimit.response;
    const ipLimit = await enforceRateLimit({
      env, request, scope: "member-checkout-ip", key: getClientIp(request), limit: 10, windowSeconds: 60
    });
    if (!ipLimit.ok) return ipLimit.response;

    const { data: service, error: serviceError } = await admin.from("service_catalog")
      .select("service_code,service_name,price_kes,price_usd,renewal_price_usd,active")
      .eq("service_code", serviceCode).eq("active", true).maybeSingle();
    if (serviceError) {
      console.error("M-Pesa service lookup failed:", serviceError.message);
      return json({ error: "Could not load this service for checkout." }, 503);
    }
    if (!service) return json({ error: "That Tiger Scheme service is unavailable." }, 404);

    const { data: pendingOrder, error: pendingError } = await admin.from("payment_orders")
      .select("id").eq("user_id", auth.user.id).eq("service_code", service.service_code)
      .eq("status", "PENDING").limit(1).maybeSingle();
    if (pendingError) return json({ error: "Could not check an existing payment request." }, 503);
    if (pendingOrder) {
      return json({ error: "You already have a pending payment for this service. Check its status before starting another." }, 409);
    }

    let priorPaidCount = 0;
    let fx = null;
    if (Number(service.price_usd) > 0) {
      const { count, error: historyError } = await admin.from("payment_orders")
        .select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id).eq("service_code", service.service_code).eq("status", "PAID");
      if (historyError) return json({ error: "Could not verify your subscription purchase history." }, 503);
      priorPaidCount = Number(count || 0);
      try { fx = await fetchUsdKesRate(fetch); }
      catch (error) {
        return json({ error: error.message || "A fresh USD/KES rate is unavailable." }, 503);
      }
    }

    let pricing;
    try { pricing = buildCheckoutPrice({ service, priorPaidCount, fx }); }
    catch (error) { return json({ error: error.message || "This service is not priced for checkout." }, 409); }

    const { data: order, error: orderError } = await admin.from("payment_orders").insert({
      user_id: auth.user.id,
      service_code: service.service_code,
      amount_kes: pricing.amountKes,
      amount_usd: pricing.amountUsd,
      fx_rate_kes: pricing.fxRateKes,
      fx_source: pricing.fxSource,
      fx_as_of: pricing.fxAsOf,
      price_basis: pricing.priceBasis,
      currency: "KES",
      payment_method: "MPESA",
      phone_number: phone,
      status: "PENDING"
    }).select("id").single();

    if (orderError || !order) {
      console.error("M-Pesa order creation failed:", orderError?.message || "No order returned");
      return json({ error: "Could not create the payment order." }, 503);
    }

    try {
      const timestamp = createNairobiTimestamp();
      const password = buildStkPassword(env.DARAJA_SHORTCODE, env.DARAJA_PASSKEY, timestamp);
      const token = await getAccessToken(env);
      const stkResponse = await fetch(darajaBaseUrl(env.DARAJA_ENV) + "/mpesa/stkpush/v1/processrequest", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: env.DARAJA_SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: env.DARAJA_TRANSACTION_TYPE === "CustomerBuyGoodsOnline"
            ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
          Amount: pricing.amountKes,
          PartyA: phone,
          PartyB: env.DARAJA_SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: env.DARAJA_CALLBACK_URL,
          AccountReference: "TS" + order.id.replace(/-/g, "").slice(0, 10).toUpperCase(),
          TransactionDesc: String(service.service_name || "Tiger Scheme service").slice(0, 50)
        }),
        signal: AbortSignal.timeout(20000)
      });
      const result = await stkResponse.json().catch(() => ({}));
      if (!stkResponse.ok || !result.CheckoutRequestID) {
        await admin.from("payment_orders").update({ status: "FAILED" })
          .eq("id", order.id).eq("status", "PENDING");
        console.error("M-Pesa STK request rejected:", result.errorMessage || result.ResponseDescription || "Unknown error");
        return json({ error: "M-Pesa could not start the payment prompt. Please try again." }, 502);
      }

      const { error: updateError } = await admin.from("payment_orders")
        .update({ checkout_request_id: result.CheckoutRequestID })
        .eq("id", order.id).eq("status", "PENDING");
      if (updateError) {
        await admin.from("payment_orders").update({ status: "PAYMENT_REVIEW" })
          .eq("id", order.id).eq("status", "PENDING");
        console.error("Could not save M-Pesa checkout reference:", updateError.message);
        return json({ error: "Payment prompt started, but its reference could not be saved. Contact support before retrying." }, 503);
      }

      return json({
        ok: true,
        orderId: order.id,
        amountKes: pricing.amountKes,
        amountUsd: pricing.amountUsd,
        priceBasis: pricing.priceBasis,
        fxRateKes: pricing.fxRateKes,
        customerMessage: result.CustomerMessage || "Check your phone and enter your M-Pesa PIN."
      });
    } catch (error) {
      await admin.from("payment_orders").update({ status: "PAYMENT_REVIEW" })
        .eq("id", order.id).eq("status", "PENDING");
      console.error("M-Pesa STK request failed:", error?.message || "unknown");
      return json({ error: "M-Pesa checkout is temporarily unavailable. Check your payment status before retrying." }, 502);
    }
  } catch (error) {
    console.error("Tiger Scheme M-Pesa checkout error:", error?.message || "unknown");
    return json({ error: "M-Pesa checkout is temporarily unavailable." }, 502);
  }
}
