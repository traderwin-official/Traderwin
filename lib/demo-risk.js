export function validatePaperSetup({direction,entry,stop,target}){
 if(!["BUY","SELL"].includes(direction))return "Direction must be BUY or SELL.";
 if(![entry,stop,target].every(Number.isFinite)||[entry,stop,target].some(v=>v<=0))return "Prices must be positive finite numbers.";
 if(direction==="BUY"&&!(stop<entry&&target>entry))return "For BUY, stop-loss must be below entry and take-profit above.";
 if(direction==="SELL"&&!(stop>entry&&target<entry))return "For SELL, stop-loss must be above entry and take-profit below.";
 return null;
}
export function calculatePaperPosition({balance,riskPct,entry,stop}){
 if(![balance,riskPct,entry,stop].every(Number.isFinite)||balance<=0||riskPct<=0||riskPct>2||entry<=0||stop<=0||entry===stop)throw new RangeError("Invalid paper risk inputs.");
 const riskAmount=balance*riskPct/100;return {riskAmount,units:riskAmount/Math.abs(entry-stop)};
}
export function calculatePaperPnl({direction,entry,exit,units}){
 if(!["BUY","SELL"].includes(direction)||![entry,exit,units].every(Number.isFinite)||entry<=0||exit<=0||units<=0)throw new RangeError("Invalid paper close inputs.");
 return (direction==="BUY"?exit-entry:entry-exit)*units;
}
