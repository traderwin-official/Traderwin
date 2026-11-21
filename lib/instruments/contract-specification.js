const CURRENCIES = /^[A-Z]{3}$/;
const SYMBOL = /^[A-Za-z0-9_]{2,30}$/;
const SOURCES = new Set(["BROKER_SYMBOL_SPECIFICATION", "BROKER_CONTRACT_DETAILS"]);
const PRODUCT_TYPES = new Set(["FX_CFD", "METAL_CFD", "CRYPTO_CFD", "INDEX_CFD", "DERIV_OPTIONS"]);
const QUANTITY_UNITS = new Set(["LOTS", "CONTRACTS"]);

const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;

/**
 * Validate broker-sourced contract semantics before any sizing calculation.
 * This module is intentionally not wired to order submission. A valid
 * specification is metadata, not instrument approval or trade authorization.
 */
export function validateContractSpecification(spec, expected = {}, now = Date.now()) {
  const blocked = reason => ({ ok: false, status: "BLOCKED", reason });
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return blocked("MISSING_CONTRACT_SPECIFICATION");
  }

  const broker = typeof expected.broker === "string" ? expected.broker.toUpperCase() : "";
  const instrument = typeof expected.instrument === "string" ? expected.instrument.toUpperCase() : "";
  if (!["DERIV", "MT5"].includes(broker) || !SYMBOL.test(instrument) ||
      spec.broker !== broker || spec.instrument !== instrument ||
      !PRODUCT_TYPES.has(spec.productType) || !QUANTITY_UNITS.has(spec.quantityUnit) ||
      !CURRENCIES.test(spec.profitCurrency || "") ||
      !CURRENCIES.test(spec.quoteCurrency || "") ||
      !positive(spec.contractMultiplier) || !positive(spec.tickSize) ||
      !integer(spec.pricePrecision) || spec.pricePrecision > 12 ||
      !positive(spec.minQuantity) || !positive(spec.maxQuantity) ||
      spec.maxQuantity < spec.minQuantity || !positive(spec.quantityStep) ||
      !SOURCES.has(spec.source) || typeof spec.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(spec.verifiedAt))) {
    return blocked("INVALID_CONTRACT_SPECIFICATION");
  }

  const verifiedAtMs = Date.parse(spec.verifiedAt);\n  const maxAgeMs = Number.isSafeInteger(expected.maxAgeMs) && expected.maxAgeMs > 0\n    ? expected.maxAgeMs : 24 * 60 * 60 * 1000;\n  const ageMs = now - verifiedAtMs;\n  if (!Number.isFinite(now) || ageMs < -30_000 || ageMs > maxAgeMs) {\n    return blocked("CONTRACT_SPECIFICATION_STALE_OR_FUTURE_DATED");\n  }\n\n  const stepUnits = (spec.maxQuantity - spec.minQuantity) / spec.quantityStep;
  if (Math.abs(stepUnits - Math.round(stepUnits)) > 1e-8) {
    return blocked("INVALID_QUANTITY_STEP_RANGE");
  }

  if (spec.quantityUnit === "LOTS") {
    if (!["FX_CFD", "METAL_CFD", "CRYPTO_CFD", "INDEX_CFD"].includes(spec.productType) ||
        !positive(spec.tickValuePerLot) || !positive(spec.marginPerLot)) {
      return blocked("INCOMPLETE_CFD_LOT_SPECIFICATION");
    }
  } else if (spec.productType !== "DERIV_OPTIONS" || broker !== "DERIV") {
    return blocked("UNSUPPORTED_CONTRACT_QUANTITY_SEMANTICS");
  }

  return {
    ok: true,
    status: "SPECIFICATION_VALID",\n    ageMs,
    specification: Object.freeze({
      broker, instrument, productType: spec.productType,
      quantityUnit: spec.quantityUnit, profitCurrency: spec.profitCurrency,
      quoteCurrency: spec.quoteCurrency, contractMultiplier: spec.contractMultiplier,
      tickSize: spec.tickSize, pricePrecision: spec.pricePrecision,
      minQuantity: spec.minQuantity, maxQuantity: spec.maxQuantity,
      quantityStep: spec.quantityStep,
      ...(spec.quantityUnit === "LOTS" ? {
        tickValuePerLot: spec.tickValuePerLot,
        marginPerLot: spec.marginPerLot
      } : {}),
      source: spec.source, verifiedAt: spec.verifiedAt
    }),
    note: "Metadata validation only. It does not approve an instrument, calculate a trade size, authorize an order, or enable REAL trading."
  };
}
