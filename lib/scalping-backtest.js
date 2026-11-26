import {analyseScalping, mergeCompletedM5, latestContiguousCandles} from "./scalping-engine.js";

const finite=Number.isFinite;
const clampInt=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
function validateCandleRows(candles,minRows=1){
 if(!Array.isArray(candles)||candles.length<minRows)throw new RangeError("Not enough completed M1 candles were supplied.");
 let previous=0;
 for(const c of candles){
  if(!c||!finite(c.epoch)||c.epoch<=previous||c.epoch%60!==0||
   ![c.open,c.high,c.low,c.close].every(finite)||c.low<=0||c.high<c.low||
   c.open<c.low||c.open>c.high||c.close<c.low||c.close>c.high)
   throw new RangeError("Historical M1 candles must be valid, minute-aligned and sorted.");
  previous=c.epoch;
 }
 return candles.map(c=>({...c}));
}
function validateHistory(candles){
 if(!Array.isArray(candles)||candles.length<160)throw new RangeError("At least 160 completed M1 candles are required for warm-up and evaluation.");
 // Real markets have weekends and session breaks. Validate ordering globally,
 // then rebuild only the newest contiguous segment at each replay step.
 return validateCandleRows(candles,160);
}
export function scalpingExitFillPrice(direction, level, halfSpread, slippagePriceUnits=0){
 if(direction!=="BUY"&&direction!=="SELL")throw new TypeError("Direction must be BUY or SELL.");
 if(![level,halfSpread,slippagePriceUnits].every(finite)||halfSpread<0||slippagePriceUnits<0)
  throw new RangeError("Exit price and costs must be finite and non-negative.");
 return direction==="BUY"?level-halfSpread-slippagePriceUnits:level+halfSpread+slippagePriceUnits;
}
export function scalpingStopFillPrice(direction, stopLevel, barOpen, halfSpread, slippagePriceUnits=0){
 if(direction!=="BUY"&&direction!=="SELL")throw new TypeError("Direction must be BUY or SELL.");
 if(![stopLevel,barOpen,halfSpread,slippagePriceUnits].every(finite)||stopLevel<=0||barOpen<=0||halfSpread<0||slippagePriceUnits<0)
  throw new RangeError("Stop level, bar open and costs must be valid.");
 const executableOpen=direction==="BUY"?barOpen-halfSpread:barOpen+halfSpread;
 const gapAdjusted=direction==="BUY"?Math.min(stopLevel,executableOpen):Math.max(stopLevel,executableOpen);
 return direction==="BUY"?gapAdjusted-slippagePriceUnits:gapAdjusted+slippagePriceUnits;
}
function metrics(trades,maxDrawdownRisk){
 const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<0);
 const grossProfit=wins.reduce((s,t)=>s+t.netR,0),grossLoss=-losses.reduce((s,t)=>s+t.netR,0);
 const sum=trades.reduce((s,t)=>s+t.netR,0);
 let equity=0,peak=0,drawdown=0,streak=0,maxStreak=0;
 for(const trade of trades){
  equity+=trade.netR;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);
  streak=trade.netR<0?streak+1:trade.netR>0?0:streak;maxStreak=Math.max(maxStreak,streak);
 }
 return {
  totalTrades:trades.length,wins:wins.length,losses:losses.length,
  winRatePct:trades.length?wins.length/trades.length*100:0,
  profitFactor:grossLoss>0?grossProfit/grossLoss:grossProfit>0?null:0,
  expectancyR:trades.length?sum/trades.length:0,
  averageWinR:wins.length?grossProfit/wins.length:0,
  averageLossR:losses.length? -grossLoss/losses.length:0,
  netR:sum,maxDrawdownR:drawdown,maxConsecutiveLosses:maxStreak,
  grossProfitR:grossProfit,grossLossR:grossLoss
 };
}
export function summarizeScalpingBacktest(trades,options={}){
 if(!Array.isArray(trades))throw new TypeError("Trades must be an array.");
 const maxPositions=options.maxPositions??15;
 if(!clampInt(maxPositions,1,15))throw new RangeError("maxPositions must be between 1 and 15.");
 const base=metrics(trades);
 const peakOpenPositions=trades.reduce((peak,t)=>Math.max(peak,t.openPositionsAtEntry||0),0);
 return {...base,peakOpenPositions,maxPositions};
}

