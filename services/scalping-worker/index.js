import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { analyseScalping, mergeCompletedM5 } from "./lib/scalping-engine.js";
import { getDerivQuoteToUsd } from "./lib/usd-conversion.js";
import { openScalpingPaperPosition, manageScalpingPaperPosition } from "./lib/scalping-paper-adapter.js";

const PORT=Number(process.env.PORT||8080),URL=process.env.SUPABASE_URL,KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENDPOINT="wss://api.derivws.com/trading/v1/options/ws/public";
const SCALPING_STRATEGY="TIGER_SCHEME_QUANTUM_SCALPING";
const norm=v=>String(v||"").trim().toUpperCase().replace(/[\\s/.-]/g,"");
const state={startedAt:new Date().toISOString(),socket:"DISCONNECTED",lastTickAt:null,lastSignalAt:null,lastPaperEntryAt:null,lastPaperExitAt:null,lastEntryReason:null,lastError:null,subscribed:[],readySymbols:[],ticks:0,signals:0,paperEntries:0,paperExits:0};
if(!URL||!KEY||KEY.length<30)throw new Error("SUPABASE_URL and service-role key are required.");
const db=createClient(URL,KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const lastPersisted=new Map(),history=new Map(),lastSignal=new Map(),activeTrades=new Map(),tradeLocks=new Set(),lastMarked=new Map();
let socket=null,stopping=false,retry=1000,reconnectTimer=null,reconcileTimer=null,tradeRefreshTimer=null,desiredSymbols=[];
const server=http.createServer((req,res)=>{
 if(req.url==="/healthz"){const healthy=state.socket==="IDLE_NO_OPTED_IN_DEMO_SESSIONS"||(state.socket==="CONNECTED"&&state.readySymbols.length>0);res.writeHead(healthy?200:503,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({...state,service:"young-tiger-scalping-worker",execution:"DEMO_PAPER_ONLY_NO_BROKER_ORDERS"}));}
 res.writeHead(404);res.end();
});
function logError(e){state.lastError=String(e?.message||e).slice(0,240);console.error("scalping-worker:",state.lastError);}

async function eligibleSymbols(){
 const {data:runningSessions,error:sessionError}=await db.from("demo_paper_sessions")
  .select("id,user_id,instrument,broker,status,current_balance,config_snapshot")
  .eq("broker","DERIV").eq("status","RUNNING").limit(200);
 if(sessionError)throw sessionError;
 const {data:openRows,error:tradeError}=await db.from("demo_paper_trades")
  .select("id,user_id,session_id,instrument,metadata")
  .eq("status","OPEN").eq("trade_origin","BOT")
  .contains("metadata",{strategy:SCALPING_STRATEGY}).limit(200);
 if(tradeError)throw tradeError;
 const openTrades=openRows||[];
 const openSessionIds=[...new Set(openTrades.map(t=>t.session_id).filter(Boolean))];
 let openSessions=[];
 if(openSessionIds.length){
  const {data,error}=await db.from("demo_paper_sessions")
   .select("id,user_id,instrument,broker,status,current_balance,config_snapshot")
   .eq("broker","DERIV").in("id",openSessionIds);
  if(error)throw error;
  openSessions=data||[];
 }
 const allSessions=[...new Map([...(runningSessions||[]),...openSessions].map(s=>[s.id,s])).values()];
 if(!allSessions.length)return [];
 const {data:preferences,error:preferenceError}=await db.from("demo_scalping_preferences")
  .select("session_id,user_id,enabled,account_mode,execution,max_risk_per_trade_pct,max_daily_loss_pct,max_open_positions")
  .in("session_id",allSessions.map(s=>s.id));
 if(preferenceError)throw preferenceError;
 const preferenceBySession=new Map((preferences||[]).filter(p=>allSessions.some(s=>s.id===p.session_id&&s.user_id===p.user_id)).map(p=>[p.session_id,p]));
 const openSessionSet=new Set(openSessionIds);
 const wantedByInstrument=new Map();
 for(const session of allSessions){
  const config=session.config_snapshot&&typeof session.config_snapshot==="object"?session.config_snapshot:{};
  if(session.broker!=="DERIV"||!session.instrument||config.account_mode!=="DEMO")continue;
  const preference=preferenceBySession.get(session.id)||null;
  const entryEnabled=session.status==="RUNNING"&&preference?.enabled===true&&preference.account_mode==="DEMO"&&preference.execution==="WEBSITE_PAPER_ONLY";
  const manageOpen=openSessionSet.has(session.id);
  if(!entryEnabled&&!manageOpen)continue;
  const instrument=norm(session.instrument);
  const row={session,preference,entryEnabled,manageOpen};
  const group=wantedByInstrument.get(instrument)||{instrument,sessions:[]};
  group.sessions.push(row);wantedByInstrument.set(instrument,group);
 }
 if(!wantedByInstrument.size)return [];
 const instruments=[...wantedByInstrument.keys()];
 const {data:approved,error:approvalError}=await db.from("trading_instrument_approvals")
  .select("instrument,provider_symbol,status,is_active").eq("broker","DERIV")
  .eq("status","APPROVED").eq("is_active",true).in("instrument",instruments);
 if(approvalError)throw approvalError;
 return (approved||[]).filter(a=>wantedByInstrument.has(norm(a.instrument))&&a.provider_symbol)
  .map(a=>({...wantedByInstrument.get(norm(a.instrument)),providerSymbol:String(a.provider_symbol)}));
}

async function refreshOpenTrades(){
 const {data,error}=await db.from("demo_paper_trades")
  .select("id,user_id,session_id,instrument,side,entry_price,stop_loss,tp1_price,tp2_price,tp3_price,tp1_done,tp2_done,tp3_done,quantity,remaining_quantity,quote_to_usd,quote_as_of,trade_origin,status,metadata")
  .eq("status","OPEN").eq("trade_origin","BOT")
  .contains("metadata",{strategy:SCALPING_STRATEGY}).limit(200);
 if(error)throw error;
 activeTrades.clear();
 for(const trade of data||[])activeTrades.set(trade.id,trade);
}

async function manageOpenTrades(instrument,tick){
 for(const trade of activeTrades.values()){
  if(norm(trade.instrument)!==norm(instrument)||tradeLocks.has(trade.id))continue;
  tradeLocks.add(trade.id);
  try{
   const result=await manageScalpingPaperPosition({db,trade,tick,now:Date.now()});
   if(result.action==="EXIT"&&result.result?.ok===true){
    state.paperExits++;state.lastPaperExitAt=new Date().toISOString();
    if(result.stage==="TP1")trade.tp1_done=true;
    if(result.stage==="TP2")trade.tp2_done=true;
    if(result.stage==="TP3"||result.stage==="STOP_LOSS"||result.result.closed===true)activeTrades.delete(trade.id);
   }
   if(result.action==="HOLD"){
    const last=lastMarked.get(trade.id)||0;
    if(Date.now()-last>=1000){
     lastMarked.set(trade.id,Date.now());
     const {error}=await db.rpc("mark_demo_paper_trade",{p_user_id:trade.user_id,p_trade_id:trade.id,p_price:Number(tick.quote),p_quote_as_of:tick.quoteAsOf});
     if(error)logError(error);
    }
   }
  }catch(e){logError(e);}finally{tradeLocks.delete(trade.id);}
 }
}

async function saveSignal(wanted,result,candleEpoch,tick){
 const key=wanted.instrument+":"+candleEpoch+":"+result.direction;
 const signal={instrument:wanted.instrument,direction:result.direction,confidence:result.confidence,entry:result.entry,stop_loss:result.stopLoss,take_profit:result.takeProfit,risk_reward:result.riskReward,reason:result.reason,indicators:result.indicators,source:"DERIV",signal_as_of:result.signalAsOf,candle_epoch:candleEpoch,status:"CANDIDATE"};
 if(lastSignal.get(wanted.instrument)!==key){
  const {error}=await db.from("scalping_signal_events").upsert(signal,{onConflict:"instrument,candle_epoch,direction",ignoreDuplicates:true});
  if(error){logError(error);return;}
  lastSignal.set(wanted.instrument,key);state.signals++;state.lastSignalAt=new Date().toISOString();
 }
 for(const item of wanted.sessions.filter(x=>x.entryEnabled)){
  try{
   const conversion=await getDerivQuoteToUsd(wanted.instrument,tick);
   const opened=await openScalpingPaperPosition({db,session:item.session,preference:item.preference,signal:{...result,instrument:wanted.instrument},tick,candleEpoch,quoteToUsd:conversion.rate,now:Date.now()});
   if(opened?.ok===true){state.paperEntries++;state.lastPaperEntryAt=new Date().toISOString();state.lastEntryReason=null;}
   else state.lastEntryReason=opened?.reason||"SCALPING_ENTRY_NOT_ACCEPTED";
  }catch(e){state.lastEntryReason=String(e?.message||e).slice(0,180);logError(e);}
 }
}

async function publishTick(wanted,tick){
 const quote=Number(tick.quote),epoch=Number(tick.epoch),providerSymbol=String(tick.symbol||"");
 const quoteAsOf=new Date(epoch*1000).toISOString(),receivedAt=new Date().toISOString();
 if(!Number.isFinite(quote)||quote<=0||!Number.isFinite(epoch)||Math.abs(Date.now()-epoch*1000)>30000)return;
 const payload={instrument:wanted.instrument,providerSymbol,quote,bid:typeof tick.bid==="number"&&Number.isFinite(tick.bid)&&tick.bid>0?tick.bid:null,ask:typeof tick.ask==="number"&&Number.isFinite(tick.ask)&&tick.ask>0?tick.ask:null,quoteAsOf,receivedAt,source:"DERIV"};
 state.lastTickAt=receivedAt;state.ticks++;
 await manageOpenTrades(wanted.instrument,payload);
 if(Date.now()-(lastPersisted.get(wanted.instrument)||0)>=1000){
  lastPersisted.set(wanted.instrument,Date.now());
  const {error}=await db.from("scalping_market_ticks").upsert({instrument:wanted.instrument,provider_symbol:providerSymbol,quote,bid:payload.bid,ask:payload.ask,quote_as_of:quoteAsOf,received_at:receivedAt,source:"DERIV",updated_at:receivedAt},{onConflict:"instrument"});
  if(error)logError(error);
 }
 const h=history.get(wanted.instrument);if(!h||h.m1.length<35)return;
 const minute=Math.floor(epoch/60)*60;
 if(!h.current||minute>h.current.epoch){
  if(h.current&&h.current.epoch+60<=minute){h.m1.push(h.current);h.m1=h.m1.slice(-240);}
  h.current={epoch:minute,open:quote,high:quote,low:quote,close:quote};
 }else{h.current.high=Math.max(h.current.high,quote);h.current.low=Math.min(h.current.low,quote);h.current.close=quote;}
 if(!wanted.sessions.some(x=>x.entryEnabled))return;
 const m5=mergeCompletedM5(h.m5,h.m1);
 if(m5.length<25||payload.bid===null||payload.ask===null)return;
 const result=analyseScalping({instrument:wanted.instrument,candles:h.m1.slice(-180),trendCandles:m5,tick:payload,now:Date.now()});
 if(result.direction==="BUY"||result.direction==="SELL")await saveSignal(wanted,result,h.m1.at(-1).epoch,payload);
}

function closeSocket(){if(socket){try{socket.onclose=null;socket.close();}catch{}socket=null;}state.socket="DISCONNECTED";}
async function subscribeSet(desired){
 desiredSymbols=desired;
 const list=desired.map(x=>x.providerSymbol).sort();
 if(JSON.stringify(list)===JSON.stringify(state.subscribed.slice().sort())&&["CONNECTED","CONNECTING"].includes(state.socket))return;
 closeSocket();history.clear();state.readySymbols=[];state.subscribed=list;
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
   for(const wanted of desiredSymbols){
    const found=active.find(a=>String(a.underlying_symbol||a.symbol||"")===wanted.providerSymbol);
    if(!found){logError(new Error("Approved provider symbol is not currently active on Deriv."));closeSocket();scheduleReconnect();return;}
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
    if(!h.subscribed){h.subscribed=true;const wanted=desiredSymbols.find(x=>x.instrument===req.instrument);if(!wanted) return;socket.send(JSON.stringify({ticks:wanted.providerSymbol,subscribe:1}));state.readySymbols.push(req.instrument);}
   }
  }
  if(msg.msg_type==="tick"&&msg.tick){
   const wanted=desiredSymbols.find(x=>x.providerSymbol===String(msg.tick.symbol||""));
   if(wanted)await publishTick(wanted,msg.tick);
  }
 };
}
function validCandle(c){return c&&[c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.epoch>0&&c.low>0&&c.high>=c.low&&c.open>=c.low&&c.open<=c.high&&c.close>=c.low&&c.close<=c.high;}
function scheduleReconnect(){if(stopping||reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;reconcile().catch(logError);},retry);retry=Math.min(retry*2,30000);}
async function reconcile(){if(stopping)return;try{const desired=await eligibleSymbols();await subscribeSet(desired);state.lastError=null;}catch(e){logError(e);scheduleReconnect();}}
server.listen(PORT,()=>console.log("Young Tiger continuous DEMO scalping paper worker listening on",PORT));
reconcile().catch(logError);
reconcileTimer=setInterval(()=>reconcile().catch(logError),10000);
refreshOpenTrades().catch(logError);
tradeRefreshTimer=setInterval(()=>refreshOpenTrades().catch(logError),1000);
function shutdown(){stopping=true;clearInterval(reconcileTimer);clearInterval(tradeRefreshTimer);if(reconnectTimer)clearTimeout(reconnectTimer);closeSocket();server.close();}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
