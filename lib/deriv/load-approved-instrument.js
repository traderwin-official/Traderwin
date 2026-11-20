import { resolveApprovedInstrument } from "./instrument-approval.js";

const normalise = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");

/**
 * Load one approved instrument from the private server-side registry.
 * Any lookup error, missing row, ambiguity, disabled row or symbol mismatch
 * blocks the caller. Never use provider discovery as an approval source.
 */
export async function loadApprovedInstrument(db, { broker, instrument, providerSymbol } = {}) {
  const brokerName = String(broker || "").trim().toUpperCase();
  const symbol = normalise(instrument);
  if (!db || !symbol || !providerSymbol) {
    return { approved: false, status: "BLOCKED", reason: "INVALID_APPROVAL_LOOKUP" };
  }

  let response;
  try {
    response = await db
      .from("trading_instrument_approvals")
      .select("broker,instrument,provider,provider_symbol,status,is_active,approved_by,approved_at")
      .eq("broker", brokerName)
      .eq("instrument", symbol)
      .limit(2);
  } catch {
    return { approved: false, status: "BLOCKED", reason: "INSTRUMENT_APPROVAL_LOOKUP_FAILED" };
  }
  if (response?.error || !Array.isArray(response?.data)) {
    return { approved: false, status: "BLOCKED", reason: "INSTRUMENT_APPROVAL_LOOKUP_FAILED" };
  }

  const result = resolveApprovedInstrument({
    records: response.data,
    broker: brokerName,
    instrument: symbol,
    providerSymbol
  });
  return result.approved
    ? result
    : { ...result, reason: result.reason || "INSTRUMENT_NOT_APPROVED" };
}
