import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDerivContractsForResponse,
  buildDerivProposalRequest,
  normalizeDerivProposalResponse
} from "../lib/deriv/options-contract-adapter.js";

const symbol = "R_50";
const catalogue = {
  msg_type: "contracts_for",
  echo_req: { contracts_for: symbol },
  contracts_for: { available: [{
    underlying_symbol: symbol, contract_type: "CALL", barriers: 0,
    contract_category: "callput", expiry_type: "intraday", market: "synthetic_index",
    submarket: "random_index", sentiment: "up", min_contract_duration: "5",
    max_contract_duration: "86400"
  }, {
    underlying_symbol: symbol, contract_type: "MULTUP", barriers: 0,
    contract_category: "multiplier", expiry_type: "intraday", market: "synthetic_index",
    submarket: "random_index", sentiment: "up", min_contract_duration: "1",
    max_contract_duration: "86400", min_stake: 0.35, max_stake: 1000
  }]}
};
const now = 1_800_000_000_000;
const proposalPayload = (request, overrides = {}) => ({
  msg_type: "proposal",
  req_id: request.req_id,
  echo_req: { ...request },
  proposal: {
    id: "proposal-id-not-for-browser",
    ask_price: 2.5,
    date_start: 1_800_000_000,
    date_expiry: 1_800_000_060,
    longcode: "Win if the contract condition is met.",
    payout: 4.2,
    spot: 1234.5,
    spot_time: 1_800_000_000,
    contract_details: { minimum_stake: "0.35", maximum_stake: "1000.00" },
    ...overrides
  }
});

test("normalizes only matching provider contract catalogue rows", () => {
  const result = normalizeDerivContractsForResponse(catalogue, symbol);
  assert.equal(result.ok, true);
  assert.equal(result.contracts.length, 2);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.contracts[1].minStake, 0.35);
  assert.equal(normalizeDerivContractsForResponse(catalogue, "R_25").ok, false);
  const duplicate = structuredClone(catalogue);
  duplicate.contracts_for.available.push(duplicate.contracts_for.available[0]);
  assert.equal(normalizeDerivContractsForResponse(duplicate, symbol).reason, "DERIV_CONTRACT_METADATA_INVALID");
});

test("builds a proposal request only for a catalogue-listed contract and valid stake basis", () => {
  const metadata = normalizeDerivContractsForResponse(catalogue, symbol);
  const built = buildDerivProposalRequest({
    metadata, symbol, contractType: "CALL", currency: "USD",
    amount: 1, basis: "stake", duration: 5, durationUnit: "m"
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.request, {
    proposal: 1, contract_type: "CALL", currency: "USD",
    underlying_symbol: symbol, amount: 1, basis: "stake",
    duration: 5, duration_unit: "m", req_id: 8301
  });
  assert.equal(buildDerivProposalRequest({
    metadata, symbol, contractType: "PUT", currency: "USD",
    amount: 1, basis: "stake", duration: 5
  }).reason, "DERIV_CONTRACT_NOT_IN_PROVIDER_CATALOGUE");
  assert.equal(buildDerivProposalRequest({
    metadata, symbol, contractType: "CALL", currency: "USD",
    amount: 1, basis: "quantity", duration: 5
  }).ok, false);
});

test("enforces provider barrier count and syntax", () => {
  const metadata = normalizeDerivContractsForResponse({
    msg_type: "contracts_for", echo_req: { contracts_for: symbol },
    contracts_for: { available: [{
      underlying_symbol: symbol, contract_type: "HIGHER", barriers: 1,
      contract_category: "callput", expiry_type: "intraday", market: "synthetic_index",
      submarket: "random_index", sentiment: "up", min_contract_duration: "5",
      max_contract_duration: "86400"
    }] }
  }, symbol);
  assert.equal(buildDerivProposalRequest({
    metadata, symbol, contractType: "HIGHER", currency: "USD",
    amount: 1, basis: "stake", duration: 5
  }).reason, "DERIV_CONTRACT_REQUIRES_ONE_VALID_BARRIER");
  assert.equal(buildDerivProposalRequest({
    metadata, symbol, contractType: "HIGHER", currency: "USD",
    amount: 1, basis: "stake", duration: 5, barrier: "+0.5"
  }).ok, true);
});

test("validates fresh proposal against exact request and exposes stake limits without sizing authorization", () => {
  const metadata = normalizeDerivContractsForResponse(catalogue, symbol);
  const built = buildDerivProposalRequest({
    metadata, symbol, contractType: "CALL", currency: "USD",
    amount: 1, basis: "stake", duration: 5, durationUnit: "m"
  });
  const result = normalizeDerivProposalResponse(proposalPayload(built.request), built.request, { now: () => now });
  assert.equal(result.ok, true);
  assert.equal(result.askPrice, 2.5);
  assert.deepEqual(result.stakeLimits, { min: 0.35, max: 1000, source: "contract_details" });
  assert.equal(result.stakeWithinProviderLimits, true);
  assert.equal(result.sizingAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.proposalKind, "ONE_TIME_READ_ONLY");
  assert.equal(result.proposalUsableForBuy, false);
  assert.equal("proposalId" in result, false);
  const wrongRequestId = proposalPayload(built.request);
  wrongRequestId.req_id = 9999;
  assert.equal(normalizeDerivProposalResponse(wrongRequestId, built.request, { now: () => now }).reason,
    "DERIV_PROPOSAL_RESPONSE_INVALID_OR_MISMATCHED");
});

test("blocks mismatched, stale, malformed or contradictory proposal data", () => {
  const metadata = normalizeDerivContractsForResponse(catalogue, symbol);
  const built = buildDerivProposalRequest({
    metadata, symbol, contractType: "CALL", currency: "USD",
    amount: 1, basis: "stake", duration: 5, durationUnit: "m"
  });
  const request = built.request;
  const mismatched = proposalPayload(request);
  mismatched.echo_req.currency = "EUR";
  assert.equal(normalizeDerivProposalResponse(mismatched, request, { now: () => now }).ok, false);
  assert.equal(normalizeDerivProposalResponse(proposalPayload(request, { spot_time: 1_799_999_900 }), request, { now: () => now }).reason, "DERIV_PROPOSAL_SPOT_STALE");
  assert.equal(normalizeDerivProposalResponse(proposalPayload(request, { ask_price: "2.5" }), request, { now: () => now }).ok, false);
  assert.equal(normalizeDerivProposalResponse(proposalPayload(request, {
    validation_params: { stake: { min: "0.50", max: "1000" } }
  }), request, { now: () => now }).reason, "DERIV_PROPOSAL_STAKE_LIMITS_INVALID");
});

test("does not authorize sizing when proposal contains no stake bounds", () => {
  const metadata = normalizeDerivContractsForResponse(catalogue, symbol);
  const built = buildDerivProposalRequest({
    metadata, symbol, contractType: "CALL", currency: "USD",
    amount: 1, basis: "payout", duration: 5, durationUnit: "m"
  });
  const result = normalizeDerivProposalResponse(proposalPayload(built.request, {
    contract_details: undefined
  }), built.request, { now: () => now });
  assert.equal(result.ok, true);
  assert.equal(result.stakeLimits, null);
  assert.equal(result.stakeWithinProviderLimits, false);
  assert.equal(result.sizingAuthorized, false);
});
