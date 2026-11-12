import { createClient } from "@supabase/supabase-js";

function mpesaBase() {
  return process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}
function normalizePhone(value) {
  const digits = String(value || "").replace(/\\D/g, "");
  if (/^0[17]\\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^254[17]\\d{8}$/.test(digits)) return digits;
  return null;
}
function nairobiTimestamp() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
async function getAccessToken() {
  const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET } = process.env;
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) throw new Error("M-Pesa credentials are not configured.");
  const response = await fetch(mpesaBase() + "/oauth/v1/generate?grant_type=client_credentials", {
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
    const phone = normalizePhone(body.phoneNumber);
    if (!/^[A-Z0-9_]{2,40}$/.test(serviceCode) || !phone) return res.status(400).json({ error: "Choose a valid service and Kenyan M-Pesa phone number." });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(authHeader.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    const { data: service, error: serviceError } = await admin.from("service_catalog")
      .select("service_code,service_name,price_kes,active").eq("service_code", serviceCode).eq("active", true).maybeSingle();
    if (serviceError || !service) return res.status(404).json({ error: "That Traderwin service is unavailable." });
    const amount = Number(service.price_kes);
    if (!Number.isSafeInteger(amount) || amount < 1) return res.status(409).json({ error: "This service does not have a payable KES price yet." });
    const { data: order, error: orderError } = await admin.from("payment_orders").insert({
      user_id: auth.user.id, service_code: service.service_code, amount_kes: amount,
      currency: "KES", payment_method: "MPESA", phone_number: phone, status: "PENDING"
    }).select("id").single();
    if (orderError || !order) {
      console.error("M-Pesa order creation failed:", orderError?.message);
      return res.status(503).json({ error: "Could not create the payment order." });
    }
    const timestamp = nairobiTimestamp();
    const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString("base64");
    const token = await getAccessToken();
    const stkResponse = await fetch(mpesaBase() + "/mpesa/stkpush/v1/processrequest", {
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
    return res.status(200).json({ ok: true, orderId: order.id, customerMessage: stkResult.CustomerMessage || "Check your phone and enter your M-Pesa PIN." });
  } catch (error) {
    console.error("M-Pesa STK request failed:", error.message);
    return res.status(502).json({ error: "M-Pesa checkout is temporarily unavailable." });
  }
}
