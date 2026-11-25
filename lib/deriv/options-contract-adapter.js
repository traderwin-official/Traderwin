const SYMBOL = /^[A-Za-z0-9_]{2,30}$/;
const CONTRACT_TYPE = /^[A-Z]{3,24}$/;
const CURRENCY = /^[A-Za-z0-9]{2,20}$/;
const BARRIER = /^(?=.{1,20}$)[+-]?[0-9]+\.?[0-9]*$/;

const finitePositive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const finiteNonNegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const numericString = value => typeof value === "string" && value.trim() !== "" &&
  Number.isFinite(Number(value)) && Number(value) >= 0;

function blocked(reason) {
  return Object.freeze({ ok: false, status: "BLOCKED", reason });
}

/**
 * Normalize provider contracts_for metadata. Metadata is descriptive only:
 * it does not approve an instrument or authorize an order.
 */
export function normalizeDerivContractsForResponse(payload, expectedSymbol) {
  if (typeof expectedSymbol !== "string" || !SYMBOL.test(expectedSymbol) ||
      payload?.msg_type !== "contracts_for" ||
      payload?.echo_req?.contracts_for !== expectedSymbol ||
      !Array.isArray(payload?.contracts_for?.available) ||
      payload.contracts_for.available.length === 0) {
    return blocked("DERIV_CONTRACT_CATALOGUE_INVALID");
  }

  const seen = new Set();
  const contracts = [];
  for (const item of payload.contracts_for.available) {
    if (!item || item.underlying_symbol !== expectedSymbol ||
        typeof item.contract_type !== "string" || !CONTRACT_TYPE.test(item.contract_type) ||
        seen.has(item.contract_type) ||
        ![0, 1, 2].includes(item.barriers) ||
        typeof item.contract_category !== "string" || !item.contract_category ||
        typeof item.expiry_type !== "string" || !item.expiry_type ||
        typeof item.market !== "string" || !item.market ||
        typeof item.submarket !== "string" || !item.submarket ||
        typeof item.sentiment !== "string" || !item.sentiment ||
        typeof item.min_contract_duration !== "string" || !item.min_contract_duration ||
        typeof item.max_contract_duration !== "string" || !item.max_contract_duration) {
      return blocked("DERIV_CONTRACT_METADATA_INVALID");
    }
    if (item.max_stake !== undefined && item.max_stake !== null && !finitePositive(item.max_stake)) {
      return blocked("DERIV_CONTRACT_MAX_STAKE_INVALID");
    }
    if (item.min_stake !== undefined && item.min_stake !== null && !finitePositive(item.min_stake)) {
      return blocked("DERIV_CONTRACT_MIN_STAKE_INVALID");
    }
    if (item.min_stake != null && item.max_stake != null && item.min_stake > item.max_stake) {
      return blocked("DERIV_CONTRACT_STAKE_RANGE_INVALID");
    }
    seen.add(item.contract_type);
    contracts.push(Object.freeze({
      symbol: expectedSymbol,
      contractType: item.contract_type,
      category: item.contract_category,
      market: item.market,
      submarket: item.submarket,
      sentiment: item.sentiment,
      expiryType: item.expiry_type,
      minDurationProviderValue: item.min_contract_duration,
      maxDurationProviderValue: item.max_contract_duration,
      barriers: item.barriers,
      minStake: item.min_stake ?? null,
      maxStake: item.max_stake ?? null,
      payoutLimit: finitePositive(item.payout_limit) ? item.payout_limit : null,
      growthRateRange: Array.isArray(item.growth_rate_range) ? item.growth_rate_range.slice() : null,
      multiplierRange: Array.isArray(item.multiplier_range) ? item.multiplier_range.slice() : null,
      payoutChoices: Array.isArray(item.payout_choices) ? item.payout_choices.slice() : null
    }));
  }
  return Object.freeze({
    ok: true,
    status: "DERIV_CONTRACT_METADATA_READ_ONLY",
    symbol: expectedSymbol,
    contracts: Object.freeze(contracts),
    executionAuthorized: false
  });
}

/**
 * Build a schema-constrained proposal request from provider metadata.
 * This only prices a hypothetical contract; it never buys or opens it.
 */
export function buildDerivProposalRequest({
  metadata, symbol, contractType, currency, amount, basis,
  duration, durationUnit = "s", barrier, barrier2, reqId = 8301
}) {
  if (!metadata?.ok || metadata.status !== "DERIV_CONTRACT_METADATA_READ_ONLY" ||
      metadata.symbol !== symbol || !Array.isArray(metadata.contracts) ||
      !SYMBOL.test(String(symbol || "")) ||
      typeof contractType !== "string" || !CONTRACT_TYPE.test(contractType) ||
      typeof currency !== "string" || !CURRENCY.test(currency) ||
      !finitePositive(amount) || !["stake", "payout"].includes(basis) ||
      !Number.isSafeInteger(duration) || duration <= 0 ||
      !["s", "m", "h", "d", "t"].includes(durationUnit) ||
      !Number.isSafeInteger(reqId) || reqId < 1) {
    return blocked("DERIV_PROPOSAL_REQUEST_INVALID");
  }
  const contract = metadata.contracts.find(item => item.contractType === contractType);
  if (!contract || contract.symbol !== symbol) {
    return blocked("DERIV_CONTRACT_NOT_IN_PROVIDER_CATALOGUE");
  }
  if (contract.barriers === 0 && (barrier !== undefined || barrier2 !== undefined)) {
    return blocked("DERIV_CONTRACT_BARRIER_NOT_ALLOWED");
  }
  if (contract.barriers === 1 && (typeof barrier !== "string" || !BARRIER.test(barrier) || barrier2 !== undefined)) {
    return blocked("DERIV_CONTRACT_REQUIRES_ONE_VALID_BARRIER");
  }
  if (contract.barriers === 2 && (typeof barrier !== "string" || !BARRIER.test(barrier) ||
      typeof barrier2 !== "string" || !BARRIER.test(barrier2))) {
    return blocked("DERIV_CONTRACT_REQUIRES_TWO_VALID_BARRIERS");
  }

  const request = {
    proposal: 1,
    contract_type: contractType,
    currency,
    underlying_symbol: symbol,
    amount,
    basis,
    duration,
    duration_unit: durationUnit,
    req_id: reqId
  };
  if (contract.barriers >= 1) request.barrier = barrier;
  if (contract.barriers === 2) request.barrier2 = barrier2;
  return Object.freeze({
    ok: true,
    status: "DERIV_PROPOSAL_REQUEST_READY_READ_ONLY",
    request: Object.freeze(request),
    contractMetadata: contract,
    executionAuthorized: false
  });
}

