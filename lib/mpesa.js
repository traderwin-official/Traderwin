export function normalizeKenyanPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

export function darajaBaseUrl(environment = process.env.MPESA_ENV) {
  return environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

export function createNairobiTimestamp(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000)
    .toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

export function buildStkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(String(shortcode) + String(passkey) + String(timestamp)).toString("base64");
}
