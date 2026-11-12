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
