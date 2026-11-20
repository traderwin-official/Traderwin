# Deriv active-symbol discovery

## Purpose

`GET /api/deriv/active-symbols` retrieves Deriv's public active-symbol catalogue from the server and returns normalized instrument metadata for research and future instrument-review workflows.

The endpoint is deliberately read-only. It does not:
- create or update `market_instruments` rows;
- enable an instrument for a member or bot;
- prove that the user's connected broker account can trade a symbol;
- validate contract size, tick value, margin, trading hours or execution permissions;
- submit, modify or close any order.

## Response trust and freshness

The response identifies its provider as `DERIV_PUBLIC_MARKET_DATA`, includes `fetched_at`, and sets `verified_from_provider_response: true`. This means the catalogue was parsed from a live Deriv public WebSocket response; it is not an approval for execution.

The CDN cache is intentionally short. Consumers must still treat catalogue data as discovery metadata and fetch fresh account-specific quotes and instrument specifications before any DEMO simulation. REAL execution remains separately locked behind its own authorization and safety gates.

## Failure behavior

- `405`: non-GET method.
- `503`: server WebSocket support is unavailable.
- `502`: provider connection, provider response, or catalogue validation failed.
- `504`: provider did not answer before the eight-second timeout.

Malformed and duplicate symbols are discarded by `lib/deriv/active-symbols.js`. The endpoint does not silently substitute a hard-coded catalogue when Deriv is unavailable.

## Tests

- `test/deriv-active-symbols.test.js` checks provider-field normalization, malformed records, duplicates and missing metadata.
- `test/deriv-active-symbols-api.test.js` checks the server WebSocket request, normalized response, method restriction and missing-WebSocket failure.

## Before an instrument can be enabled

A separate reviewed workflow must verify the exact broker/provider, instrument identity, quote feed, contract/tick specifications, supported order type, market availability, currency conversion, margin model and risk sizing. Only then may an administrator add or activate it in the platform's approved instrument registry. Discovery alone must never enable it.
