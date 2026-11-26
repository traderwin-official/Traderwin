const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const BASE_TERMS = '("Federal Reserve" OR Fed OR ECB OR "European Central Bank" OR "Bank of Japan" OR "Bank of England" OR "interest rate" OR inflation OR CPI OR "jobs report" OR "nonfarm payrolls" OR sanctions OR tariff OR war OR invasion OR intervention)';
const INSTRUMENT_TERMS = Object.freeze({
  XAUUSD: '(gold OR bullion OR "precious metals" OR "Federal Reserve" OR "US dollar" OR inflation OR yields)',
  XAGUSD: '(silver OR bullion OR "precious metals" OR "Federal Reserve" OR "US dollar")',
  EURUSD: '(euro OR EUR OR "European Central Bank" OR ECB OR "Federal Reserve" OR USD)',
  GBPUSD: '("British pound" OR sterling OR GBP OR "Bank of England" OR BOE OR USD)',
  USDJPY: '(USD OR "US dollar" OR "Japanese yen" OR JPY OR "Bank of Japan" OR BOJ)',
  USDCHF: '(USD OR "US dollar" OR "Swiss franc" OR CHF OR "Swiss National Bank")',
  USDCAD: '(USD OR "US dollar" OR "Canadian dollar" OR CAD OR "Bank of Canada" OR oil)',
  AUDUSD: '(AUD OR "Australian dollar" OR "Reserve Bank of Australia" OR USD OR "Federal Reserve")',
  NZDUSD: '(NZD OR "New Zealand dollar" OR RBNZ OR USD OR "Federal Reserve")',
  BTCUSD: '(Bitcoin OR BTC OR cryptocurrency OR crypto regulation OR USD)',
  ETHUSD: '(Ethereum OR ETH OR cryptocurrency OR crypto regulation OR USD)'
});
const CACHE_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 20 * 60 * 1000;
const cache = new Map();
const pending = new Map();

const severeHeadline = /(emergency|surprise|unexpected|rate decision|rate hike|rate cut|inflation|consumer price|(^|[^A-Z])CPI([^A-Z]|$)|nonfarm|(^|[^A-Z])NFP([^A-Z]|$)|sanction|tariff|invasion|military strike|war|default|currency intervention|central bank)/i;

function parseSeenAt(value) {
  if (typeof value !== "string") return NaN;
  const raw = value.trim();
  const gdelt = raw.match(/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/);
  const normalized = gdelt ? `${gdelt[1]}-${gdelt[2]}-${gdelt[3]}T${gdelt[4]}:${gdelt[5]}:${gdelt[6]}Z` : raw;
  return Date.parse(normalized);
}

function parseArticles(payload, now) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  return rows.slice(0, 250).map(row => ({
    title: String(row?.title || "").trim().slice(0, 300),
    url: typeof row?.url === "string" ? row.url.slice(0, 1000) : null,
    seenAt: typeof row?.seendate === "string" ? row.seendate : null,
    seenAtMs: parseSeenAt(row?.seendate),
    domain: typeof row?.domain === "string" ? row.domain.slice(0, 120) : null
  })).filter(row => row.title && Number.isFinite(row.seenAtMs) &&
    now - row.seenAtMs >= 0 && now - row.seenAtMs <= MAX_AGE_MS);
}

/**
 * GDELT is an adverse-headline tripwire only. Search terms are scoped to the
 * selected instrument where supported. No results never means CLEAR because
 * DOC search coverage is incomplete and publication indexing may be delayed.
 */
export async function getGdeltNewsRiskStatus({
  instrument,
  now = Date.now(),
  fetchImpl = globalThis.fetch
} = {}) {
  const symbol = String(instrument || "GLOBAL").trim().toUpperCase();
  if (!Number.isFinite(now) || typeof fetchImpl !== "function") {
    return { status: "UNKNOWN", reason: "NEWS_PROVIDER_UNAVAILABLE", checkedAt: null, articles: [], instrument: symbol };
  }
  if (symbol !== "GLOBAL" && !Object.hasOwn(INSTRUMENT_TERMS, symbol)) {
    return { status: "UNKNOWN", reason: "NEWS_INSTRUMENT_NOT_MAPPED", checkedAt: null, articles: [], instrument: symbol };
  }
  const key = symbol;
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < CACHE_MS) return cached.result;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("query", symbol === "GLOBAL" ? BASE_TERMS : INSTRUMENT_TERMS[symbol]);
      url.searchParams.set("mode", "ArtList");
      url.searchParams.set("format", "json");
      url.searchParams.set("timespan", "15m");
      url.searchParams.set("maxrecords", "100");
      url.searchParams.set("sort", "DateDesc");
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (!response?.ok) return {
        status: "UNKNOWN", reason: "NEWS_PROVIDER_HTTP_ERROR", checkedAt: null, articles: [], instrument: symbol
      };
      const type = String(response.headers?.get?.("content-type") || "").toLowerCase();
      if (!type.includes("json")) return {
        status: "UNKNOWN", reason: "NEWS_PROVIDER_INVALID_CONTENT_TYPE", checkedAt: null, articles: [], instrument: symbol
      };
      const payload = await response.json();
      const articles = parseArticles(payload, now);
      const flagged = articles.filter(article => severeHeadline.test(article.title));
      const result = {
        status: flagged.length ? "BLACKOUT" : "UNKNOWN",
        reason: flagged.length ? "POTENTIAL_HIGH_IMPACT_HEADLINE" : "NEWS_CLEARANCE_NOT_ESTABLISHED",
        checkedAt: new Date(now).toISOString(),
        instrument: symbol,
        articles: flagged.slice(0, 10),
        provider: "GDELT_DOC_2_0",
        attribution: "GDELT Project — https://www.gdeltproject.org/"
      };
      cache.set(key, { fetchedAt: now, result });
      return result;
    } catch {
      return {
        status: "UNKNOWN", reason: "NEWS_PROVIDER_REQUEST_FAILED", checkedAt: null, articles: [], instrument: symbol
      };
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, request);
  return request;
}

export function resetGdeltNewsRiskCacheForTests() {
  cache.clear();
  pending.clear();
}
