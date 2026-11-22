import { getDerivPublicMarketSnapshot } from "./public-market-snapshot.js";
import { loadApprovedInstrument } from "./load-approved-instrument.js";
import { validateDemoMarketSnapshot } from "../demo/market-snapshot-validator.js";

/**
 * Server-side coordinator: live Deriv bid/ask + exact private registry approval
 * + strict market validation. This function only returns eligibility metadata;
 * it never writes trades or grants broker execution permission.
 */
export async function loadApprovedDerivMarketSnapshot(db, instrument, options = {}) {
  const now = options.now || (() => Date.now());
  let snapshot;
  try {
    snapshot = await (options.getSnapshot || getDerivPublicMarketSnapshot)(
      instrument,
      { now, ...(options.quoteOptions ? { quoteOptions: options.quoteOptions } : {}),
        ...(options.getQuote ? { getQuote: options.getQuote } : {}) }
    );
  } catch {
    return { approved: false, valid: false, status: "BLOCKED", reason: "TRUSTED_MARKET_SNAPSHOT_UNAVAILABLE" };
  }

  const approval = await loadApprovedInstrument(db, {
    broker: "DERIV",
    instrument: snapshot.instrument,
    providerSymbol: snapshot.providerSymbol
  });
  if (!approval.approved) {
    return { approved: false, valid: false, status: "BLOCKED",
      reason: approval.reason || "INSTRUMENT_NOT_APPROVED" };
  }

  const validation = validateDemoMarketSnapshot({
    snapshot,
    expectedInstrument: snapshot.instrument,
    instrumentActive: true,
    nowEpoch: Math.floor(now() / 1000),
    maxAgeSeconds: options.maxAgeSeconds ?? 10,
    maxSpreadPct: options.maxSpreadPct ?? 0.5
  });
  if (!validation.valid) {
    return { approved: false, valid: false, status: "BLOCKED", reason: validation.reason };
  }

  return Object.freeze({
    approved: true,
    valid: true,
    status: "APPROVED_DEMO_MARKET_SNAPSHOT",
    paperOnly: true,
    approval,
    market: validation,
    providerSymbol: snapshot.providerSymbol,
    timestampEpoch: snapshot.timestampEpoch,
    note: "Instrument and quote eligibility only. Account, strategy, sizing, margin, portfolio and final pre-write checks remain mandatory."
  });
}
