const finite = Number.isFinite;
const norm = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");

/**
 * Keep only the newest strictly contiguous run of completed candles.
 * Session/weekend gaps reset warm-up; they are never bridged or interpolated.
 */
export function latestContiguousCandles(candles, intervalSeconds=60, limit=240) {
  if (!Array.isArray(candles) || !Number.isInteger(intervalSeconds) || intervalSeconds <= 0 ||
      !Number.isInteger(limit) || limit <= 0) return [];
  let suffix=[],previous=0;
  for (const candle of candles) {
    const valid=candle && finite(candle.epoch) && candle.epoch > 0 &&
      candle.epoch % intervalSeconds === 0 &&
      [candle.open,candle.high,candle.low,candle.close].every(finite) &&
      candle.low > 0 && candle.high >= candle.low &&
      candle.open >= candle.low && candle.open <= candle.high &&
      candle.close >= candle.low && candle.close <= candle.high;
    if (!valid) { suffix=[]; previous=0; continue; }
    if (previous && candle.epoch !== previous + intervalSeconds) suffix=[];
    suffix.push({...candle});
    previous=candle.epoch;
  }
  return suffix.slice(-limit);
}
function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 35) throw new RangeError("At least 35 completed M1 candles are required.");
  let previous = 0;
  for (const c of candles) {
    if (!c || !finite(c.epoch) || c.epoch <= previous ||
        (previous > 0 && c.epoch !== previous + 60) ||
        ![c.open,c.high,c.low,c.close].every(finite) ||
        c.low <= 0 || c.high < c.low || c.open < c.low || c.open > c.high ||
        c.close < c.low || c.close > c.high) throw new RangeError("Invalid or non-contiguous completed M1 candle history.");
    previous = c.epoch;
  }
}
/**
 * Merge provider M5 history with only complete, gap-free M5 candles
 * reconstructed from completed M1 candles. A five-candle count alone is
 * insufficient: missing or duplicated minutes must never create a trend bar.
 */
export function mergeCompletedM5(providerCandles, m1Candles) {
  const merged = new Map();
  for (const candle of Array.isArray(providerCandles) ? providerCandles : []) {
    if (candle && [candle.epoch,candle.open,candle.high,candle.low,candle.close].every(finite) &&
        candle.epoch > 0 && candle.epoch % 300 === 0 && candle.low > 0 &&
        candle.high >= candle.low && candle.open >= candle.low && candle.open <= candle.high &&
        candle.close >= candle.low && candle.close <= candle.high) {
      merged.set(candle.epoch, {...candle});
    }
  }
  const groups = new Map();
  for (const candle of Array.isArray(m1Candles) ? m1Candles : []) {
    if (!candle || ![candle.epoch,candle.open,candle.high,candle.low,candle.close].every(finite) ||
        candle.epoch <= 0 || candle.epoch % 60 !== 0 || candle.low <= 0 ||
        candle.high < candle.low || candle.open < candle.low || candle.open > candle.high ||
        candle.close < candle.low || candle.close > candle.high) continue;
    const start = Math.floor(candle.epoch / 300) * 300;
    const rows = groups.get(start) || [];
    rows.push(candle);
    groups.set(start, rows);
  }
  for (const [epoch, rows] of groups) {
    rows.sort((a,b) => a.epoch - b.epoch);
    if (rows.length !== 5 || rows.some((c,i) => c.epoch !== epoch + i * 60)) continue;
    merged.set(epoch, {
      epoch,
      open: rows[0].open,
      high: Math.max(...rows.map(c => c.high)),
      low: Math.min(...rows.map(c => c.low)),
      close: rows[4].close
    });
  }
  return [...merged.values()].sort((a,b) => a.epoch - b.epoch).slice(-60);
}

/**
 * Fibonacci retracement bands and 1.272/1.618 swing extensions from the
 * most recent completed M1 range. These are analytical levels, not forecasts.
 */
export function fibonacciBands(candles) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const rows = candles.slice(-60);
  if (!rows.every(c => c && [c.high,c.low].every(finite) && c.high >= c.low && c.low > 0)) return null;
  const swingHigh = Math.max(...rows.map(c => c.high));
  const swingLow = Math.min(...rows.map(c => c.low));
  const range = swingHigh - swingLow;
  if (!finite(range) || range <= 0) return null;
  return {
    swingHigh, swingLow, range,
    retracement382: swingHigh - range * 0.382,
    retracement500: swingHigh - range * 0.5,
    retracement618: swingHigh - range * 0.618,
    retracement786: swingHigh - range * 0.786,
    extension1272Up: swingHigh + range * 0.272,
    extension1618Up: swingHigh + range * 0.618,
    extension1272Down: swingLow - range * 0.272,
    extension1618Down: swingLow - range * 0.618
  };
}

