export function profitProtection({peakProfit,currentProfit,givebackPct=20,enabled=true}){
 for(const n of [peakProfit,currentProfit,givebackPct])if(!Number.isFinite(n))throw new RangeError("Profit protection values must be finite.");
 if(givebackPct<=0||givebackPct>50)throw new RangeError("Giveback percentage must be above zero and at most 50.");
 const peak=Math.max(0,peakProfit);
 if(!enabled||peak<=0)return {active:false,peakProfit:peak,protectedFloor:0,close:false,givebackAmount:0};
 const protectedFloor=peak*(1-givebackPct/100);
 return {active:true,peakProfit:peak,protectedFloor,close:currentProfit<=protectedFloor,givebackAmount:Math.max(0,peak-currentProfit)};
}
export function nextProtectiveStop({direction,entryPrice,currentStop,markPrice,peakProfit,units,givebackPct=20}){
 if(!["BUY","SELL"].includes(direction)||![entryPrice,currentStop,markPrice,peakProfit,units,givebackPct].every(Number.isFinite)||entryPrice<=0||currentStop<=0||markPrice<=0||units<=0)throw new RangeError("Invalid trailing stop inputs.");
 const p=profitProtection({peakProfit,currentProfit:peakProfit,givebackPct});
 const floor=p.protectedFloor/units;
 const candidate=direction==="BUY"?entryPrice+floor:entryPrice-floor;
 // Stops can only tighten: never move farther from the current market or increase risk.
 return direction==="BUY"?Math.max(currentStop,candidate):Math.min(currentStop,candidate);
}

export function calculateProfitProtection({direction,entryPrice,currentPrice,units,peakProfit=0,givebackPct=20,existingStopLoss=null}){
 if(!["BUY","SELL"].includes(direction)||![entryPrice,currentPrice,units,peakProfit,givebackPct].every(Number.isFinite)||entryPrice<=0||currentPrice<=0||units<=0||peakProfit<0||givebackPct<=0||givebackPct>50)throw new RangeError("Invalid profit-protection inputs.");
 const currentProfit=(direction==="BUY"?currentPrice-entryPrice:entryPrice-currentPrice)*units;
 const nextPeak=Math.max(peakProfit,currentProfit,0);
 const floor=profitProtection({peakProfit:nextPeak,currentProfit,givebackPct});
 if(!floor.active)return {currentProfit,peakProfit:nextPeak,protectedProfit:0,protectedStopPrice:existingStopLoss,shouldClose:false,protectionActive:false,givebackPct};
 const oldStop=Number.isFinite(existingStopLoss)?existingStopLoss:(direction==="BUY"?entryPrice-(entryPrice*.02):entryPrice+(entryPrice*.02));
 const protectedStopPrice=nextProtectiveStop({direction,entryPrice,currentStop:oldStop,markPrice:currentPrice,peakProfit:nextPeak,units,givebackPct});
 return {currentProfit,peakProfit:nextPeak,protectedProfit:floor.protectedFloor,protectedStopPrice,shouldClose:currentProfit<=floor.protectedFloor,protectionActive:true,givebackPct};
}
