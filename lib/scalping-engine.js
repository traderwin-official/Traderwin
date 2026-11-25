const finite = Number.isFinite;
const norm = value => String(value || "").trim().toUpperCase().replace(/[\\s/.-]/g, "");
function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 35) throw new RangeError("At least 35 completed M1 candles are required.");
  let previous = 0;
  for (const c of candles) {
    if (!c || !finite(c.epoch) || c.epoch <= previous ||
        ![c.open,c.high,c.low,c.close].every(finite) ||
        c.low <= 0 || c.high < c.low || c.open < c.low || c.open > c.high ||
        c.close < c.low || c.close > c.high) throw new RangeError("Invalid completed M1 candle.");
    previous = c.epoch;
  }
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
  const fast=scalpingEma(closes,9),slow=scalpingEma(closes,21),momentum=rsi(closes),volatility=atr(candles);
  if(!finite(volatility)||volatility<=0||spread>volatility*(config.maxSpreadAtrRatio??0.12))
    return {direction:"WAIT",reason:"SPREAD_OR_VOLATILITY_FILTER"};
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
  if(!buy&&!sell)return {direction:"WAIT",reason:"NO_M1_MOMENTUM_BREAKOUT",indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread}};
  const direction=buy?"BUY":"SELL",entry=buy?tick.ask:tick.bid;
  const stopDistance=Math.max(volatility*1.2,spread*2);
  const stopLoss=buy?entry-stopDistance:entry+stopDistance;
  const takeProfit=buy?entry+stopDistance*1.5:entry-stopDistance*1.5;
  return {direction,confidence:Math.min(90,65+Math.round(Math.abs(momentum-50))),instrument:symbol,
    entry,stopLoss,takeProfit,riskReward:1.5,signalAsOf:tick.quoteAsOf,
    indicators:{ema9:fast,ema21:slow,rsi14:momentum,atr14:volatility,spread,m1Breakout:true},
    reason:"M1_MOMENTUM_BREAKOUT_WITH_TREND_AND_SPREAD_CONFIRMATION"};
}