/**
 * Lightweight price-action context from confirmed two-sided M1 swing pivots.
 * BOS/CHOCH and liquidity sweeps are descriptive confirmations, not predictions.
 * Order-block zones are labelled candidates for later confluence review.
 */
export function marketStructureContext(candles) {
  if (!Array.isArray(candles) || candles.length < 15) return null;
  const rows = candles.slice(-60);
  const highs = [], lows = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const c = rows[i], left = rows.slice(i - 2, i), right = rows.slice(i + 1, i + 3);
    if (left.every(x => c.high > x.high) && right.every(x => c.high >= x.high)) highs.push({price:c.high});
    if (left.every(x => c.low < x.low) && right.every(x => c.low <= x.low)) lows.push({price:c.low});
  }
  const high = highs.at(-1) || null, previousHigh = highs.at(-2) || null;
  const low = lows.at(-1) || null, previousLow = lows.at(-2) || null;
  const last = rows.at(-1), prior = rows.at(-2);
  if (!last || !prior) return null;
  const bosUp = Boolean(high && prior.close <= high.price && last.close > high.price);
  const bosDown = Boolean(low && prior.close >= low.price && last.close < low.price);
  const bullishSweep = Boolean(low && last.low < low.price && last.close > low.price);
  const bearishSweep = Boolean(high && last.high > high.price && last.close < high.price);
  const priorUptrend = Boolean(high && previousHigh && low && previousLow && high.price > previousHigh.price && low.price > previousLow.price);
  const priorDowntrend = Boolean(high && previousHigh && low && previousLow && high.price < previousHigh.price && low.price < previousLow.price);
  const bosDirection = bosUp && !bosDown ? "BUY" : bosDown && !bosUp ? "SELL" : null;
  let orderBlock = null;
  if (bosDirection) {
    const start = Math.max(0, rows.length - 12);
    for (let i = rows.length - 2; i >= start; i--) {
      const c = rows[i], bearish = c.close < c.open, bullish = c.close > c.open;
      if ((bosDirection === "BUY" && bearish) || (bosDirection === "SELL" && bullish)) {
        orderBlock = {side:bosDirection,low:c.low,high:c.high,epoch:c.epoch}; break;
      }
    }
  }
  return {
    latestSwingHigh:high?.price??null,latestSwingLow:low?.price??null,
    support:low?.price??null,resistance:high?.price??null,bosDirection,
    chochDirection:bosDirection==="SELL"&&priorUptrend?"SELL":bosDirection==="BUY"&&priorDowntrend?"BUY":null,
    liquiditySweep:bullishSweep?"BUY":bearishSweep?"SELL":null,
    orderBlockCandidate:orderBlock
  };
}

export function scalpingEma(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 2 || !values.every(finite)) throw new RangeError("Invalid EMA input.");
  let value = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  const alpha = 2/(period+1);
  for (let i=period;i<values.length;i++) value=values[i]*alpha+value*(1-alpha);
  return value;
}
function rsi(values, period=14) {
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
  gain/=period;loss/=period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];gain=(gain*(period-1)+Math.max(d,0))/period;loss=(loss*(period-1)+Math.max(-d,0))/period;}
  return loss===0?100:100-100/(1+gain/loss);
}
function atr(candles, period=14) {
  const tr=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)value=(value*(period-1)+tr[i])/period;
  return value;
}
/**
 * Fast, confirmation-based M1 scalping signal. It emits a candidate only;
 * execution, account checks, risk sizing and atomic DEMO RPCs belong to the
 * separate execution service and must revalidate the quote before opening.
 */
