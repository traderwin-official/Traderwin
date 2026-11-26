import {writeFileSync} from "node:fs";
import {resolve} from "node:path";

const ENDPOINT="wss://api.derivws.com/trading/v1/options/ws/public";
const [symbolArg,daysArg="14",outputArg="deriv-m1-history.csv"]=process.argv.slice(2);
const days=Number(daysArg);
if(!symbolArg||!Number.isInteger(days)||days<1||days>120){
 console.error("Usage: node scripts/fetch-deriv-m1-history.js <active-symbol> [days 1-120] [output.csv]");
 process.exit(2);
}
const ws=new WebSocket(ENDPOINT),pending=new Map();
let nextId=1,failed=false;
function request(payload,expectedType){
 const req_id=nextId++;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(req_id);reject(new Error("Deriv request timed out: "+expectedType));},15000);
  pending.set(req_id,{expectedType,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  ws.send(JSON.stringify({...payload,req_id}));
 });
}
ws.onmessage=event=>{
 let message;
 try{message=JSON.parse(event.data);}catch{return;}
 const id=Number(message.req_id),entry=pending.get(id);
 if(!entry)return;
 if(message.error){pending.delete(id);entry.reject(new Error(message.error.message||"Deriv API error"));return;}
 if(message.msg_type!==entry.expectedType)return;
 pending.delete(id);entry.resolve(message);
};
ws.onerror=()=>{failed=true;for(const entry of pending.values())entry.reject(new Error("Deriv WebSocket connection failed."));pending.clear();};
try{
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",()=>reject(new Error("Could not connect to Deriv public market data.")),{once:true});});
 const symbols=await request({active_symbols:"brief"}, "active_symbols");
 const selected=(symbols.active_symbols||[]).find(item=>item.symbol===symbolArg);
 if(!selected)throw new Error("Symbol is not in Deriv's current active-symbol list: "+symbolArg);
 const from=Math.floor(Date.now()/1000)-days*86400;
 let end="latest",all=[],oldest=Infinity,pages=0;
 const completedBefore=Math.floor(Date.now()/60000)*60;
 while(pages<200){
  const response=await request({ticks_history:symbolArg,count:1000,end,style:"candles",granularity:60},"candles");
  const candles=(response.candles||[]).map(c=>({epoch:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
   .filter(c=>Number.isFinite(c.epoch)&&c.epoch<completedBefore&&[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.epoch%60===0&&c.low>0&&c.high>=c.low&&c.open>=c.low&&c.open<=c.high&&c.close>=c.low&&c.close<=c.high);
  if(!candles.length)break;
  all.push(...candles);pages++;
  const first=Math.min(...candles.map(c=>c.epoch));
  if(first<=from||candles.length<1000||first>=oldest)break;
  oldest=first;end=String(first-1);
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 const unique=new Map();
 for(const c of all)if(c.epoch>=from)unique.set(c.epoch,c);
 const rows=[...unique.values()].sort((a,b)=>a.epoch-b.epoch);
 if(rows.length<160)throw new Error("Deriv returned only "+rows.length+" valid M1 candles; at least 160 are needed for a meaningful warm-up.");
 const csv=["epoch,open,high,low,close",...rows.map(c=>[c.epoch,c.open,c.high,c.low,c.close].join(","))].join("\n")+"\n";
 writeFileSync(resolve(outputArg),csv,"utf8");
 console.log(JSON.stringify({symbol:symbolArg,displayName:selected.display_name,daysRequested:days,candles:rows.length,pages,from:new Date(rows[0].epoch*1000).toISOString(),to:new Date(rows.at(-1).epoch*1000).toISOString(),output:resolve(outputArg)},null,2));
}catch(error){console.error("Historical download failed:",error.message);process.exitCode=1;}
finally{try{ws.close();}catch{}}
