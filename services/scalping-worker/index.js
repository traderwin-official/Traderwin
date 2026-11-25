import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { analyseScalping } from "./lib/scalping-engine.js";

const PORT=Number(process.env.PORT||8080),URL=process.env.SUPABASE_URL,KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENDPOINT="wss://api.derivws.com/trading/v1/options/ws/public";
const norm=v=>String(v||"").trim().toUpperCase().replace(/[\\s/.-]/g,"");
const state={startedAt:new Date().toISOString(),socket:"DISCONNECTED",lastTickAt:null,lastSignalAt:null,lastError:null,subscribed:[],readySymbols:[],ticks:0,signals:0};
if(!URL||!KEY||KEY.length<30)throw new Error("SUPABASE_URL and service-role key are required.");
const db=createClient(URL,KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const channels=new Map(),lastPersisted=new Map(),history=new Map(),lastSignal=new Map();
let socket=null,stopping=false,retry=1000,reconnectTimer=null,reconcileTimer=null;
const server=http.createServer((req,res)=>{
 if(req.url==="/healthz"){const healthy=state.socket==="IDLE_NO_OPTED_IN_DEMO_SESSIONS"||(state.socket==="CONNECTED"&&state.readySymbols.length>0);res.writeHead(healthy?200:503,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({...state,service:"young-tiger-scalping-worker",execution:"SIGNAL_ONLY_NO_ORDERS"}));}
 res.writeHead(404);res.end();
});
function logError(e){state.lastError=String(e?.message||e).slice(0,240);console.error("scalping-worker:",state.lastError);}
async function eligibleSymbols(){
 const {data:sessions,error}=await db.from("demo_paper_sessions").select("id,user_id,instrument,broker,status").eq("broker","DERIV").eq("status","RUNNING").limit(200);
 if(error)throw error;
 const candidates=(sessions||[]).filter(s=>s.instrument);
 if(!candidates.length)return [];
 const {data:preferences,error:preferenceError}=await db.from("demo_scalping_preferences").select("session_id,user_id,enabled,account_mode,execution").in("session_id",candidates.map(s=>s.id)).eq("enabled",true).eq("account_mode","DEMO").eq("execution","WEBSITE_PAPER_ONLY");
 if(preferenceError)throw preferenceError;
 const opted=new Set((preferences||[]).filter(p=>candidates.some(s=>s.id===p.session_id&&s.user_id===p.user_id)).map(p=>p.session_id));
 const wanted=new Set(candidates.filter(s=>opted.has(s.id)).map(s=>norm(s.instrument)));
 if(!wanted.size)return [];
 const {data:approved,error:approvalError}=await db.from("trading_instrument_approvals").select("instrument,provider_symbol,status,is_active").eq("broker","DERIV").eq("status","APPROVED").eq("is_active",true).in("instrument",[...wanted]);
 if(approvalError)throw approvalError;
 return (approved||[]).filter(a=>wanted.has(norm(a.instrument))&&a.provider_symbol).map(a=>({instrument:norm(a.instrument),providerSymbol:String(a.provider_symbol)}));
}
function validCandle(c){return c&&[c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.epoch>0&&c.low>0&&c.high>=c.low&&c.open>=c.low&&c.open<=c.high&&c.close>=c.low&&c.close<=c.high;}
function aggregateM5(m1){
 const groups=new Map();
 for(const c of m1){const epoch=Math.floor(c.epoch/300)*300;const g=groups.get(epoch)||{epoch,open:c.open,high:c.high,low:c.low,close:c.close,count:0};g.high=Math.max(g.high,c.high);g.low=Math.min(g.low,c.low);g.close=c.close;g.count++;groups.set(epoch,g);}
 return [...groups.values()].filter(g=>g.count===5).map(({count,...c})=>c).slice(-60);
}
async function saveSignal(instrument,result,candleEpoch){
 const key=instrument+":"+candleEpoch+":"+result.direction;
 if(lastSignal.get(instrument)===key)return;
 const signal={instrument,direction:result.direction,confidence:result.confidence,entry:result.entry,stop_loss:result.stopLoss,take_profit:result.takeProfit,risk_reward:result.riskReward,reason:result.reason,indicators:result.indicators,source:"DERIV",signal_as_of:result.signalAsOf,candle_epoch:candleEpoch,status:"CANDIDATE"};
 const {error}=await db.from("scalping_signal_events").upsert(signal,{onConflict:"instrument,candle_epoch,direction",ignoreDuplicates:true});
 if(error){logError(error);return;}
 lastSignal.set(instrument,key);
 state.signals++;state.lastSignalAt=new Date().toISOString();
 const ch=channels.get(instrument);if(ch)await ch.send({type:"broadcast",event:"signal",payload:signal});
}
async function publishTick(instrument,tick){
 const quote=Number(tick.quote),epoch=Number(tick.epoch),providerSymbol=String(tick.symbol||"");
 const quoteAsOf=new Date(epoch*1000).toISOString(),receivedAt=new Date().toISOString();
 if(!Number.isFinite(quote)||quote<=0||!Number.isFinite(epoch)||Math.abs(Date.now()-epoch*1000)>30000)return;
 const payload={instrument,providerSymbol,quote,bid:typeof tick.bid==="number"&&Number.isFinite(tick.bid)&&tick.bid>0?tick.bid:null,ask:typeof tick.ask==="number"&&Number.isFinite(tick.ask)&&tick.ask>0?tick.ask:null,quoteAsOf,receivedAt,source:"DERIV"};
 state.lastTickAt=receivedAt;state.ticks++;
 const ch=channels.get(instrument);if(ch)await ch.send({type:"broadcast",event:"tick",payload});
 if(Date.now()-(lastPersisted.get(instrument)||0)>=1000){
  lastPersisted.set(instrument,Date.now());
  const {error}=await db.from("scalping_market_ticks").upsert({instrument,provider_symbol:providerSymbol,quote,bid:payload.bid,ask:payload.ask,quote_as_of:quoteAsOf,received_at:receivedAt,source:"DERIV",updated_at:receivedAt},{onConflict:"instrument"});
  if(error)logError(error);
 }
 const h=history.get(instrument);if(!h||h.m1.length<35)return;
 const minute=Math.floor(epoch/60)*60;
 if(!h.current||minute>h.current.epoch){
  if(h.current&&h.current.epoch+60<=minute){h.m1.push(h.current);h.m1=h.m1.slice(-240);}
  h.current={epoch:minute,open:quote,high:quote,low:quote,close:quote};
 }else{h.current.high=Math.max(h.current.high,quote);h.current.low=Math.min(h.current.low,quote);h.current.close=quote;}
 const m5=aggregateM5(h.m1);
 if(m5.length<25||payload.bid===null||payload.ask===null)return;
 const result=analyseScalping({instrument,candles:h.m1.slice(-180),trendCandles:m5,tick:payload,now:Date.now()});
 if(result.direction==="BUY"||result.direction==="SELL")await saveSignal(instrument,result,h.m1.at(-1).epoch);
}
function closeSocket(){if(socket){try{socket.onclose=null;socket.close();}catch{}socket=null;}state.socket="DISCONNECTED";}
async function subscribeSet(desired){
 const list=desired.map(x=>x.providerSymbol).sort();
 if(JSON.stringify(list)===JSON.stringify(state.subscribed.slice().sort())&&["CONNECTED","CONNECTING"].includes(state.socket))return;
 closeSocket();for(const c of channels.values())await db.removeChannel(c).catch(()=>{});channels.clear();history.clear();state.readySymbols=[];state.subscribed=list;
 if(!list.length){state.socket="IDLE_NO_OPTED_IN_DEMO_SESSIONS";return;}
 socket=new WebSocket(ENDPOINT);state.socket="CONNECTING";
 const requestMap=new Map();let nextId=100;
 socket.onopen=()=>{retry=1000;state.socket="CONNECTED";socket.send(JSON.stringify({active_symbols:"brief",req_id:1}));};
 socket.onerror=()=>{state.socket="ERROR";};
 socket.onclose=()=>{state.socket="DISCONNECTED";if(!stopping)scheduleReconnect();};
 socket.onmessage=async event=>{
  let msg;try{msg=JSON.parse(typeof event.data==="string"?event.data:event.data.toString());}catch{return;}
  if(msg.error){logError(new Error("Deriv rejected the public streaming request."));return;}
  if(msg.msg_type==="active_symbols"){
   const active=Array.isArray(msg.active_symbols)?msg.active_symbols:[];
   for(const wanted of desired){
    const found=active.find(a=>String(a.underlying_symbol||a.symbol||"")===wanted.providerSymbol);if(!found){logError(new Error("Approved provider symbol is not currently active on Deriv."));closeSocket();scheduleReconnect();return;}
    const ch=db.channel("scalping-market:"+wanted.instrument);channels.set(wanted.instrument,ch);await ch.subscribe();
    const m1Id=nextId++,m5Id=nextId++;requestMap.set(m1Id,{instrument:wanted.instrument,kind:"M1"});requestMap.set(m5Id,{instrument:wanted.instrument,kind:"M5"});
    socket.send(JSON.stringify({ticks_history:wanted.providerSymbol,count:180,end:"latest",style:"candles",granularity:60,req_id:m1Id}));
    socket.send(JSON.stringify({ticks_history:wanted.providerSymbol,count:60,end:"latest",style:"candles",granularity:300,req_id:m5Id}));
   }
  }
  if(msg.msg_type==="candles"&&requestMap.has(Number(msg.req_id))){
   const req=requestMap.get(Number(msg.req_id));const candles=(msg.candles||[]).map(c=>({epoch:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)})).filter(validCandle).filter(c=>(c.epoch+(req.kind==="M1"?60:300))*1000<=Date.now());
   const h=history.get(req.instrument)||{m1:[],m5:[],current:null,loadedM1:false,loadedM5:false};
   h[req.kind.toLowerCase()]=candles.slice(-240);h[req.kind.toLowerCase()==="m1"?"loadedM1":"loadedM5"]=true;history.set(req.instrument,h);
   if(h.loadedM1&&h.loadedM5){
    if(h.m1.length<35||h.m5.length<25){logError(new Error("Deriv did not provide enough completed M1/M5 history to warm up the scalping engine."));closeSocket();scheduleReconnect();return;}
    if(!h.subscribed){h.subscribed=true;const wanted=desired.find(x=>x.instrument===req.instrument);socket.send(JSON.stringify({ticks:wanted.providerSymbol,subscribe:1}));state.readySymbols.push(req.instrument);}
   }
  }
  if(msg.msg_type==="tick"&&msg.tick){const instrument=desired.find(x=>x.providerSymbol===String(msg.tick.symbol||""))?.instrument;if(instrument)await publishTick(instrument,msg.tick);}
 };
}
function scheduleReconnect(){if(stopping||reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;reconcile().catch(logError);},retry);retry=Math.min(retry*2,30000);}
async function reconcile(){if(stopping)return;try{const desired=await eligibleSymbols();await subscribeSet(desired);state.lastError=null;}catch(e){logError(e);scheduleReconnect();}}
server.listen(PORT,()=>console.log("Young Tiger continuous DEMO scalping signal worker listening on",PORT));
reconcile().catch(logError);reconcileTimer=setInterval(()=>reconcile().catch(logError),10000);
function shutdown(){stopping=true;clearInterval(reconcileTimer);if(reconnectTimer)clearTimeout(reconnectTimer);closeSocket();server.close();}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