export function analyseScalping({instrument,candles,tick,trendCandles,now=Date.now(),config={}}) {
  validateCandles(candles);
  const symbol=norm(instrument);
  if(!symbol || !tick || tick.source!=="DERIV" || norm(tick.instrument)!==symbol ||
      !tick.providerSymbol || !finite(tick.quote) || tick.quote<=0) return {direction:"WAIT",reason:"VERIFIED_TICK_REQUIRED"};
  const received=Date.parse(tick.receivedAt),asOf=Date.parse(tick.quoteAsOf);
  if(!finite(received)||!finite(asOf)||received>now+1000||now-received>3000||asOf>now+5000||now-asOf>10000)
    return {direction:"WAIT",reason:"TICK_STALE"};
  const spread=finite(tick.bid)&&finite(tick.ask)&&tick.ask>=tick.bid?tick.ask-tick.bid:null;
  if(spread===null) return {direction:"WAIT",reason:"VERIFIED_BID_ASK_REQUIRED"};
  const closes=candles.map(c=>c.close),last=candles.at(-1),prior=candles.at(-2);
  const fast=scalpingEma(closes,9),slow=scalpingEma(closes,21),momentum=rsi(closes),volatility=atr(candles),fibonacci=fibonacciBands(candles),structure=marketStructureContext(candles);
  if(!finite(volatility)||volatility<=0)return {direction:"WAIT",reason:"VOLATILITY_UNAVAILABLE"};
  if(spread>volatility*(config.maxSpreadAtrRatio??0.12))
    return {direction:"WAIT",reason:"SPREAD_OR_VOLATILITY_FILTER",indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread,fibonacci,marketStructure:structure}};
  if(trendCandles){
    if(!Array.isArray(trendCandles)||trendCandles.length<25||!trendCandles.every(c=>[c.close].every(finite)))
      return {direction:"WAIT",reason:"TREND_CONFIRMATION_UNAVAILABLE"};
    const trendValues=trendCandles.map(c=>c.close);
    const trendFast=scalpingEma(trendValues,9),trendSlow=scalpingEma(trendValues,21);
    if((fast>slow&&trendFast<=trendSlow)||(fast<slow&&trendFast>=trendSlow))
      return {direction:"WAIT",reason:"M5_TREND_CONFLICT"};
  }
  const breakoutBuffer=spread*0.5;
  const buy=tick.ask>Math.max(last.high,prior.high)+breakoutBuffer&&fast>slow&&momentum>=52&&momentum<=72&&last.close>last.open;
  const sell=tick.bid<Math.min(last.low,prior.low)-breakoutBuffer&&fast<slow&&momentum<=48&&momentum>=28&&last.close<last.open;
  if((buy&&structure?.bosDirection==="SELL")||(sell&&structure?.bosDirection==="BUY"))
    return {direction:"WAIT",reason:"M1_MARKET_STRUCTURE_CONFLICT",indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread,fibonacci,marketStructure:structure}};
  if((buy&&structure?.liquiditySweep==="SELL")||(sell&&structure?.liquiditySweep==="BUY"))
    return {direction:"WAIT",reason:"OPPOSING_LIQUIDITY_SWEEP",indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread,fibonacci,marketStructure:structure}};
  if(!buy&&!sell)return {direction:"WAIT",reason:"NO_M1_MOMENTUM_BREAKOUT",indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread,fibonacci,marketStructure:structure}};
  const direction=buy?"BUY":"SELL",entry=buy?tick.ask:tick.bid;
  const stopDistance=Math.max(volatility*1.2,spread*2);
  const stopLoss=buy?entry-stopDistance:entry+stopDistance;
  const minimumTargetDistance=stopDistance*1.5,maximumTargetDistance=stopDistance*3;
  const fibTargets=fibonacci?(buy?[fibonacci.extension1272Up,fibonacci.extension1618Up]:[fibonacci.extension1272Down,fibonacci.extension1618Down])
    .filter(level=>buy?level>=entry+minimumTargetDistance&&level<=entry+maximumTargetDistance:level<=entry-minimumTargetDistance&&level>=entry-maximumTargetDistance):[];
  const takeProfit=fibTargets.length?(buy?Math.min(...fibTargets):Math.max(...fibTargets)):(buy?entry+minimumTargetDistance:entry-minimumTargetDistance);
  const riskReward=Math.abs(takeProfit-entry)/stopDistance;
  const fibonacciTargetUsed=fibTargets.length>0;
  return {direction,confidence:Math.min(90,65+Math.round(Math.abs(momentum-50))),instrument:symbol,
    entry,stopLoss,takeProfit,riskReward,signalAsOf:tick.quoteAsOf,
    indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread,m1Breakout:true,fibonacci,marketStructure:structure,fibonacciTargetUsed},
    reason:fibonacciTargetUsed?"M1_MOMENTUM_BREAKOUT_WITH_FIBONACCI_EXTENSION_TARGET":"M1_MOMENTUM_BREAKOUT_WITH_TREND_AND_SPREAD_CONFIRMATION"};
}
