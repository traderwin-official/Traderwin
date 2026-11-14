import { createClient } from "@supabase/supabase-js";
import { darajaBaseUrl } from "../../lib/mpesa.js";
import { json, enforceRateLimit, getClientIp } from "../../lib/cloudflare-mpesa.js";

const clean = (value, max = 160) => String(value ?? "").trim().slice(0, max);
const emailOk = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function normalizePhone(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return "254" + digits;
  return null;
}

function nairobiTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + values.month + values.day + values.hour + values.minute + values.second;
}

async function darajaToken(env) {
  const key = env.DARAJA_CONSUMER_KEY;
  const secret = env.DARAJA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error("Daraja credentials are missing.");
  const base = darajaBaseUrl(env.DARAJA_ENV);
  const response = await fetch(base + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64") },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("Daraja OAuth failed.");
  return { base, token: data.access_token };
}

export async function onRequestGet({ env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Bot shop is not configured yet." }, 503);
  }
  try {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await db.from("bot_products")
      .select("product_code,product_name,broker,license_type,price_kes,currency,description")
      .eq("active", true).not("price_kes", "is", null).order("broker").order("price_kes");
    if (error) throw error;
    return json({
      products: data || [],
      checkoutMode: "MPESA_STK_PUSH",
      message: "Standalone purchases do not require a Tiger Scheme member account."
    });
  } catch (error) {
    console.error("Tiger Scheme bot catalog failed:", error?.message || "unknown");
    return json({ error: "The bot catalog is temporarily unavailable." }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  const required = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DARAJA_CONSUMER_KEY",
    "DARAJA_CONSUMER_SECRET", "DARAJA_PASSKEY", "DARAJA_SHORTCODE",
    "DARAJA_CALLBACK_URL", "BOT_LICENSE_ENCRYPTION_KEY"
  ];
  if (required.some((key) => !env[key])) {
    return json({ error: "Automatic M-Pesa checkout is not configured yet." }, 503);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.BOT_LICENSE_ENCRYPTION_KEY)) {
    return json({ error: "Secure license delivery is not configured yet." }, 503);
  }
  let callbackUrl;
  try { callbackUrl = new URL(env.DARAJA_CALLBACK_URL); }
  catch { return json({ error: "The secure M-Pesa callback URL is not configured." }, 503); }
  if (callbackUrl.protocol !== "https:" ||
      callbackUrl.pathname !== "/api/payments/mpesa/bot-shop-callback") {
    return json({ error: "The secure M-Pesa callback URL must point to the Tiger Scheme unified callback." }, 503);
  }

  const rate = await enforceRateLimit({
    env, request, scope: "standalone-bot-checkout-ip", key: getClientIp(request),
    limit: 3, windowSeconds: 60
  });
  if (!rate.ok) return rate.response;

  try {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "A valid JSON request body is required." }, 400); }

    const productCode = clean(body?.productCode, 50).toUpperCase();
    const name = clean(body?.name, 100);
    const email = clean(body?.email, 180).toLowerCase();
    const phone = normalizePhone(body?.phone);
    const mt5Login = clean(body?.mt5Login, 40);
    const mt5Server = clean(body?.mt5Server, 100);
    if (!/^[A-Z0-9_]{3,50}$/.test(productCode) || name.length < 2 ||
        !emailOk(email) || !phone) {
      return json({ error: "Enter your name, valid email, Kenyan M-Pesa phone and choose a product." }, 400);
    }

    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: product, error: productError } = await db.from("bot_products")
      .select("product_code,product_name,broker,license_type,price_kes,currency")
      .eq("product_code", productCode).eq("active", true)
      .not("price_kes", "is", null).maybeSingle();
    if (productError) throw productError;
    if (!product) return json({ error: "This bot is not available for purchase yet." }, 404);
    if (!Number.isSafeInteger(Number(product.price_kes)) || Number(product.price_kes) < 1) {
      return json({ error: "This product price must be a whole number of KSh." }, 409);
    }
    if (product.broker === "MT5" &&
        ((mt5Login && !/^\d{4,20}$/.test(mt5Login)) || (mt5Server && mt5Server.length < 2))) {
      return json({ error: "Check the optional MT5 account number and broker server." }, 400);
    }

    const { data: pendingOrder, error: pendingError } = await db.from("bot_license_orders")
      .select("id").eq("product_code", product.product_code).eq("customer_phone", phone)
      .in("status", ["PENDING_PAYMENT", "PAYMENT_PROCESSING", "PAYMENT_REVIEW"])
      .limit(1).maybeSingle();
    if (pendingError) throw pendingError;
    if (pendingOrder) {
      return json({ error: "You already have an unfinished order for this product and phone number. Check its status before starting another." }, 409);
    }

    const { data: order, error: orderError } = await db.from("bot_license_orders").insert({
      product_code: product.product_code,
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
      mt5_login: mt5Login || null,
      mt5_server: mt5Server || null,
      amount_kes: Number(product.price_kes),
      status: "PENDING_PAYMENT",
      payment_phone: phone
    }).select("id,amount_kes,status,created_at").single();
    if (orderError || !order) throw orderError || new Error("No order returned.");

    try {
      const { base, token } = await darajaToken(env);
      const timestamp = nairobiTimestamp();
      const password = Buffer.from(
        env.DARAJA_SHORTCODE + env.DARAJA_PASSKEY + timestamp
      ).toString("base64");
      const transactionType = env.DARAJA_TRANSACTION_TYPE === "CustomerBuyGoodsOnline"
        ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";
      const payload = {
        BusinessShortCode: env.DARAJA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: transactionType,
        Amount: Number(product.price_kes),
        PartyA: phone,
        PartyB: env.DARAJA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: env.DARAJA_CALLBACK_URL,
        AccountReference: "TS" + order.id.replace(/-/g, "").slice(0, 10).toUpperCase(),
        TransactionDesc: "Tiger Scheme " + product.product_code
      };
      const response = await fetch(base + "/mpesa/stkpush/v1/processrequest", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || String(result.ResponseCode) !== "0" || !result.CheckoutRequestID) {
        throw new Error(result.errorMessage || result.ResponseDescription || "STK push was not accepted.");
      }

      const { error: updateError } = await db.from("bot_license_orders").update({
        status: "PAYMENT_PROCESSING",
        mpesa_checkout_request_id: result.CheckoutRequestID,
        mpesa_merchant_request_id: result.MerchantRequestID || null
      }).eq("id", order.id).eq("status", "PENDING_PAYMENT");
      if (updateError) throw updateError;

      return json({
        ok: true,
        orderId: order.id,
        status: "PAYMENT_PROCESSING",
        message: "M-Pesa prompt sent. Enter your M-Pesa PIN to complete payment. Your license will be emailed automatically after payment is confirmed."
      }, 202);
    } catch (paymentError) {
      await db.from("bot_license_orders").update({
        status: "PAYMENT_REVIEW",
        admin_note: "STK initiation requires reconciliation: " +
          String(paymentError?.message || "unknown").slice(0, 220)
      }).eq("id", order.id).in("status", ["PENDING_PAYMENT", "PAYMENT_PROCESSING"]);
      console.error("Tiger Scheme Daraja STK initiation error:", paymentError?.message || "unknown");
      return json({
        error: "We could not confirm the M-Pesa prompt. No license has been issued. Check the order status or contact support before retrying."
      }, 502);
    }
  } catch (error) {
    console.error("Tiger Scheme bot shop checkout error:", error?.message || "unknown");
    return json({ error: "The bot shop could not complete checkout. Please try again later." }, 503);
  }
}
