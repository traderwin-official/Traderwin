const TERMS = Object.freeze({
  XAUUSD: '"gold" OR "Federal Reserve" OR "US dollar" OR inflation',
  XAGUSD: '"silver" OR "Federal Reserve" OR "US dollar"',
  EURUSD: '"euro" OR "European Central Bank" OR "Federal Reserve"',
  GBPUSD: '"British pound" OR "Bank of England" OR "Federal Reserve"',
  USDJPY: '"Japanese yen" OR "Bank of Japan" OR "Federal Reserve"',
  AUDUSD: '"Australian dollar" OR RBA OR "Federal Reserve"',
  USDCAD: '"Canadian dollar" OR "Bank of Canada" OR oil',
  USDCHF: '"Swiss franc" OR "Swiss National Bank" OR "Federal Reserve"',
  NZDUSD: '"New Zealand dollar" OR RBNZ OR "Federal Reserve"',
  BTCUSD: 'Bitcoin OR BTC OR cryptocurrency',
  ETHUSD: 'Ethereum OR ETH OR cryptocurrency'
});
const NEGATIVE = /war|attack|missile|invasion|sanction|default|crisis|crash|collapse|emergency|bank failure|recession|rate hike|hawkish|inflation surge|lawsuit|ban|hack|exploit/i;
const POSITIVE = /ceasefire|peace deal|rate cut|dovish|disinflation|recovery|growth accelerat|record demand|approval|adoption|upgrade/i;
const safeDate = value => {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) return null;
  const iso = value.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * GDELT is a headline-discovery source, not an economic calendar or a
 * verified market-impact feed. Results are contextual only and never clear
 * the platform's news blackout gate.
 */
export async function getGdeltNewsContext(instrument, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 4500,
  maxRecords = 8
} = {}) {
  const symbol = String(instrument || "").trim().toUpperCase();
  const terms = TERMS[symbol];
  if (!terms) return unavailable("INSTRUMENT_NOT_MAPPED");
  if (typeof fetchImpl !== "function" || typeof now !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 500 ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 20) {
    return unavailable("INVALID_NEWS_ADAPTER_CONFIGURATION");
  }
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", terms);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("maxrecords", String(maxRecords));
  url.searchParams.set("timespan", "24h");
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return unavailable("NEWS_PROVIDER_HTTP_ERROR");
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.articles)) return unavailable("NEWS_PROVIDER_INVALID_RESPONSE");
    const observedNow = now();
    if (!Number.isFinite(observedNow)) return unavailable("INVALID_OBSERVATION_TIME");
    const seen = new Set();
    const articles = [];
    for (const item of payload.articles) {
      const title = typeof item?.title === "string" ? item.title.trim().slice(0, 240) : "";
      const domain = typeof item?.domain === "string" ? item.domain.trim().toLowerCase().slice(0, 120) : "";
      const publishedAt = safeDate(item?.seendate);
      const stamp = publishedAt ? Date.parse(publishedAt) : NaN;
      const ageMs = observedNow - stamp;
      if (!title || !domain || !Number.isFinite(stamp) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const negative = NEGATIVE.test(title);
      const positive = POSITIVE.test(title);
      articles.push({
        title,
        domain,
        publishedAt,
        ageMinutes: Math.floor(ageMs / 60000),
        tone: negative && positive ? "MIXED" : negative ? "NEGATIVE_KEYWORDS" : positive ? "POSITIVE_KEYWORDS" : "UNCLASSIFIED"
      });
      if (articles.length >= maxRecords) break;
    }
    const counts = articles.reduce((out, item) => {
      out[item.tone] = (out[item.tone] || 0) + 1;
      return out;
    }, {});
    return {
      status: articles.length ? "HEADLINES_AVAILABLE" : "NO_RECENT_HEADLINES",
      source: "GDELT_DOC_API",
      instrument: symbol,
      windowHours: 24,
      observedAt: new Date(observedNow).toISOString(),
      articles,
      keywordSummary: counts,
      sentiment: "CONTEXT_ONLY",
      newsGateStatus: "UNKNOWN",
      limitations: [
        "Headline keyword labels are not a validated sentiment model.",
        "Headline discovery does not establish event severity, market causality or economic-calendar blackout status.",
        "No headlines does not mean there is no market-moving event."
      ]
    };
  } catch {
    return unavailable("NEWS_PROVIDER_UNAVAILABLE");
  }
}

function unavailable(reason) {
  return {
    status: "UNAVAILABLE",
    source: "GDELT_DOC_API",
    articles: [],
    sentiment: "UNKNOWN",
    newsGateStatus: "UNKNOWN",
    reasons: [reason]
  };
}
