const BASE_URL = "https://biquote.io/api/calendar";
const CACHE_MS = 60_000;
const MAX_AGE_MS = 30 * 60_000;
const cache = new Map();
let pending = null;

const finite = Number.isFinite;
const normalize = value => String(value || "").trim().toUpperCase();
const currencyForCountry = Object.freeze({
  US: "USD", EU: "EUR", GB: "GBP", JP: "JPY", CH: "CHF",
  CA: "CAD", AU: "AUD", NZ: "NZD", CN: "CNY", HK: "HKD",
  SG: "SGD", TR: "TRY", ZA: "ZAR", MX: "MXN", BR: "BRL",
  IN: "INR", KR: "KRW", SE: "SEK", NO: "NOK", DK: "DKK",
  PL: "PLN", CZ: "CZK", HU: "HUF", IL: "ILS", SA: "SAR",
  AE: "AED"
});

function relevantCurrencies(instrument) {
  const symbol = normalize(instrument).replace(/[^A-Z]/g, "");
  const known = new Set(Object.values(currencyForCountry));
  const currencies = new Set(["USD"]);
  for (const currency of known) {
    if (symbol.includes(currency)) currencies.add(currency);
  }
  return currencies;
}

function eventCurrency(event) {
  const currency = normalize(event.currency);
  if (/^[A-Z]{3}$/.test(currency)) return currency;
  return currencyForCountry[normalize(event.countryCode)] || null;
}

function summarizeEvent(event) {
  return {
    name: String(event.name || "High-impact event").slice(0, 120),
    currency: eventCurrency(event),
    countryCode: normalize(event.countryCode).slice(0, 3) || null,
    time: typeof event.time === "string" ? event.time : null,
    timeMode: normalize(event.timeMode) || "UNKNOWN",
    source: String(event.source || "BiQuote calendar").slice(0, 40)
  };
}

export function evaluateBiQuoteCalendarRisk({
  events,
  instrument,
  now = Date.now(),
  beforeMinutes = 15,
  afterMinutes = 15
} = {}) {
  if (!Array.isArray(events) || events.length > 500 ||
      !finite(now) || !finite(beforeMinutes) || !finite(afterMinutes) ||
      beforeMinutes < 0 || afterMinutes < 0 ||
      beforeMinutes > 240 || afterMinutes > 240) {
    return { status: "UNKNOWN", reason: "CALENDAR_RESPONSE_INVALID", provider: "BIQUOTE", events: [] };
  }
  const currencies = relevantCurrencies(instrument);
  const matches = [];
  for (const event of events) {
    if (!event || normalize(event.importance) !== "HIGH") continue;
    const currency = eventCurrency(event);
    if (!currency || !currencies.has(currency)) continue;
    const stamp = Date.parse(event.time || "");
    if (!finite(stamp)) continue;
    const mode = normalize(event.timeMode);
    // Date-only/tentative calendar rows cannot be treated as exact timestamps.
    // For matching high-impact releases, conservatively block the entire UTC day.
    if (mode !== "EXACT") {
      const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
      if (stamp >= dayStart && stamp < dayStart + 86_400_000) matches.push(summarizeEvent(event));
      continue;
    }
    if (stamp < now - MAX_AGE_MS) continue;
    const start = stamp - beforeMinutes * 60_000;
    const end = stamp + afterMinutes * 60_000;
    if (now >= start && now <= end) matches.push(summarizeEvent(event));
  }
  if (matches.length) {
    return {
      status: "BLACKOUT",
      reason: "HIGH_IMPACT_CALENDAR_EVENT_WINDOW",
      provider: "BIQUOTE",
      indicative: true,
      events: matches.slice(0, 10)
    };
  }
  // The provider documents broad country coverage but does not publish a
  // completeness watermark; an empty result must never certify a clear window.
  return {
    status: "UNKNOWN",
    reason: "CALENDAR_CLEARANCE_NOT_ESTABLISHED",
    provider: "BIQUOTE",
    indicative: true,
    events: []
  };
}

export async function getBiQuoteCalendarRiskStatus({
  instrument,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  beforeMinutes = 15,
  afterMinutes = 15
} = {}) {
  if (!finite(now) || typeof fetchImpl !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15000) {
    return { status: "UNKNOWN", reason: "CALENDAR_REQUEST_CONFIGURATION_INVALID", provider: "BIQUOTE", events: [] };
  }
  const cacheKey = normalize(instrument);
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at >= 0 && now - cached.at < CACHE_MS) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const from = new Date(now - 60_000).toISOString();
      const to = new Date(now + 24 * 60 * 60_000).toISOString();
      const url = new URL(BASE_URL);
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      url.searchParams.set("importance", "high");
      url.searchParams.set("limit", "500");
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response?.ok || !String(response.headers?.get?.("content-type") || "").toLowerCase().includes("application/json")) {
        return { status: "UNKNOWN", reason: "CALENDAR_HTTP_OR_CONTENT_TYPE_FAILURE", provider: "BIQUOTE", events: [] };
      }
      const events = await response.json();
      const result = evaluateBiQuoteCalendarRisk({ events, instrument, now, beforeMinutes, afterMinutes });
      cache.set(cacheKey, { at: now, value: result });
      return result;
    } catch {
      return { status: "UNKNOWN", reason: "CALENDAR_REQUEST_FAILED", provider: "BIQUOTE", events: [] };
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  })();
  return pending;
}

export function resetBiQuoteCalendarRiskCacheForTests() {
  cache.clear();
  pending = null;
}
