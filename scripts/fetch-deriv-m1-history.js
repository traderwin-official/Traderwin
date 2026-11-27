import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {shouldFetchOlderHistory} from "../lib/deriv-history-pagination.js";

const ENDPOINT="wss://api.derivws.com/trading/v1/options/ws/public";
const [symbolArg,daysArg="14",outputArg="deriv-m1-history.csv"]=process.argv.slice(2);
const days=Number(daysArg);
if(!symbolArg||!Number.isInteger(days)||days<1||days>120){
 console.error("Usage: node scripts/fetch-deriv-m1-history.js <active-symbol> [days 1-120] [output.csv]");
 process.exit(2);
}
const ws=new WebSocket(ENDPOINT),pending=new Map();
let nextId=1;
function rejectPending(error){
 for(const entry of pending.values())entry.reject(error);
 pending.clear();
}
function request(payload,expectedType){
 const req_id=nextId++;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(req_id);reject(new Error("Deriv request timed out: "+expectedType));},20000);
  const finish=(callback,value)=>{clearTimeout(timer);pending.delete(req_id);callback(value);};
  pending.set(req_id,{expectedType,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)});
  if(ws.readyState!==WebSocket.OPEN){finish(reject,new Error("Deriv public WebSocket is not open."));return;}
  try{ws.send(JSON.stringify({...payload,req_id}));}
  catch(error){finish(reject,error);}
 });
}
ws.addEventListener("message",event=>{
 let message;
 try{message=JSON.parse(event.data);}catch{return;}
 const id=Number(message.req_id),entry=pending.get(id);
 if(!entry)return;
 if(message.error){entry.reject(new Error(message.error.message||"Deriv API error"));return;}
 if(message.msg_type!==entry.expectedType)return;
 entry.resolve(message);
});
ws.addEventListener("error",()=>rejectPending(new Error("Deriv public WebSocket connection failed.")));
ws.addEventListener("close",()=>rejectPending(new Error("Deriv public WebSocket closed before the download completed.")));

try{
 await new Promise((resolve,reject)=>{
  if(ws.readyState===WebSocket.OPEN){resolve();return;}
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",()=>reject(new Error("Could not connect to Deriv public market data.")),{once:true});
  ws.addEventListener("close",()=>reject(new Error("Deriv closed the public market-data connection.")),{once:true});
 });
 const symbols=await request({active_symbols:"full"},"active_symbols");
 const selected=(symbols.active_symbols||[]).find(item=>item.symbol===symbolArg);
 if(!selected)throw new Error("Symbol is not in Deriv's current active-symbol list: "+symbolArg);
 const from=Math.floor(Date.now()/1000)-days*86400;
 const completedBefore=Math.floor(Date.now()/60000)*60;
 const maxPages=Math.ceil(days*1440/1000)+3;
 let end="latest",all=[],oldest=Infinity,pages=0;
 while(pages<maxPages){
  const response=await request({ticks_history:symbolArg,count:1000,end,style:"candles",granularity:60},"candles");
  if(!Array.isArray(response.candles))throw new Error("Deriv returned a candles response without a valid candles array.");
  const candles=response.candles.map(c=>({epoch:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
   .filter(c=>Number.isSafeInteger(c.epoch)&&c.epoch>=0&&c.epoch<completedBefore&&[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.epoch%60===0&&c.low>0&&c.high>=c.low&&c.open>=c.low&&c.open<=c.high&&c.close>=c.low&&c.close<=c.high);
  if(!candles.length)break;
  all.push(...candles);pages++;
  const first=candles.reduce((minimum,c)=>Math.min(minimum,c.epoch),Infinity);
  if(!shouldFetchOlderHistory({receivedCount:response.candles.length,pageSize:1000,oldestEpoch:first,fromEpoch:from,previousOldestEpoch:oldest}))break;
   oldest=first;end=String(first-1);
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 if(pages>=maxPages)throw new Error("Historical pagination reached its safety limit before completing the requested date range.");
 const unique=new Map();
 for(const c of all)if(c.epoch>=from&&c.epoch<completedBefore)unique.set(c.epoch,c);
 const rows=[...unique.values()].sort((a,b)=>a.epoch-b.epoch);
 if(rows.length<160)throw new Error("Deriv returned only "+rows.length+" valid completed M1 candles; at least 160 are needed for a meaningful warm-up.");
 const csv=["epoch,open,high,low,close",...rows.map(c=>[c.epoch,c.open,c.high,c.low,c.close].join(","))].join("\n")+"\n";
 writeFileSync(resolve(outputArg),csv,"utf8");
 console.log(JSON.stringify({symbol:symbolArg,displayName:selected.display_name||selected.symbol,daysRequested:days,candles:rows.length,pages,from:new Date(rows[0].epoch*1000).toISOString(),to:new Date(rows.at(-1).epoch*1000).toISOString(),output:resolve(outputArg)},null,2));
}catch(error){console.error("Historical download failed:",error.message);process.exitCode=1;}
finally{try{ws.close();}catch{}}
