const finite = Number.isFinite;

function positive(value, name) {
  if (!finite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number.`);
}

export function calculateScalpingRisk({ balance, entry, stopLoss, quoteToUsd = 1, riskPct = 0.25 }) {
  positive(balance, "balance"); positive(entry, "entry"); positive(stopLoss, "stopLoss"); positive(quoteToUsd, "quoteToUsd");
  if (!finite(riskPct) || riskPct <= 0 || riskPct > 0.25) throw new RangeError("Scalping risk must be greater than 0 and no more than 0.25%.");
  const distance=Math.abs(entry-stopLoss);
  if (!finite(distance)||distance<=0) throw new RangeError("Stop-loss distance must be positive.");
  const riskBudget=balance*riskPct/100;
  const quantity=Math.floor((riskBudget/(distance*quoteToUsd))*1e12)/1e12;
  if(!finite(quantity)||quantity<=0)throw new RangeError("Calculated position quantity is too small.");
  const riskAmount=Math.floor(distance*quantity*quoteToUsd*100+1e-9)/100;
  const actualRiskPct=riskAmount/balance*100;
  if(riskAmount<=0||actualRiskPct>riskPct+1e-9)throw new RangeError("Calculated position exceeds the requested risk budget.");
  return {quantity,riskAmount,riskPct:actualRiskPct,riskBudget};
}

// Retain the legacy internal ladder fields required by the existing DEMO
// entry ledger, but only the final target is executable for this strategy.
export function buildScalpingTargets({direction,entry,stopLoss,takeProfit}) {
  if(!["BUY","SELL"].includes(direction))throw new RangeError("Direction must be BUY or SELL.");
  positive(entry,"entry");positive(stopLoss,"stopLoss");positive(takeProfit,"takeProfit");
  if((direction==="BUY"&&stopLoss>=entry)||(direction==="SELL"&&stopLoss<=entry))throw new RangeError("Stop-loss must be beyond entry in the adverse direction.");
  const risk=Math.abs(entry-stopLoss),reward=direction==="BUY"?takeProfit-entry:entry-takeProfit,rewardRisk=reward/risk;
  if(!finite(rewardRisk)||rewardRisk<1.5||rewardRisk>3)throw new RangeError("Final scalping target must be between 1.5R and 3R.");
  const sign=direction==="BUY"?1:-1;
  const tp1=entry+sign*risk*0.75,tp2=entry+sign*risk*1.1;
  if(direction==="BUY"?!(entry<tp1&&tp1<tp2&&tp2<takeProfit):!(entry>tp1&&tp1>tp2&&tp2>takeProfit))throw new RangeError("Scalping target markers are not correctly ordered.");
  return {tp1,tp2,tp3:takeProfit,rewardRisk};
}

export function evaluateScalpingExit({trade,bid,ask,quoteAsOf,receivedAt,now=Date.now()}) {
  if(!trade||!["BUY","SELL"].includes(trade.side))return {action:"WAIT",reason:"INVALID_TRADE"};
  if(![bid,ask].every(v=>finite(v)&&v>0)||ask<bid)return {action:"WAIT",reason:"VERIFIED_BID_ASK_REQUIRED"};
  const asOf=typeof quoteAsOf==="number"?quoteAsOf:Date.parse(quoteAsOf);
  const received=typeof receivedAt==="number"?receivedAt:Date.parse(receivedAt);
  if(!finite(asOf)||!finite(received)||asOf>now+1000||received>now+1000||now-asOf>10000||now-received>3000)return {action:"WAIT",reason:"EXIT_QUOTE_STALE"};
  const price=trade.side==="BUY"?bid:ask;
  if(trade.side==="BUY"?price<=trade.stop_loss:price>=trade.stop_loss)return {action:"EXIT",reason:"STOP_LOSS",price};
  const target=Number(trade.take_profit??trade.tp3_price);
  if(finite(target)&&target>0&&(trade.side==="BUY"?price>=target:price<=target))return {action:"EXIT",reason:"TAKE_PROFIT",price};
  return {action:"HOLD",price};
}
