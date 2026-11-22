# Broker contract specification safety boundary

## Current status

This change adds a pure validation boundary only. It is not connected to the instrument approval registry, DEMO worker, risk sizing, broker adapters, or order submission. No instrument is activated by this validator.

## Required metadata

A broker-provided specification must identify the exact broker and instrument, product type, quantity unit, profit and quote currencies, contract multiplier, tick size, price precision, minimum/maximum quantity, quantity step, source, and verification timestamp.

CFD instruments measured in lots additionally require broker-sourced tick value per lot and margin per lot. Deriv options are represented as contracts, never as CFD lots; their contract catalogue/duration data is not a substitute for tick value, margin, or CFD sizing metadata.

## Fail-closed rules

- Missing, malformed, mismatched, or unsupported metadata is blocked.
- Quantity bounds must align exactly to the declared quantity step.
- Currency identifiers are ISO-style three-letter codes; unsupported settlement currencies are not guessed or silently converted.
- No fallback contract multiplier, tick value, margin, lot size, spread, or precision is supplied.
- A valid specification is metadata validation only. Instrument approval, fresh quote validation, account verification, risk checks, explicit user consent, and mode authorization remain independent gates.

## Not enabled

No live broker order path, REAL trading, automated position sizing, instrument auto-approval, or production database change is introduced by this module. Future integration requires broker-specific fixtures and independent tests for every product type and currency conversion path.
