import {analyseScalping, mergeCompletedM5, latestContiguousCandles} from "./scalping-engine.js";

const finite=Number.isFinite;
const clampInt=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
function validateHistory(candles){
 if(!Array.isArray(candles)||candles.length<160)throw new RangeError("At least 160 completed M1 candles are required for warm-up and evaluation.");
 const clean=latestContiguousCandles(candles,60,candles.length);
 if(clean.length!==candles.length)throw new RangeError("Historical M1 candles must be valid, aligned and strictly contiguous.");
 return clean;
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
  const priceR=priceMove/position.riskDistance;
  const commissionR=commissionPriceUnitsRoundTrip/position.riskDistance;
  const netR=priceR-commissionR;
  trades.push({direction:position.direction,entryEpoch:position.entryEpoch,exitEpoch:epoch,
   entry:position.entry,exit:exitPrice,stopLoss:position.stopLoss,takeProfit:position.takeProfit,
   exitReason:reason,priceR,commissionR,netR,portfolioReturnPct:netR*perPositionRiskPct,
   openPositionsAtEntry:position.openPositionsAtEntry});
 };
 for(let i=125;i<rows.length;i++){
  const bar=rows[i],history=rows.slice(Math.max(0,i-180),i);
  // Manage all existing positions independently. Stop wins any same-bar ambiguity.
  for(let p=positions.length-1;p>=0;p--){
   const position=positions[p];let exit=null,reason=null;
   if(position.direction==="BUY"){
    const stopHit=bar.low-halfSpread<=position.stopLoss,targetHit=bar.high-halfSpread>=position.takeProfit;
    if(stopHit){exit=position.stopLoss-slippagePriceUnits;reason="STOP_LOSS";}
    else if(targetHit){exit=position.takeProfit-slippagePriceUnits;reason="TAKE_PROFIT";}
    else if(i===rows.length-1){exit=bar.close-halfSpread-slippagePriceUnits;reason="END_OF_DATA";}
   }else{
    const stopHit=bar.high+halfSpread>=position.stopLoss,targetHit=bar.low+halfSpread<=position.takeProfit;
    if(stopHit){exit=position.stopLoss+slippagePriceUnits;reason="STOP_LOSS";}
    else if(targetHit){exit=position.takeProfit+slippagePriceUnits;reason="TAKE_PROFIT";}
    else if(i===rows.length-1){exit=bar.close+halfSpread+slippagePriceUnits;reason="END_OF_DATA";}
   }
   if(exit!==null){closePosition(position,exit,bar.epoch,reason);positions.splice(p,1);}
  }
  if(positions.length>=maxPositions||i===rows.length-1)continue;
  const m5=mergeCompletedM5([],history);
  if(history.length<35||m5.length<25)continue;
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
  const position={direction:signal.direction,entry,entryEpoch:bar.epoch,stopLoss,takeProfit,riskDistance,openPositionsAtEntry:positions.length+1};
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
