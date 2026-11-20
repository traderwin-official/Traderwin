import { getDerivPublicQuote } from "../deriv-public-quote.js";

const normalise = value => String(value || "").trim().toUpperCase().replace(/[\\s/.-]/g, "");

/**
 * Convert an actual Deriv tick into the strict bid/ask snapshot contract.
 * Missing, malformed, crossed or stale sides fail closed. No spread is
 * inferred from quote, midpoint, candle data, or any other field.
 */
export async function getDerivPublicMarketSnapshot(instrument, options = {}) {
  const getQuote = options.getQuote || getDerivPublicQuote;
  const now = options.now || (() => Date.now());
  const expected = normalise(instrument);
  if (!expected) throw new Error("A valid instrument is required for a market snapshot.");

  const tick = await getQuote(instrument, options.quoteOptions || {});
  const timestampEpoch = Date.parse(tick?.quoteAsOf) / 1000;
  const bid = tick?.bid;
  const ask = tick?.ask;
  if (tick?.source !== "DERIV" || normalise(tick?.instrument) !== expected ||
      typeof tick?.providerSymbol !== "string" || !tick.providerSymbol ||
      !Number.isFinite(timestampEpoch) || !Number.isFinite(bid) ||
      !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid ||
      tick.bidAsOf !== tick.quoteAsOf || tick.askAsOf !== tick.quoteAsOf) {
    throw new Error("Deriv did not provide a valid same-tick bid/ask snapshot; new entries remain blocked.");
  }
  const ageSeconds = (now() - timestampEpoch * 1000) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < -5 || ageSeconds > 30) {
    throw new Error("Deriv bid/ask snapshot is stale or has an invalid timestamp.");
  }

  return Object.freeze({
    instrument: expected,
    providerSymbol: tick.providerSymbol,
    provider: "DERIV_SERVER_ADAPTER",
    dataStatus: "LIVE",
    bid,
    ask,
    bidTimestampEpoch: timestampEpoch,
    askTimestampEpoch: timestampEpoch,
    timestampEpoch,
    receivedAt: tick.receivedAt,
    source: "DERIV",
    isTrusted: true
  });
}
