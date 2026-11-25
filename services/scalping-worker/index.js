import http from "node:http";
import { createClient } from "@supabase/supabase-js";

const PORT=Number(process.env.PORT||8080);
const URL=process.env.SUPABASE_URL;
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENDPOINT="wss://api.derivws.com/trading/v1/options/ws/public";
const norm=v=>String(v||"").trim().toUpperCase().replace(/[\\s/.-]/g,"");
const symbols={XAUUSD:["frxXAUUSD"],XAGUSD:["frxXAGUSD"],EURUSD:["frxEURUSD"],GBPUSD:["frxGBPUSD"],USDJPY:["frxUSDJPY"],AUDUSD:["frxAUDUSD"],USDCAD:["frxUSDCAD"],USDCHF:["frxUSDCHF"],NZDUSD:["frxNZDUSD"],BTCUSD:["cryBTCUSD"],ETHUSD:["cryETHUSD"],R_10:["R_10"],R_25:["R_25"],R_50:["R_50"],R_75:["R_75"],R_100:["R_100"]};
const state={startedAt:new Date().toISOString(),socket:"DISCONNECTED",lastTickAt:null,lastError:null,subscribed:[],ticks:0};
if(!URL||!KEY||KEY.length<30)throw new Error("SUPABASE_URL and service-role key are required.");
const db=createClient(URL,KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const channels=new Map(),lastPersisted=new Map();
let socket=null,stopping=false,retry=1000,reconnectTimer=null,reconcileTimer=null;
const server=http.createServer((req,res)=>{
 if(req.url==="/healthz"){res.writeHead(state.socket==="CONNECTED"?200:503,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({...state,service:"young-tiger-scalping-feed",execution:"READ_ONLY_NO_ORDERS"}));}
 res.writeHead(404);res.end();
});
function logError(e){state.lastError=String(e?.message||e).slice(0,240);console.error("scalping-feed:",state.lastError);}
async function eligibleSymbols(){
 const {data:sessions,error}=await db.from("demo_paper_sessions").select("id,user_id,instrument,broker,status,config_snapshot")
  .eq("broker","DERIV").eq("status","RUNNING").limit(200);
 if(error)throw error;
 const wanted=new Set();
 for(const s of sessions||[]){
  const c=s.config_snapshot&&typeof s.config_snapshot==="object"?s.config_snapshot:{};
  if(c.account_mode==="DEMO"&&c.execution==="WEBSITE_PAPER_ONLY"&&c.scalping_enabled===true&&s.instrument)wanted.add(norm(s.instrument));
 }
 if(!wanted.size)return [];
 const {data:approved,error:approvalError}=await db.from("trading_instrument_approvals")
  .select("instrument,provider_symbol,status,is_active").eq("broker","DERIV").eq("status","APPROVED").eq("is_active",true).in("instrument",[...wanted]);
 if(approvalError)throw approvalError;
 return (approved||[]).filter(a=>wanted.has(norm(a.instrument))&&a.provider_symbol).map(a=>({instrument:norm(a.instrument),providerSymbol:String(a.provider_symbol)}));
}
async function publishTick(symbol,tick){
 const payload={instrument:symbol,providerSymbol:tick.symbol||symbol,quote:Number(tick.quote),bid:Number.isFinite(Number(tick.bid))?Number(tick.bid):null,ask:Number.isFinite(Number(tick.ask))?Number(tick.ask):null,quoteAsOf:new Date(Number(tick.epoch)*1000).toISOString(),receivedAt:new Date().toISOString(),source:"DERIV"};
 if(!Number.isFinite(payload.quote)||payload.quote<=0||!Number.isFinite(Number(tick.epoch))||Math.abs(Date.now()-Date.parse(payload.quoteAsOf))>30000)return;
 state.lastTickAt=payload.receivedAt;state.ticks++;
 const channel=channels.get(symbol);
 if(channel)await channel.send({type:"broadcast",event:"tick",payload});
 const last=lastPersisted.get(symbol)||0;
 if(Date.now()-last>=1000){
  lastPersisted.set(symbol,Date.now());
  const {error}=await db.from("scalping_market_ticks").upsert({instrument:symbol,provider_symbol:payload.providerSymbol,quote:payload.quote,bid:payload.bid,ask:payload.ask,quote_as_of:payload.quoteAsOf,received_at:payload.receivedAt,source:"DERIV",updated_at:payload.receivedAt},{onConflict:"instrument"});
  if(error)logError(error);
 }
}
async function subscribeSet(desired){
 const list=desired.map(x=>x.providerSymbol).sort();
 if(JSON.stringify(list)===JSON.stringify(state.subscribed.slice().sort())&&state.socket==="CONNECTED")return;
 closeSocket();
 for(const c of channels.values())await db.removeChannel(c).catch(()=>{});
 channels.clear();state.subscribed=list;
 if(!list.length){state.socket="IDLE_NO_OPTED_IN_DEMO_SESSIONS";return;}
 socket=new WebSocket(ENDPOINT);
 state.socket="CONNECTING";
 socket.onopen=()=>{retry=1000;state.socket="CONNECTED";socket.send(JSON.stringify({active_symbols:"brief",req_id:1}));};
 socket.onerror=()=>{state.socket="ERROR";};
 socket.onclose=()=>{state.socket="DISCONNECTED";if(!stopping)scheduleReconnect();};
 socket.onmessage=async event=>{
  let msg;try{msg=JSON.parse(typeof event.data==="string"?event.data:event.data.toString());}catch{return;}
  if(msg.error){logError(new Error("Deriv rejected the public streaming request."));return;}
  if(msg.msg_type==="active_symbols"){
   const active=Array.isArray(msg.active_symbols)?msg.active_symbols:[];
   for(const wanted of desired){
    const found=active.find(a=>String(a.underlying_symbol||a.symbol||"")===wanted.providerSymbol);
    if(!found)continue;
    const ch=db.channel("scalping-market:"+wanted.instrument);
    channels.set(wanted.instrument,ch);
    await ch.subscribe();
    socket.send(JSON.stringify({ticks:wanted.providerSymbol,subscribe:1}));
   }
  }
  if(msg.msg_type==="tick"&&msg.tick){
   const instrument=desired.find(x=>x.providerSymbol===String(msg.tick.symbol||""))?.instrument;
   if(instrument)await publishTick(instrument,msg.tick);
  }
 };
}
function closeSocket(){if(socket){try{socket.onclose=null;socket.close();}catch{}socket=null;}state.socket="DISCONNECTED";}
function scheduleReconnect(){if(stopping||reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;reconcile().catch(logError);},retry);retry=Math.min(retry*2,30000);}
async function reconcile(){
 if(stopping)return;
 try{const desired=await eligibleSymbols();await subscribeSet(desired);state.lastError=null;}
 catch(e){logError(e);scheduleReconnect();}
}
server.listen(PORT,()=>console.log("Young Tiger continuous DEMO scalping feed listening on",PORT));
reconcile().catch(logError);
reconcileTimer=setInterval(()=>reconcile().catch(logError),10000);
process.on("SIGTERM",()=>{stopping=true;clearInterval(reconcileTimer);if(reconnectTimer)clearTimeout(reconnectTimer);closeSocket();server.close();});
process.on("SIGINT",()=>{stopping=true;clearInterval(reconcileTimer);if(reconnectTimer)clearTimeout(reconnectTimer);closeSocket();server.close();});
