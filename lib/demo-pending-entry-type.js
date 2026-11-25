// Derive pending-order semantics from a fresh server-verified market quote.
// Returns null when the side is invalid, values are invalid, or market equals entry.
export function detectDemoPendingEntryType(direction, marketPrice, entryPrice) {
  const side = String(direction || "").trim().toUpperCase();
  const market = Number(marketPrice);
  const entry = Number(entryPrice);
  if (!["BUY", "SELL"].includes(side) || !Number.isFinite(market) || !Number.isFinite(entry)
      || market <= 0 || entry <= 0 || market === entry) return null;
  if (side === "BUY") return market > entry ? "LIMIT" : "STOP";
  return market < entry ? "LIMIT" : "STOP";
}
