const ok = Number.isFinite;
const STRATEGIES = Object.freeze({
  MULTI: "MULTI_CONFIRMATION_V1",
  TIGER: "TIGER_FIBONACCI_PSYCHOLOGY_V1",
  MANUAL: "MANUAL_REVIEW"
});
export const SUPPORTED_STRATEGIES = Object.values(STRATEGIES);

function validateCandles(c, minimum = 35) {
  if (!Array.isArray(c) || c.length < minimum) throw new RangeError(`At least ${minimum} completed candles are required.`);
  for (const x of c) {
    if (!x || ![x.open,x.high,x.low,x.close].every(ok) || x.low <= 0 ||
        x.high < x.low || x.open < x.low || x.open > x.high ||
        x.close < x.low || x.close > x.high) throw new RangeError("Invalid OHLC candle.");
  }
}
export function ema(v,p) {
  if(!Array.isArray(v)||v.length<p||p<2||!v.every(ok))throw new RangeError("Invalid EMA input.");
  let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p,a=2/(p+1);
  for(let i=p;i<v.length;i++)x=v[i]*a+x*(1-a);
  return x;
}
export function rsi(v,p=14) {
  if(!Array.isArray(v)||v.length<=p||!v.every(ok))throw new RangeError("Invalid RSI input.");
  let g=0,l=0;
  for(let i=1;i<=p;i++){let d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}
  g/=p;l/=p;
  for(let i=p+1;i<v.length;i++){let d=v[i]-v[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;}
  return l===0?100:100-100/(1+g/l);
}
export function atr(c,p=14) {
  if(!Array.isArray(c)||c.length<=p)throw new RangeError("Invalid ATR input.");
  let t=c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i].close),Math.abs(x.low-c[i].close)));
  if(!t.every(x=>ok(x)&&x>=0))throw new RangeError("Invalid candle ranges.");
  let a=t.slice(0,p).reduce((x,y)=>x+y,0)/p;
  for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;
  return a;
}
function pivotLevels(c, side, left=2, right=2) {
  const points=[];
  for(let i=left;i<c.length-right;i++){
    const value=side==="SUPPORT"?c[i].low:c[i].high;
    let pivot=true;
    for(let j=i-left;j<=i+right;j++){
      if(j===i)continue;
      if(side==="SUPPORT" ? c[j].low<value : c[j].high>value){pivot=false;break;}
    }
    if(pivot)points.push({price:value,index:i});
  }
  return points;
}
export function calculateSupportResistance(c, price=c?.at(-1)?.close, volatility) {
  validateCandles(c, 10);
  if(!ok(price)||price<=0)throw new RangeError("A valid current price is required.");
  const range=volatility&&ok(volatility)&&volatility>0?volatility:atr(c,Math.min(14,c.length-1));
  const tolerance=Math.max(range*.22,price*.00015);
  const supports=pivotLevels(c.slice(-100),"SUPPORT"),resistances=pivotLevels(c.slice(-100),"RESISTANCE");
  function choose(points,side,fallback){
    const candidates=points.filter(p=>side==="SUPPORT"?p.price<=price:p.price>=price);
    candidates.sort((a,b)=>Math.abs(a.price-price)-Math.abs(b.price-price));
    if(!candidates.length || (side==="SUPPORT" && fallback>price) || (side==="RESISTANCE" && fallback<price)) return {price:null,touches:0,strength:"unavailable"};
    const nearest=candidates[0].price;
    const cluster=points.filter(p=>Math.abs(p.price-nearest)<=tolerance);
    return {price:Number((cluster.reduce((s,p)=>s+p.price,0)/cluster.length).toFixed(8)),touches:cluster.length,strength:cluster.length>=3?"strong":cluster.length===2?"moderate":"developing"};
  }
  const recent=c.slice(-30);
  const fallbackSupport=Math.min(...recent.map(x=>x.low));
  const fallbackResistance=Math.max(...recent.map(x=>x.high));
  return {
    support:choose(supports,"SUPPORT",fallbackSupport),
    resistance:choose(resistances,"RESISTANCE",fallbackResistance),
    tolerance:Number(tolerance.toFixed(8))
  };
}
function psychologicalStep(price) {
  if(price>=100000)return 1000;
  if(price>=10000)return 500;
  if(price>=1000)return 10;
  if(price>=100)return 1;
  if(price>=10)return .1;
  if(price>=1)return .01;
  return .001;
}
export function detectOrderBlockStructure(c, lookback=60) {
  validateCandles(c);
  const start=Math.max(25,c.length-Math.min(lookback,120));
  let latest=null;
  for(let i=start;i<c.length;i++){
    const prior=c.slice(Math.max(0,i-5),i);
    if(prior.length<5)continue;
    const previousHigh=Math.max(...prior.map(x=>x.high));
    const previousLow=Math.min(...prior.map(x=>x.low));
    const sample=c.slice(Math.max(0,i-30),i);
    if(sample.length<22)continue;
    const closes=sample.map(x=>x.close);
    const priorTrend=ema(closes,9)>ema(closes,21)?"BULLISH":ema(closes,9)<ema(closes,21)?"BEARISH":"NEUTRAL";
    const vol=atr(c.slice(Math.max(0,i-20),i),14);
    const body=Math.abs(c[i].close-c[i].open);
    const bullishBreak=c[i].close>previousHigh&&c[i].close>c[i].open&&body>=vol*.8;
    const bearishBreak=c[i].close<previousLow&&c[i].close<c[i].open&&body>=vol*.8;
    if(!bullishBreak&&!bearishBreak)continue;
    const direction=bullishBreak?"BULLISH":"BEARISH";
    let origin=-1;
    for(let j=i-1;j>=Math.max(0,i-7);j--){
      if(direction==="BULLISH"&&c[j].close<c[j].open){origin=j;break;}
      if(direction==="BEARISH"&&c[j].close>c[j].open){origin=j;break;}
    }
    if(origin<0)continue;
    const candle=c[origin];
    const zone=direction==="BULLISH"
      ?{low:candle.low,high:candle.open}
      :{low:candle.open,high:candle.high};
    const type=priorTrend!=="NEUTRAL"&&priorTrend!==direction?"CHOCH":"BOS";
    latest={direction,type,zone,originIndex:origin,breakIndex:i,priorTrend,displacement:body,atr:vol};
  }
  if(!latest)return null;
  const price=c.at(-1).close,volatility=atr(c,14),pad=volatility*.2;
  return {...latest,nearPrice:price>=latest.zone.low-pad&&price<=latest.zone.high+pad,
    distance:Number(Math.max(0,latest.zone.low-price,price-latest.zone.high).toFixed(8))};
}
function latestSwing(c) {
  const highs=pivotLevels(c.slice(-100),"RESISTANCE");
  const lows=pivotLevels(c.slice(-100),"SUPPORT");
  const high=highs.at(-1),low=lows.at(-1);
  if(!high||!low||high.price<=low.price)return null;
  return {high:high.price,low:low.price,highIndex:high.index,lowIndex:low.index};
}
export function analyseCandles(c) {
  validateCandles(c);
  const closes=c.map(x=>x.close),last=closes.at(-1),e9=ema(closes,9),e21=ema(closes,21),
    momentum=rsi(closes),vol=atr(c),prior=c.slice(-21,-1),
    hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low));
  const trend=e9>e21?1:e9<e21?-1:0,mom=momentum>=55?1:momentum<=45?-1:0,
    breakout=last>hi?1:last<lo?-1:0,position=last>e9?1:last<e9?-1:0;
  let score=trend*30+mom*20+breakout*30+position*10;
  const volRatio=vol/last;if(volRatio>.03)score*=.5;
  const direction=score>=60?"BUY":score<=-60?"SELL":"WAIT";
  const levels=calculateSupportResistance(c,last,vol);
  return {direction,confidence:Math.min(95,Math.round(Math.abs(score))),strategy:STRATEGIES.MULTI,score,
    indicators:{ema9:e9,ema21:e21,rsi14:momentum,atr14:vol,atrRatio:volRatio,prior20High:hi,prior20Low:lo,
      support:levels.support,resistance:levels.resistance,supportResistanceTolerance:levels.tolerance},
    explanation:direction==="WAIT"?"Confirmations are mixed or insufficient.":"Directional confirmations aligned; check spread, session, news and contract specifications before any order."};
}
export function analyseTigerFibonacciPsychology(c, {trendCandles=c, instrument=""}={}) {
  validateCandles(c);
  validateCandles(trendCandles,35);
  const lastCandle=c.at(-1),price=lastCandle.close,vol=atr(c),closes=trendCandles.map(x=>x.close);
  const h1Fast=ema(closes,9),h1Slow=ema(closes,21);
  const trend=h1Fast>h1Slow?"BULLISH":h1Fast<h1Slow?"BEARISH":"NEUTRAL";
  const swing=latestSwing(c);
  const levels=calculateSupportResistance(c,price,vol);
  const step=psychologicalStep(price);
  const psychologicalLevel=Number((Math.round(price/step)*step).toFixed(8));
  const psychologicalDistance=Math.abs(price-psychologicalLevel);
  const fib=swing?{
    "50":trend==="BEARISH"?swing.low+(swing.high-swing.low)*.5:swing.high-(swing.high-swing.low)*.5,
    "61.8":trend==="BEARISH"?swing.low+(swing.high-swing.low)*.618:swing.high-(swing.high-swing.low)*.618,
    "78.6":trend==="BEARISH"?swing.low+(swing.high-swing.low)*.786:swing.high-(swing.high-swing.low)*.786
  }:null;
  const fibTolerance=vol*.35,nearFib=fib?Object.entries(fib).filter(([,v])=>Math.abs(price-v)<=fibTolerance).map(([k])=>k):[];
  const nearSupport=levels.support.price!==null&&Math.abs(price-levels.support.price)<=Math.max(vol*.35,levels.tolerance);
  const nearResistance=levels.resistance.price!==null&&Math.abs(price-levels.resistance.price)<=Math.max(vol*.35,levels.tolerance);
  const nearPsychological=psychologicalDistance<=Math.max(vol*.25,step*.08);
  const previous=c.slice(-11,-1);
  const priorLow=Math.min(...previous.map(x=>x.low)),priorHigh=Math.max(...previous.map(x=>x.high));
  const body=Math.max(Math.abs(lastCandle.close-lastCandle.open),vol*.02);
  const lowerWick=Math.min(lastCandle.open,lastCandle.close)-lastCandle.low;
  const upperWick=lastCandle.high-Math.max(lastCandle.open,lastCandle.close);
  const bullishSweep=lastCandle.low<priorLow&&lastCandle.close>priorLow;
  const bearishSweep=lastCandle.high>priorHigh&&lastCandle.close<priorHigh;
  const bullishRejection=lastCandle.close>lastCandle.open&&lowerWick>=body*1.2;
  const bearishRejection=lastCandle.close<lastCandle.open&&upperWick>=body*1.2;
  const orderBlock=detectOrderBlockStructure(c);
  const nearBullishOrderBlock=Boolean(orderBlock&&orderBlock.direction==="BULLISH"&&orderBlock.nearPrice);
  const nearBearishOrderBlock=Boolean(orderBlock&&orderBlock.direction==="BEARISH"&&orderBlock.nearPrice);
  const bullishStructure=Boolean(orderBlock&&orderBlock.direction==="BULLISH");
  const bearishStructure=Boolean(orderBlock&&orderBlock.direction==="BEARISH");
  // Require at least two independent location factors. The order-block zone
  // is an additional location factor; BOS/CHOCH remains a separate structure check.
  const bullishLocationScore=[nearFib.length>0,nearSupport,nearPsychological,nearBullishOrderBlock].filter(Boolean).length;
  const bearishLocationScore=[nearFib.length>0,nearResistance,nearPsychological,nearBearishOrderBlock].filter(Boolean).length;
  const bullishLocation=bullishLocationScore>=2;
  const bearishLocation=bearishLocationScore>=2;
  const buyConfirm=trend==="BULLISH"&&bullishLocation&&(bullishSweep||bullishRejection)&&bullishStructure;
  const sellConfirm=trend==="BEARISH"&&bearishLocation&&(bearishSweep||bearishRejection)&&bearishStructure;
  const direction=buyConfirm?"BUY":sellConfirm?"SELL":"WAIT";
  const confirmations=direction==="BUY"
    ?[nearFib.length>0,nearSupport,nearPsychological,bullishSweep||bullishRejection,bullishStructure].filter(Boolean).length
    :direction==="SELL"
      ?[nearFib.length>0,nearResistance,nearPsychological,bearishSweep||bearishRejection,bearishStructure].filter(Boolean).length:0;
  const stopDistance=Math.max(vol*1.5,levels.tolerance*2);
  const stop=direction==="BUY"?price-stopDistance:direction==="SELL"?price+stopDistance:null;
  const target=direction==="BUY"?price+vol*3:direction==="SELL"?price-vol*3:null;
  return {
    direction,confidence:direction==="WAIT"?0:Math.min(95,55+confirmations*8),
    strategy:STRATEGIES.TIGER,score:direction==="BUY"?confirmations*20:direction==="SELL"?-confirmations*20:0,
    indicators:{
      h1Trend:trend,h1Ema9:h1Fast,h1Ema21:h1Slow,atr14:vol,
      swingHigh:swing?.high??null,swingLow:swing?.low??null,fibonacci:fib,
      fibonacciLevelsNearPrice:nearFib,psychologicalLevel,psychologicalStep:step,
      support:levels.support,resistance:levels.resistance,
      supportResistanceTolerance:levels.tolerance,
      nearSupport,nearResistance,nearPsychological,
      bullishLocationScore,bearishLocationScore,
      supportResistanceConfluence:nearSupport||nearResistance,
      liquiditySweep:bullishSweep?"BULLISH":bearishSweep?"BEARISH":"NONE",
      rejection:bullishRejection?"BULLISH":bearishRejection?"BEARISH":"NONE",
      structureConfirmation:bullishStructure?(orderBlock?.type==="CHOCH"?"BULLISH_CHOCH":"BULLISH_BOS"):bearishStructure?(orderBlock?.type==="CHOCH"?"BEARISH_CHOCH":"BEARISH_BOS"):"NONE",
      stopLoss:stop,takeProfit:target
    },
    explanation:direction==="WAIT"
      ?"No trade: wait for H1 trend, Fibonacci/support-resistance/psychological/order-block confluence, a liquidity sweep or rejection candle, and confirmed BOS/CHOCH structure."
      :`Tiger setup confirmed with H1 ${trend.toLowerCase()} trend, ${nearFib.join("% / ")||"price-level"} Fibonacci confluence, support/resistance and psychological-level checks, plus rejection/liquidity and ${orderBlock?.type||"structure"} confirmation. Validate spread, news and broker contract rules.`
  };
}
export function analyseStrategy(c, strategy=STRATEGIES.MULTI, options={}) {
  if(strategy===STRATEGIES.MULTI)return analyseCandles(c);
  if(strategy===STRATEGIES.TIGER)return analyseTigerFibonacciPsychology(c,options);
  if(strategy===STRATEGIES.MANUAL)return {direction:"WAIT",confidence:0,strategy:STRATEGIES.MANUAL,score:0,indicators:{},explanation:"Manual review selected; no automated signal or order is generated."};
  throw new RangeError("Unsupported strategy selected.");
}
