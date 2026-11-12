const RATE_URL = "https://open.er-api.com/v6/latest/USD";

export async function fetchUsdKesRate(fetchImpl = globalThis.fetch, now = () => Date.now()) {
  if (typeof fetchImpl !== "function") throw new Error("Exchange-rate service is unavailable.");
  const response = await fetchImpl(RATE_URL, { signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => ({}));
  const rate = Number(data?.rates?.KES);
  const asOfMs = Number(data?.time_last_update_unix) * 1000;
  if (!response.ok || data?.result !== "success" || !Number.isFinite(rate) ||
      rate < 1 || rate > 1000 || !Number.isFinite(asOfMs) ||
      asOfMs > now() + 5 * 60 * 1000 || now() - asOfMs > 48 * 60 * 60 * 1000) {
    throw new Error("A fresh USD/KES exchange rate is unavailable. No payment request was created.");
  }
  return {
    rate,
    source: "open.er-api.com",
    asOf: new Date(asOfMs).toISOString()
  };
}

export function buildCheckoutPrice({ service, priorPaidCount = 0, fx = null }) {
  if (!service || service.active !== true) throw new Error("This Traderwin service is not available.");
  const firstUsd = Number(service.price_usd);
  if (Number.isFinite(firstUsd) && firstUsd > 0) {
    const renewalUsd = Number(service.renewal_price_usd);
    const isRenewal = Number(priorPaidCount) > 0;
    const amountUsd = isRenewal ? renewalUsd : firstUsd;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !fx ||
        !Number.isFinite(Number(fx.rate)) || Number(fx.rate) <= 0) {
      throw new Error("This service's USD price or exchange rate is not configured.");
    }
    return {
      amountUsd,
      amountKes: Math.ceil(amountUsd * Number(fx.rate)),
      fxRateKes: Number(fx.rate),
      fxSource: fx.source,
      fxAsOf: fx.asOf,
      priceBasis: isRenewal ? "RENEWAL" : "FIRST_MONTH"
    };
  }

  const amountKes = Number(service.price_kes);
  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    throw new Error("This service does not have a payable price yet.");
  }
  return {
    amountUsd: null,
    amountKes,
    fxRateKes: null,
    fxSource: null,
    fxAsOf: null,
    priceBasis: "FIXED_KES"
  };
}
