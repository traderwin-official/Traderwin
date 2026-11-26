import http from "node:http";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { analyseScalping, mergeCompletedM5, latestContiguousCandles } from "./lib/scalping-engine.js";
import { getDerivQuoteToUsd } from "./lib/usd-conversion.js";
import { openScalpingPaperPosition, manageScalpingPaperPosition } from "./lib/scalping-paper-adapter.js";
import { scalpingSessionPermissions } from "../../lib/scalping-session-eligibility.js";

const PORT=Number(process.env.PORT||8080),URL=process.env.SUPABASE_URL,KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENDPOINT="wss://api.derivws.com/trading/v1/options/ws/public";
const SCALPING_STRATEGY="TIGER_SCHEME_QUANTUM_SCALPING";
const norm=v=>String(v||"").trim().toUpperCase().replace(/[\s/.-]/g,"");
const state={startedAt:new Date().toISOString(),socket:"DISCONNECTED",lastTickAt:null,lastSignalAt:null,lastPaperEntryAt:null,lastPaperExitAt:null,lastEntryReason:null,lastError:null,subscribed:[],readySymbols:[],ticks:0,signals:0,paperEntries:0,paperExits:0,bidAskMissingTicks:0,marketDataQuality:{},leaseOwned:false,leaseLastRenewedAt:null,leaseLastError:null,stopping:false};
if(!URL||!KEY||KEY.length<30)throw new Error("SUPABASE_URL and service-role key are required.");
const db=createClient(URL,KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const lastPersisted=new Map(),history=new Map(),lastSignal=new Map(),lastEntryAttempt=new Map(),activeTrades=new Map(),tradeLocks=new Set(),lastMarked=new Map();
let socket=null,stopping=false,leaseOwned=false,retry=1000,reconnectTimer=null,reconcileTimer=null,tradeRefreshTimer=null,contextRefreshTimers=new Map(),desiredSymbols=[];
const leaseToken=randomUUID();
const server=http.createServer((req,res)=>{
 if(req.url==="/healthz"){const leaseRenewedAt=Date.parse(state.leaseLastRenewedAt);const leaseAgeMs=Date.now()-leaseRenewedAt;const leaseFresh=Number.isFinite(leaseRenewedAt)&&leaseAgeMs>=0&&leaseAgeMs<=30000;const healthy=leaseOwned&&leaseFresh&&!stopping&&!state.lastError&&(state.socket==="IDLE_NO_OPTED_IN_DEMO_SESSIONS"||(state.socket==="CONNECTED"&&state.readySymbols.length>0));res.writeHead(healthy?200:503,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({...state,service:"young-tiger-scalping-worker",execution:"DEMO_PAPER_ONLY_NO_BROKER_ORDERS"}));}
 res.writeHead(404);res.end();
});
function logError(e){state.lastError=String(e?.message||e).slice(0,240);console.error("scalping-worker:",state.lastError);}

async function eligibleSymbols(){
 const {data:runningSessions,error:sessionError}=await db.from("demo_paper_sessions")
  .select("id,user_id,instrument,broker,status,starting_balance,current_balance,risk_per_trade_pct,max_open_positions,max_total_open_risk_pct,config_snapshot")
  .eq("broker","DERIV").eq("status","RUNNING").limit(1000);
 if(sessionError)throw sessionError;
 const {data:openRows,error:tradeError}=await db.from("demo_paper_trades")
  .select("id,user_id,session_id,instrument,metadata")
  .eq("status","OPEN").eq("trade_origin","BOT")
  .contains("metadata",{strategy:SCALPING_STRATEGY}).limit(1000);
 if(tradeError)throw tradeError;
 const openTrades=openRows||[];
 const openSessionIds=[...new Set(openTrades.map(t=>t.session_id).filter(Boolean))];
 let openSessions=[];
 if(openSessionIds.length){
  const {data,error}=await db.from("demo_paper_sessions")
   .select("id,user_id,instrument,broker,status,starting_balance,current_balance,risk_per_trade_pct,max_open_positions,max_total_open_risk_pct,config_snapshot")
   .eq("broker","DERIV").in("id",openSessionIds);
  if(error)throw error;
  openSessions=data||[];
 }
 const allSessions=[...new Map([...(runningSessions||[]),...openSessions].map(s=>[s.id,s])).values()];
 if(!allSessions.length)return [];
 const {data:preferences,error:preferenceError}=await db.from("demo_scalping_preferences")
  .select("session_id,user_id,enabled,paper_execution_enabled,account_mode,execution,max_risk_per_trade_pct,max_daily_loss_pct,max_open_positions")
  .in("session_id",allSessions.map(s=>s.id));
 if(preferenceError)throw preferenceError;
 const preferenceBySession=new Map((preferences||[]).filter(p=>allSessions.some(s=>s.id===p.session_id&&s.user_id===p.user_id)).map(p=>[p.session_id,p]));
 const {data:profiles,error:profileError}=await db.from("trader_profiles")
  .select("user_id,account_mode").in("user_id",[...new Set(allSessions.map(s=>s.user_id))]);
 if(profileError)throw profileError;
 const profileByUser=new Map((profiles||[]).map(p=>[p.user_id,p]));
 const openSessionSet=new Set(openSessionIds);
 const wantedByInstrument=new Map();
 for(const session of allSessions){
  if(session.broker!=="DERIV"||!session.instrument)continue;
  const preference=preferenceBySession.get(session.id)||null;
  const permissions=scalpingSessionPermissions({
   session,
   preference,
   profile:profileByUser.get(session.user_id),
   hasOpenTrade:openSessionSet.has(session.id)
  });
  if(!permissions.include)continue;
  const instrument=norm(session.instrument);
  const row={session,preference,entryEnabled:permissions.entryEnabled,manageOpen:permissions.manageOpen};
  const group=wantedByInstrument.get(instrument)||{instrument,sessions:[]};
  group.sessions.push(row);wantedByInstrument.set(instrument,group);
 }
 if(!wantedByInstrument.size)return [];
 const instruments=[...wantedByInstrument.keys()];
 const {data:registry,error:approvalError}=await db.from("trading_instrument_approvals")
  .select("instrument,provider_symbol,status,is_active").eq("broker","DERIV").in("instrument",instruments);
 if(approvalError)throw approvalError;
 const desired=[];
 for(const row of registry||[]){
  const group=wantedByInstrument.get(norm(row.instrument));
  if(!group||!row.provider_symbol)continue;
  const canEnter=row.status==="APPROVED"&&row.is_active===true;
  const canManage=group.sessions.some(x=>x.manageOpen);
  if(!canEnter&&!canManage)continue;
  desired.push({...group,sessions:group.sessions.map(x=>({...x,entryEnabled:x.entryEnabled&&canEnter})),providerSymbol:String(row.provider_symbol)});
 }
 const unresolvedOpenPositions=[...wantedByInstrument.values()]
  .filter(group=>group.sessions.some(x=>x.manageOpen)&&!desired.some(x=>x.instrument===group.instrument));
 if(unresolvedOpenPositions.length){
  throw new Error("OPEN_SCALPING_POSITION_PROVIDER_MAPPING_MISSING: "+unresolvedOpenPositions.map(x=>x.instrument).join(","));
 }
 return desired;
}

async function refreshOpenTrades(){
 const {data,error}=await db.from("demo_paper_trades")
  .select("id,user_id,session_id,instrument,side,entry_price,stop_loss,tp1_price,tp2_price,tp3_price,tp1_done,tp2_done,tp3_done,quantity,remaining_quantity,quote_to_usd,quote_as_of,trade_origin,status,metadata")
  .eq("status","OPEN").eq("trade_origin","BOT")
  .contains("metadata",{strategy:SCALPING_STRATEGY}).limit(1000);
 if(error)throw error;
 const seen=new Set();
 for(const trade of data||[]){
  seen.add(trade.id);
  if(!tradeLocks.has(trade.id))activeTrades.set(trade.id,trade);
 }
 for(const id of activeTrades.keys()){
  if(!seen.has(id)&&!tradeLocks.has(id)){activeTrades.delete(id);lastMarked.delete(id);}
 }
}

async function manageOpenTrades(instrument,tick){
 const trades=[...activeTrades.values()].filter(trade=>norm(trade.instrument)===norm(instrument)&&!tradeLocks.has(trade.id));
 const outcomes=await Promise.all(trades.map(async trade=>{
  tradeLocks.add(trade.id);
  try{
   const result=await manageScalpingPaperPosition({db,trade,tick,leaseToken,now:Date.now()});
   if(result.action==="EXIT"&&result.result?.ok===true){
    state.paperExits++;state.lastPaperExitAt=new Date().toISOString();
    if(result.stage==="TP1")trade.tp1_done=true;
    if(result.stage==="TP2")trade.tp2_done=true;
    if(result.stage==="TP3"||result.stage==="STOP_LOSS"||result.result.closed===true){
     activeTrades.delete(trade.id);lastMarked.delete(trade.id);
    }else activeTrades.set(trade.id,trade);
   }
   if(result.action==="HOLD"){
    const markPrice=Number(trade.side==="BUY"?tick.bid:tick.ask);
    if(Number.isFinite(markPrice)&&markPrice>0){
     const last=lastMarked.get(trade.id)||0;
     if(Date.now()-last>=1000){
      lastMarked.set(trade.id,Date.now());
      const {error}=await db.rpc("mark_demo_scalping_paper_trade_with_lease",{p_lease_token:leaseToken,p_user_id:trade.user_id,p_trade_id:trade.id,p_price:markPrice,p_quote_as_of:tick.quoteAsOf});
      if(error)throw error;
     }
    }
   }
   return true;
  }catch(e){logError(e);return false;}
  finally{tradeLocks.delete(trade.id);}
 }));
 return outcomes.every(Boolean);
}

async function saveSignal(wanted,result,candleEpoch,tick){
 const key=wanted.instrument+":"+candleEpoch+":"+result.direction;
 const signal={instrument:wanted.instrument,direction:result.direction,confidence:result.confidence,entry:result.entry,stop_loss:result.stopLoss,take_profit:result.takeProfit,risk_reward:result.riskReward,reason:result.reason,indicators:result.indicators,source:"DERIV",signal_as_of:result.signalAsOf,candle_epoch:candleEpoch,status:"CANDIDATE"};
 if(lastSignal.get(wanted.instrument)!==key){
  const {error}=await db.from("scalping_signal_events").upsert(signal,{onConflict:"instrument,candle_epoch,direction",ignoreDuplicates:true});
  if(error){logError(error);return;}
  lastSignal.set(wanted.instrument,key);state.signals++;state.lastSignalAt=new Date().toISOString();
 }
 if(!leaseOwned||stopping)return;
 const ready=wanted.sessions.filter(x=>x.entryEnabled&&lastEntryAttempt.get(x.session.id)!==candleEpoch);
 if(!ready.length)return;
 for(const item of ready)lastEntryAttempt.set(item.session.id,candleEpoch);
 let conversion;
 try{conversion=await getDerivQuoteToUsd(wanted.instrument,tick);}
 catch(e){state.lastEntryReason=String(e?.message||e).slice(0,180);logError(e);return;}
 if(!leaseOwned||stopping)return;
 await Promise.all(ready.map(async item=>{
  try{
   const opened=await openScalpingPaperPosition({db,leaseToken,session:item.session,preference:item.preference,signal:{...result,instrument:wanted.instrument},tick,candleEpoch,quoteToUsd:conversion.rate,now:Date.now()});
   if(opened?.ok===true){
    state.paperEntries++;state.lastPaperEntryAt=new Date().toISOString();state.lastEntryReason=null;
    if(opened.trade_id){
     const {data:trade,error:tradeLoadError}=await db.from("demo_paper_trades")
      .select("id,user_id,session_id,instrument,side,entry_price,stop_loss,tp1_price,tp2_price,tp3_price,tp1_done,tp2_done,tp3_done,quantity,remaining_quantity,quote_to_usd,quote_as_of,trade_origin,status,metadata")
      .eq("id",opened.trade_id).maybeSingle();
     if(tradeLoadError)logError(tradeLoadError);else if(trade?.status==="OPEN")activeTrades.set(trade.id,trade);
    }
   }else state.lastEntryReason=opened?.reason||"SCALPING_ENTRY_NOT_ACCEPTED";
  }catch(e){state.lastEntryReason=String(e?.message||e).slice(0,180);logError(e);}
 }));
}

async function publishTick(wanted,tick){
 const quote=Number(tick.quote),epoch=Number(tick.epoch),providerSymbol=String(tick.symbol||"");
 const quoteAsOf=new Date(epoch*1000).toISOString(),receivedAt=new Date().toISOString();
 if(!Number.isFinite(quote)||quote<=0||!Number.isFinite(epoch)||Math.abs(Date.now()-epoch*1000)>30000)return;
 const payload={instrument:wanted.instrument,providerSymbol,quote,bid:typeof tick.bid==="number"&&Number.isFinite(tick.bid)&&tick.bid>0?tick.bid:null,ask:typeof tick.ask==="number"&&Number.isFinite(tick.ask)&&tick.ask>0?tick.ask:null,quoteAsOf,receivedAt,source:"DERIV"};
 state.lastTickAt=receivedAt;state.ticks++;
 const bidAskAvailable=payload.bid!==null&&payload.ask!==null;
 state.marketDataQuality[wanted.instrument]={providerSymbol,quoteAsOf,bidAskAvailable,status:bidAskAvailable?"BID_ASK_READY":"SPOT_ONLY"};
 if(!bidAskAvailable){
  state.bidAskMissingTicks++;
  if(wanted.sessions.some(x=>x.entryEnabled))state.lastEntryReason="DERIV_BID_ASK_UNAVAILABLE:"+wanted.instrument;
 }
 // Start exits immediately, but do not block candle ingestion on database round-trips.
 const managementPromise=manageOpenTrades(wanted.instrument,payload);
 if(Date.now()-(lastPersisted.get(wanted.instrument)||0)>=1000){
  lastPersisted.set(wanted.instrument,Date.now());
  db.from("scalping_market_ticks").upsert({instrument:wanted.instrument,provider_symbol:providerSymbol,quote,bid:payload.bid,ask:payload.ask,quote_as_of:quoteAsOf,received_at:receivedAt,source:"DERIV",updated_at:receivedAt},{onConflict:"instrument"})
   .then(({error})=>{if(error)logError(error);}).catch(logError);
 }
 const h=history.get(wanted.instrument);if(!h||h.m1.length<35)return;
 const minute=Math.floor(epoch/60)*60;
 if(!h.current||minute>h.current.epoch){
  if(h.current&&h.current.epoch+60<=minute){h.m1.push(h.current);h.m1=latestContiguousCandles(h.m1,60,240);}
  h.current={epoch:minute,open:quote,high:quote,low:quote,close:quote};
 }else{h.current.high=Math.max(h.current.high,quote);h.current.low=Math.min(h.current.low,quote);h.current.close=quote;}
 const managementHealthy=await managementPromise;
 if(!managementHealthy)return;
 if(!leaseOwned||stopping||!wanted.sessions.some(x=>x.entryEnabled))return;
 const m5=mergeCompletedM5(h.m5,h.m1);
 if(m5.length<25||payload.bid===null||payload.ask===null)return;
 if(!leaseOwned||stopping)return;
 const result=analyseScalping({instrument:wanted.instrument,candles:h.m1.slice(-180),trendCandles:m5,contextCandles:{M15:h.m15,H1:h.h1,H4:h.h4},tick:payload,now:Date.now()});
 if(result.direction==="BUY"||result.direction==="SELL")await saveSignal(wanted,result,h.m1.at(-1).epoch,payload);
}

function closeSocket(){for(const timer of contextRefreshTimers.values())clearInterval(timer);contextRefreshTimers.clear();if(socket){const old=socket;socket=null;try{old.onopen=null;old.onmessage=null;old.onerror=null;old.onclose=null;old.close();}catch{}}state.socket="DISCONNECTED";}
async function subscribeSet(desired){
 desiredSymbols=desired;
 const list=desired.map(x=>x.providerSymbol).sort();
 if(JSON.stringify(list)===JSON.stringify(state.subscribed.slice().sort())&&["CONNECTED","CONNECTING"].includes(state.socket))return;
 closeSocket();history.clear();state.readySymbols=[];state.subscribed=list;
 if(!list.length){state.socket="IDLE_NO_OPTED_IN_DEMO_SESSIONS";return;}
 const ws=new WebSocket(ENDPOINT);socket=ws;state.socket="CONNECTING";
 const requestMap=new Map();let nextId=100;
 ws.onopen=()=>{if(socket!==ws)return;retry=1000;state.socket="CONNECTED";ws.send(JSON.stringify({active_symbols:"brief",req_id:1}));};
 ws.onerror=()=>{if(socket!==ws)return;state.socket="ERROR";closeSocket();logError(new Error("Deriv WebSocket transport error."));scheduleReconnect();};
 ws.onclose=()=>{if(socket!==ws)return;socket=null;state.socket="DISCONNECTED";if(!stopping)scheduleReconnect();};
 ws.onmessage=async event=>{
  if(socket!==ws)return;
  try {
  let msg;try{msg=JSON.parse(typeof event.data==="string"?event.data:event.data.toString());}catch{return;}
  if(msg.error){logError(new Error("Deriv rejected the public streaming request."));closeSocket();scheduleReconnect();return;}
  if(msg.msg_type==="active_symbols"){
   const active=Array.isArray(msg.active_symbols)?msg.active_symbols:[];
   for(const wanted of desiredSymbols){
    const found=active.find(a=>String(a.underlying_symbol||a.symbol||"")===wanted.providerSymbol);
    if(!found){logError(new Error("Approved provider symbol is not currently active on Deriv."));closeSocket();scheduleReconnect();return;}
    const requests=[["M1",60,180],["M5",300,60],["M15",900,60],["H1",3600,60],["H4",14400,60]];
    for(const [kind,granularity,count] of requests){
     const id=nextId++;requestMap.set(id,{instrument:wanted.instrument,kind});
     ws.send(JSON.stringify({ticks_history:wanted.providerSymbol,count,end:"latest",style:"candles",granularity,req_id:id}));
    }
   }
  }
  if(msg.msg_type==="candles"&&requestMap.has(Number(msg.req_id))){
   const req=requestMap.get(Number(msg.req_id));requestMap.delete(Number(msg.req_id));const candles=(msg.candles||[]).map(c=>({epoch:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)})).filter(validCandle).filter(c=>(c.epoch+({M1:60,M5:300,M15:900,H1:3600,H4:14400}[req.kind]||60))*1000<=Date.now());
   const intervals={M1:60,M5:300,M15:900,H1:3600,H4:14400};
   const kind=req.kind,interval=intervals[kind];
   const h=history.get(req.instrument)||{m1:[],m5:[],m15:[],h1:[],h4:[],current:null,loadedM1:false,loadedM5:false,loadedM15:false,loadedH1:false,loadedH4:false};
   const key=kind.toLowerCase(),loadedKey="loaded"+kind;
   h[key]=latestContiguousCandles(candles,interval,240);
   if(kind==="M1")h.current=null;
   h[loadedKey]=true;history.set(req.instrument,h);
   if(h.loadedM1&&h.loadedM5&&h.loadedM15&&h.loadedH1&&h.loadedH4){
    const m5=mergeCompletedM5(h.m5,h.m1);
    if(h.m1.length<35||m5.length<25||h.m15.length<25||h.h1.length<25||h.h4.length<25){
     logError(new Error("Deriv did not provide enough contiguous completed M1/M5/M15/H1/H4 candles to warm up the scalping engine."));
     closeSocket();scheduleReconnect();return;
    }
    if(!h.subscribed){
     h.subscribed=true;const wanted=desiredSymbols.find(x=>x.instrument===req.instrument);if(!wanted)return;
     ws.send(JSON.stringify({ticks:wanted.providerSymbol,subscribe:1}));state.readySymbols.push(req.instrument);
     if(!contextRefreshTimers.has(wanted.instrument)){
      const timer=setInterval(()=>{
       if(socket!==ws||ws.readyState!==WebSocket.OPEN)return;
       // Refresh fast and context histories so a session/weekend gap can re-warm
       // M1/M5 without waiting for a socket reconnect. Each response replaces only
       // completed history; resetting current M1 avoids carrying a pre-refresh bar.
       const intervals={M1:60,M5:300,M15:900,H1:3600,H4:14400};
       for(const [kind,granularity] of Object.entries(intervals)){
        const id=nextId++;requestMap.set(id,{instrument:wanted.instrument,kind});
        ws.send(JSON.stringify({ticks_history:wanted.providerSymbol,count:60,end:"latest",style:"candles",granularity,req_id:id}));
       }
      },60000);
      contextRefreshTimers.set(wanted.instrument,timer);
     }
    }
   }
  }
  if(msg.msg_type==="tick"&&msg.tick){
   const wanted=desiredSymbols.find(x=>x.providerSymbol===String(msg.tick.symbol||""));
   if(wanted)await publishTick(wanted,msg.tick);
  }
  } catch(e) { closeSocket();logError(e);scheduleReconnect(); }
 };
}
function validCandle(c){return c&&[c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.epoch>0&&c.low>0&&c.high>=c.low&&c.open>=c.low&&c.open<=c.high&&c.close>=c.low&&c.close<=c.high;}
function scheduleReconnect(){if(stopping||reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;reconcile().catch(logError);},retry);retry=Math.min(retry*2,30000);}
async function reconcile(){
 if(stopping)return;
 try{
  const {data:claimed,error:leaseError}=await db.rpc("claim_traderwin_scalping_worker",{p_lease_token:leaseToken,p_lease_seconds:90});
  if(leaseError)throw leaseError;
  leaseOwned=claimed===true;state.leaseOwned=leaseOwned;
  if(!leaseOwned){state.leaseLastError="LEASE_HELD_BY_ANOTHER_SCALPING_WORKER";closeSocket();state.socket="LEASE_HELD_BY_ANOTHER_SCALPING_WORKER";return;}
  state.leaseLastRenewedAt=new Date().toISOString();state.leaseLastError=null;
  const desired=await eligibleSymbols();await subscribeSet(desired);state.lastError=null;
 }catch(e){leaseOwned=false;state.leaseOwned=false;state.leaseLastError=String(e?.message||e).slice(0,180);closeSocket();logError(e);scheduleReconnect();}
}
server.listen(PORT,()=>console.log("Young Tiger continuous DEMO scalping paper worker listening on",PORT));
reconcile().catch(logError);
reconcileTimer=setInterval(()=>reconcile().catch(logError),10000);
refreshOpenTrades().catch(logError);
tradeRefreshTimer=setInterval(()=>refreshOpenTrades().catch(logError),1000);
async function shutdown(){
 if(stopping)return;
 stopping=true;state.stopping=true;clearInterval(reconcileTimer);clearInterval(tradeRefreshTimer);if(reconnectTimer)clearTimeout(reconnectTimer);closeSocket();server.close();
 if(leaseOwned){
  try{const {error}=await db.rpc("release_traderwin_scalping_worker",{p_lease_token:leaseToken});if(error)throw error;leaseOwned=false;state.leaseOwned=false;}
  catch(e){state.leaseLastError=String(e?.message||e).slice(0,180);logError(e);}
 }
}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
