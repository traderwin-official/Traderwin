import { getDerivPublicQuote } from "./deriv-public-quote.js";

const INVERSE_USD_PAIRS = new Set(["JPY", "CAD", "CHF"]);
const finite = Number.isFinite;

/**
 * Return the USD value of one unit of an instrument's quote currency.
 * DEMO P&L is stored in USD; non-USD quote currencies require a fresh
 * Deriv conversion quote. Unsupported conversions fail closed.
 */
export async function getDerivQuoteToUsd(instrument, instrumentQuote, options = {}) {
  const symbol = String(instrument || "").trim().toUpperCase().replace(/[\s/.-]/g, "");
  if (!/^[A-Z]{6}$/.test(symbol)) {
    throw new RangeError("USD-normalized DEMO P&L is not verified for this instrument.");
  }
  if (!instrumentQuote || instrumentQuote.source !== "DERIV" ||
      String(instrumentQuote.instrument || "").trim().toUpperCase().replace(/[\s/.-]/g, "") !== symbol ||
      typeof instrumentQuote.providerSymbol !== "string" || !instrumentQuote.providerSymbol.trim() ||
      !finite(instrumentQuote.quote) || instrumentQuote.quote <= 0) {
    throw new RangeError("A verified instrument quote is required for USD conversion.");
  }

  const now = options.now || (() => Date.now());
  const instrumentAsOf = Date.parse(instrumentQuote.quoteAsOf);
  if (!finite(instrumentAsOf) || now() - instrumentAsOf < 0 || now() - instrumentAsOf > 30000) {
    throw new RangeError("The instrument quote is stale for USD conversion.");
  }

  const quoteCurrency = symbol.slice(-3);
  if (quoteCurrency === "USD") {
    return { rate: 1, source: "USD_QUOTED_INSTRUMENT", instrument: "USD", asOf: instrumentQuote.quoteAsOf };
  }

  const inverse = INVERSE_USD_PAIRS.has(quoteCurrency);
  const conversionSymbol = inverse ? "USD" + quoteCurrency : quoteCurrency + "USD";
  const getQuote = options.getQuote || getDerivPublicQuote;
  const conversion = conversionSymbol === symbol
    ? instrumentQuote
    : await getQuote(conversionSymbol);

  const conversionAsOf = Date.parse(conversion.quoteAsOf);
  if (conversion.source !== "DERIV" ||
      String(conversion.instrument || "").trim().toUpperCase().replace(/[\s/.-]/g, "") !== conversionSymbol ||
      typeof conversion.providerSymbol !== "string" || !conversion.providerSymbol.trim() ||
      !finite(conversion.quote) || conversion.quote <= 0 ||
      !finite(conversionAsOf) || now() - conversionAsOf < 0 || now() - conversionAsOf > 30000 ||
      Math.abs(instrumentAsOf - conversionAsOf) > 30000) {
    throw new RangeError("A fresh, matching USD conversion quote is unavailable.");
  }

  const rate = inverse ? 1 / conversion.quote : conversion.quote;
  if (!finite(rate) || rate <= 0 || rate > 1e6) {
    throw new RangeError("The USD conversion rate is outside safe limits.");
  }
  return {
    rate,
    source: "DERIV_FX_CONVERSION",
    instrument: conversionSymbol,
    asOf: conversion.quoteAsOf
  };
}