/**
 * Historical M1 replay. Signals are evaluated only at the next bar open using
 * previously completed M1/M5 candles. Stop-first handling is used when both
 * stop and target are touched in one bar. Spread is paid on entry and exit;
 * slippage and commission are adverse costs. This is a research simulation,
 * not a promise of fills or future performance.
 */
export function runScalpingBacktest({instrument,candles,spreadPriceUnits,slippagePriceUnits=0,commissionPriceUnitsRoundTrip=0,maxPositions=15,portfolioRiskPct=1}){
 const symbol=String(instrument||"").trim().toUpperCase();
 if(!symbol)throw new TypeError("An instrument is required.");
 const rows=validateHistory(candles);
 if(!finite(spreadPriceUnits)||spreadPriceUnits<=0)throw new RangeError("A positive fixed spreadPriceUnits assumption is required.");
 if(!finite(slippagePriceUnits)||slippagePriceUnits<0||!finite(commissionPriceUnitsRoundTrip)||commissionPriceUnitsRoundTrip<0)
  throw new RangeError("Slippage and commission assumptions cannot be negative.");
 if(!clampInt(maxPositions,1,15))throw new RangeError("maxPositions must be between 1 and 15.");
 if(!finite(portfolioRiskPct)||portfolioRiskPct<=0||portfolioRiskPct>1)throw new RangeError("portfolioRiskPct must be greater than 0 and at most 1.");
 const halfSpread=spreadPriceUnits/2,positions=[],trades=[];
 const perPositionRiskPct=portfolioRiskPct/maxPositions;
 let peakOpenPositions=0;
 const closePosition=(position,exitPrice,epoch,reason)=>{
  const priceMove=position.direction==="BUY"?exitPrice-position.entry:position.entry-exitPrice;
  const priceR=position.realizedR+position.remainingPct*priceMove/position.riskDistance;
  const commissionR=commissionPriceUnitsRoundTrip/position.riskDistance;
  const netR=priceR-commissionR;
  trades.push({direction:position.direction,entryEpoch:position.entryEpoch,exitEpoch:epoch,
   entry:position.entry,exit:exitPrice,stopLoss:position.stopLoss,takeProfit:position.takeProfit,
   tp1Done:position.tp1Done,tp2Done:position.tp2Done,exitReason:reason,
   priceR,commissionR,netR,portfolioReturnPct:netR*perPositionRiskPct,
   openPositionsAtEntry:position.openPositionsAtEntry});
 };
 for(let i=125;i<rows.length;i++){
  const bar=rows[i],history=latestContiguousCandles(rows.slice(Math.max(0,i-180),i),60,180);
  // Manage all existing positions independently. Stop wins any same-bar ambiguity.
  for(let p=positions.length-1;p>=0;p--){
   const position=positions[p];let exit=null,reason=null;
   const buy=position.direction==="BUY";
   const stopHit=buy?bar.low-halfSpread<=position.stopLoss:bar.high+halfSpread>=position.stopLoss;
   if(stopHit){
    exit=scalpingStopFillPrice(position.direction,position.stopLoss,bar.open,halfSpread,slippagePriceUnits);reason="STOP_LOSS";
   }else{
    const levels=[{key:"tp1Done",price:position.tp1,pct:0.4,stage:"TP1"},{key:"tp2Done",price:position.tp2,pct:0.3,stage:"TP2"},{key:"tp3Done",price:position.takeProfit,pct:0.3,stage:"TP3"}];
    for(const level of levels){
     if(position[level.key])continue;
     const reached=buy?bar.high-halfSpread>=level.price:bar.low+halfSpread<=level.price;
     if(!reached)break;
     const fill=scalpingExitFillPrice(position.direction,level.price,halfSpread,slippagePriceUnits);
     const move=buy?fill-position.entry:position.entry-fill;
     position.realizedR+=level.pct*move/position.riskDistance;
     position.remainingPct-=level.pct;
     position[level.key]=true;
     if(level.stage==="TP3"){exit=fill;reason="TP3";break;}
    }
    if(exit===null&&i===rows.length-1){exit=buy?bar.close-halfSpread-slippagePriceUnits:bar.close+halfSpread+slippagePriceUnits;reason="END_OF_DATA";}
   }
   if(exit!==null){closePosition(position,exit,bar.epoch,reason);positions.splice(p,1);}
  }
  if(positions.length>=maxPositions||i===rows.length-1)continue;
  const m5=mergeCompletedM5([],history);
  if(history.length<125||m5.length<25)continue;
  const mid=bar.open,now=bar.epoch*1000;
  const tick={source:"DERIV",instrument:symbol,providerSymbol:symbol,quote:mid,bid:mid-halfSpread,ask:mid+halfSpread,
   quoteAsOf:new Date(now).toISOString(),receivedAt:new Date(now).toISOString()};
  let signal;
  try{signal=analyseScalping({instrument:symbol,candles:history.slice(-180),trendCandles:m5,tick,now});}
  catch{continue;}
  if(signal.direction!=="BUY"&&signal.direction!=="SELL")continue;
  const entry=signal.direction==="BUY"?signal.entry+slippagePriceUnits:signal.entry-slippagePriceUnits;
  const stopLoss=signal.stopLoss,takeProfit=signal.takeProfit,riskDistance=Math.abs(entry-stopLoss);
  if(!finite(riskDistance)||riskDistance<=0||!finite(takeProfit))continue;
  const sign=signal.direction==="BUY"?1:-1;
  const position={direction:signal.direction,entry,entryEpoch:bar.epoch,stopLoss,takeProfit,riskDistance,
   tp1:entry+sign*riskDistance*0.75,tp2:entry+sign*riskDistance*1.1,
   tp1Done:false,tp2Done:false,tp3Done:false,realizedR:0,remainingPct:1,
   openPositionsAtEntry:positions.length+1};
  positions.push(position);peakOpenPositions=Math.max(peakOpenPositions,positions.length);
 }
 const summary=metrics(trades);
 const totalPortfolioReturnPct=trades.reduce((s,t)=>s+t.portfolioReturnPct,0);
 let portfolio=0,peak=0,portfolioDrawdown=0;
 for(const trade of trades){portfolio+=trade.portfolioReturnPct;peak=Math.max(peak,portfolio);portfolioDrawdown=Math.max(portfolioDrawdown,peak-portfolio);}
 return {
  instrument:symbol,method:"M1_NEXT_BAR_OPEN_M5_CONFIRMED",
  assumptions:{spreadPriceUnits,slippagePriceUnits,commissionPriceUnitsRoundTrip,maxPositions,portfolioRiskPct,perPositionRiskPct,stopFirstOnAmbiguousBar:true},
  data:{candles:rows.length,from:new Date(rows[0].epoch*1000).toISOString(),to:new Date(rows.at(-1).epoch*1000).toISOString()},
  ...summary,peakOpenPositions,totalPortfolioReturnPct,maxPortfolioDrawdownPct:portfolioDrawdown,
  trades
 };
}

