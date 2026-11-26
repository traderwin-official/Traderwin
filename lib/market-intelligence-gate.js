import { evaluateMarketConfluence, attestMarketEvidence } from "./market-intelligence.js";

const VALID_DIRECTIONS = new Set(["BUY", "SELL", "NEUTRAL"]);
const finite = Number.isFinite;

/**
 * Runtime boundary for trusted server-side analysis candidates.
 *
 * The candidate itself is one verified adapter observation, not independent
 * corroboration. Additional evidence must be supplied only by trusted
 * server-side provider adapters; never pass browser-supplied evidence here.
 */
export function evaluateMarketCandidate({
  instrument,
  timeframe,
  direction,
  confidence,
  source,
  asOf,
  evidence = [],
  market = {},
  risk = {},
  now = Date.now(),
  maxAgeMs = 120000
} = {}) {
  const symbol = String(instrument || "").trim().toUpperCase();
  const frame = String(timeframe || "").trim().toUpperCase();
  const side = String(direction || "").trim().toUpperCase();
  const score = Number(confidence);
  const stamp = typeof asOf === "string" ? Date.parse(asOf) : NaN;
  const candidateEvidence = [];

  if (VALID_DIRECTIONS.has(side) &&
      typeof source === "string" && source.trim() &&
      finite(score) && score >= 0 && score <= 100 &&
      finite(stamp)) {
    candidateEvidence.push(attestMarketEvidence({
      category: "technical",
      direction: side,
      source: source.trim(),
      confidence: score,
      adapterVerified: true,
      instrument: symbol,
      timeframe: frame,
      asOf: new Date(stamp).toISOString(),
      detail: "Candidate from a trusted server-side market-data adapter"
    }));
  }

  const additionalEvidence = Array.isArray(evidence) ? evidence : [];
  return evaluateMarketConfluence({
    instrument: symbol,
    timeframe: frame,
    evidence: [...candidateEvidence, ...additionalEvidence],
    market,
    risk,
    now,
    maxAgeMs
  });
}