function readStakeLimits(proposal) {
  const details = proposal?.contract_details || {};
  const validation = proposal?.validation_params?.stake || {};
  const detailPair = details.minimum_stake != null || details.maximum_stake != null;
  const validationPair = validation.min != null || validation.max != null;
  const topPair = proposal?.min_stake != null || proposal?.max_stake != null;
  const pairs = [];
  if (detailPair) pairs.push([details.minimum_stake, details.maximum_stake, "contract_details"]);
  if (validationPair) pairs.push([validation.min, validation.max, "validation_params.stake"]);
  if (topPair) pairs.push([proposal.min_stake, proposal.max_stake, "proposal"]);
  if (pairs.length === 0) return { available: false, min: null, max: null, source: null };
  for (const [min, max] of pairs) {
    const validMin = typeof min === "number" ? finitePositive(min) : numericString(min) && Number(min) > 0;
    const validMax = typeof max === "number" ? finitePositive(max) : numericString(max) && Number(max) > 0;
    if (!validMin || !validMax || Number(min) > Number(max)) {
      return { invalid: true };
    }
  }
  const canonical = pairs[0];
  for (const pair of pairs.slice(1)) {
    if (Number(pair[0]) !== Number(canonical[0]) || Number(pair[1]) !== Number(canonical[1])) {
      return { invalid: true };
    }
  }
  return {
    available: true,
    min: Number(canonical[0]),
    max: Number(canonical[1]),
    source: pairs.map(pair => pair[2]).join("+")
  };
}

/**
 * Validate a fresh proposal response against the exact request. Provider quote
 * is informational only. Missing stake limits means sizing is NOT authorized.
 */
export function normalizeDerivProposalResponse(payload, expectedRequest, options = {}) {
  const now = options.now || (() => Date.now());
  const maxSpotAgeSeconds = options.maxSpotAgeSeconds ?? 10;
  const response = payload?.proposal;
  const echo = payload?.echo_req;
  const expectedKeys = ["proposal", "contract_type", "currency", "underlying_symbol",
    "amount", "basis", "duration", "duration_unit", "req_id"];
  if (payload?.msg_type !== "proposal" || payload?.req_id !== expectedRequest?.req_id || !response || typeof response.id !== "string" ||
      !response.id || typeof response.longcode !== "string" || !response.longcode ||
      !expectedRequest || expectedRequest.proposal !== 1 ||
      expectedKeys.some(key => echo?.[key] !== expectedRequest[key]) ||
      !finitePositive(response.ask_price) || !finiteNonNegative(response.payout) ||
      !finitePositive(response.spot) || !Number.isSafeInteger(response.spot_time) ||
      !Number.isSafeInteger(response.date_start) || !Number.isSafeInteger(response.date_expiry) ||
      response.date_expiry <= response.date_start) {
    return blocked("DERIV_PROPOSAL_RESPONSE_INVALID_OR_MISMATCHED");
  }
  const age = now() / 1000 - response.spot_time;
  if (!Number.isFinite(age) || age < -2 || age > maxSpotAgeSeconds) {
    return blocked("DERIV_PROPOSAL_SPOT_STALE");
  }
  const stakeLimits = readStakeLimits(response);
  if (stakeLimits.invalid) return blocked("DERIV_PROPOSAL_STAKE_LIMITS_INVALID");
  const amount = expectedRequest.amount;
  const amountIsStake = expectedRequest.basis === "stake";
  const sizingWithinLimits = stakeLimits.available && amountIsStake &&
    amount >= stakeLimits.min && amount <= stakeLimits.max;
  return Object.freeze({
    ok: true,
    status: "DERIV_PROPOSAL_VALIDATED_READ_ONLY",
    proposalKind: "ONE_TIME_READ_ONLY",
    proposalUsableForBuy: false,
    symbol: expectedRequest.underlying_symbol,
    contractType: expectedRequest.contract_type,
    currency: expectedRequest.currency,
    requestedAmount: amount,
    amountBasis: expectedRequest.basis,
    askPrice: response.ask_price,
    payout: response.payout,
    spot: response.spot,
    spotTime: response.spot_time,
    dateStart: response.date_start,
    dateExpiry: response.date_expiry,
    longcode: response.longcode,
    stakeLimits: stakeLimits.available ? Object.freeze({
      min: stakeLimits.min, max: stakeLimits.max, source: stakeLimits.source
    }) : null,
    stakeWithinProviderLimits: sizingWithinLimits,
    sizingAuthorized: false,
    proposalIdRetainedServerSideOnly: true,
    executionAuthorized: false
  });
}
