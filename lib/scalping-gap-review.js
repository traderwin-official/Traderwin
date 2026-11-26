/**
 * Keep new DEMO entries paused for an instrument after a feed gap exposed
 * open positions. Existing positions may still be managed from fresh bid/ask.
 * The review latch clears only after an authoritative refresh removes every
 * affected open position and its pending reconciliation marker.
 */
export function recordMarketDataGapReview({gap,reviewRequiredByInstrument}={}) {
 if(!reviewRequiredByInstrument)throw new TypeError("A market-data review map is required.");
 if(!gap||gap.requiresManualReview!==true)return false;
 reviewRequiredByInstrument.set(String(gap.instrument).toUpperCase(),gap);
 return true;
}

export function resolveMarketDataGapReview({instrument,activeTrades,pendingRefresh,reviewRequiredByInstrument}={}) {
 if(!reviewRequiredByInstrument||!activeTrades||!pendingRefresh)throw new TypeError("Market-data review state is required.");
 const key=String(instrument||"").toUpperCase();
 if(!key||!reviewRequiredByInstrument.has(key))return false;
 const hasOpen=[...activeTrades.values()].some(t=>String(t.instrument||"").toUpperCase()===key);
 const hasPending=pendingRefresh.size>0;
 if(hasOpen||hasPending)return false;
 reviewRequiredByInstrument.delete(key);
 return true;
}
