import { timingSafeEqual } from "node:crypto";

const API_BASE = "https://api.flutterwave.com/v3";

export function verifyFlutterwaveWebhookSignature(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || !received || !expected) return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyFlutterwaveTransaction(transactionId, secretKey, fetchImpl = globalThis.fetch) {
  if (!/^\d+$/.test(String(transactionId || ""))) throw new Error("Invalid Flutterwave transaction ID.");
  if (!secretKey) throw new Error("Flutterwave secret key is not configured.");
  const response = await fetchImpl(`${API_BASE}/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.status !== "success" || !body?.data) {
    throw new Error("Flutterwave transaction verification failed.");
  }
  return body.data;
}

export function validateFlutterwavePayment(data, order) {
  const paidAmount = Number(data?.amount);
  const expectedAmount = Number(order?.amount_kes);
  return String(data?.status || "").toLowerCase() === "successful" &&
    String(data?.tx_ref || "") === String(order?.flutterwave_tx_ref || "") &&
    String(data?.currency || "").toUpperCase() === "KES" &&
    Number.isFinite(paidAmount) && Number.isFinite(expectedAmount) &&
    paidAmount >= expectedAmount;
}