/** Parse a plain OHLC CSV with epoch/timestamp/time/date and open/high/low/close headers. */
export function parseM1Csv(csvText){
 if(typeof csvText!=="string"||!csvText.trim())throw new TypeError("A non-empty CSV string is required.");
 const lines=csvText.replace(/^\uFEFF/,"") .split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(lines.length<2)throw new RangeError("CSV must contain a header and at least one candle.");
 const headers=lines[0].split(",").map(x=>x.trim().replace(/^"|"$/g,"").toLowerCase());
 const index=names=>headers.findIndex(h=>names.includes(h));
 const columns={epoch:index(["epoch","timestamp","time","date"]),open:index(["open"]),high:index(["high"]),low:index(["low"]),close:index(["close"])};
 if(Object.values(columns).some(i=>i<0))throw new TypeError("CSV needs epoch/timestamp/time/date, open, high, low and close columns.");
 const rows=lines.slice(1).map((line,i)=>{
  const cells=line.split(",").map(x=>x.trim().replace(/^"|"$/g,""));
  const raw=cells[columns.epoch];let epoch=Number(raw);
  if(raw!==""&&finite(epoch))epoch=epoch>1e12?Math.floor(epoch/1000):Math.floor(epoch);
  else epoch=Math.floor(Date.parse(raw)/1000);
  const candle={epoch,open:Number(cells[columns.open]),high:Number(cells[columns.high]),low:Number(cells[columns.low]),close:Number(cells[columns.close])};
  if(!finite(epoch)||![candle.open,candle.high,candle.low,candle.close].every(finite))
   throw new TypeError("Invalid numeric candle data on CSV line "+(i+2)+".");
  return candle;
 });
 return validateCandleRows(rows,1);
}
