import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {parseM1Csv,runScalpingWalkForward} from "../lib/scalping-backtest.js";

const [csvPath,instrument,spread,slippage="0",commission="0",outputPath,trainFractionArg="0.7"] = process.argv.slice(2);
if(!csvPath||!instrument||spread===undefined){
 console.error("Usage: node scripts/run-scalping-walk-forward.js <m1.csv> <instrument> <spread-price-units> [slippage-price-units] [round-trip-commission-price-units] [output.json] [train-fraction 0.5-0.9]");
 process.exit(2);
}
const number=(value,name)=>{const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error(name+" must be a non-negative number.");return n;};
try{
 const candles=parseM1Csv(readFileSync(resolve(csvPath),"utf8"));
 const report=runScalpingWalkForward({
  instrument,candles,trainFraction:Number(trainFractionArg),
  spreadPriceUnits:number(spread,"Spread"),
  slippagePriceUnits:number(slippage,"Slippage"),
  commissionPriceUnitsRoundTrip:number(commission,"Commission")
 });
 const json=JSON.stringify(report,null,2);
 if(outputPath)writeFileSync(resolve(outputPath),json+"\n","utf8");
 else process.stdout.write(json+"\n");
}catch(error){console.error("Walk-forward backtest failed:",error.message);process.exitCode=1;}
