const ENDPOINT="https://xaus.com/api/v1/spot?compact=1";
const CACHE_MS=60000;
const MAX_AGE_MS=180000;
let cached=null;
let pending=null;
const finite=Number.isFinite;

function unknown(reason){return {status:"UNKNOWN",reason,provider:"XAUS",price:null,asOf:null,checkedAt:null};}

/**
 * Independent indicative XAU/USD reference. It is a discrepancy veto only:
 * never an executable quote, signal source, or substitute for broker bid/ask.
 */
export async function getXausGoldReference({now=Date.now(),fetchImpl=globalThis.fetch}={}){
 if(!finite(now)||typeof fetchImpl!=="function")return unknown("REFERENCE_PROVIDER_UNAVAILABLE");
 if(cached&&now-cached.fetchedAt>=0&&now-cached.fetchedAt<CACHE_MS)return cached.result;
 if(pending)return pending;
 pending=(async()=>{
  try{
   const response=await fetchImpl(ENDPOINT,{headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)});
   if(!response?.ok)return unknown("REFERENCE_PROVIDER_HTTP_ERROR");
   const type=String(response.headers?.get?.("content-type")||"").toLowerCase();
   if(!type.includes("json"))return unknown("REFERENCE_PROVIDER_INVALID_CONTENT_TYPE");
   const body=await response.json();
   const price=Number(body?.spot_usd_oz);
   const state=body?.data_state;
   const asOf=Date.parse(body?.price_as_of||state?.as_of||"");
   const updatedAt=Date.parse(body?.updated_at||"");
   if(!finite(price)||price<=0||!finite(asOf)||!finite(updatedAt))return unknown("REFERENCE_PROVIDER_INVALID_PAYLOAD");
   if(state?.status!=="fresh"||state?.source!=="upstream"||body?.stale===true||
      (typeof body?.price_source==="string"&&/last known good|cache/i.test(body.price_source)))
    return unknown("REFERENCE_PRICE_NOT_FRESH");
   const age=now-asOf,generatedAge=now-updatedAt;
   if(age<0||age>MAX_AGE_MS||generatedAge<0||generatedAge>MAX_AGE_MS)
    return unknown("REFERENCE_PRICE_STALE");
   const result={status:"FRESH",reason:null,provider:"XAUS",price,asOf:new Date(asOf).toISOString(),checkedAt:new Date(now).toISOString(),ageMs:age,unit:"USD_PER_TROY_OUNCE",indicative:true,executable:false};
   cached={fetchedAt:now,result};
   return result;
  }catch{return unknown("REFERENCE_PROVIDER_REQUEST_FAILED");}
  finally{pending=null;}
 })();
 return pending;
}

export function compareGoldReference({brokerMid,reference,now=Date.now(),maxDeviationBps=50,maxAgeMs=MAX_AGE_MS}={}){
 if(!finite(brokerMid)||brokerMid<=0||!reference||reference.status!=="FRESH"||reference.provider!=="XAUS"||
    reference.indicative!==true||reference.executable!==false||!finite(reference.price)||reference.price<=0)
  return {status:"UNKNOWN",reason:"INDEPENDENT_GOLD_REFERENCE_UNAVAILABLE",deviationBps:null};
 const asOf=Date.parse(reference.asOf);
 if(!finite(now)||!finite(asOf)||now-asOf<0||now-asOf>maxAgeMs)
  return {status:"UNKNOWN",reason:"INDEPENDENT_GOLD_REFERENCE_STALE",deviationBps:null};
 if(!finite(maxDeviationBps)||maxDeviationBps<=0)
  return {status:"UNKNOWN",reason:"GOLD_REFERENCE_DEVIATION_LIMIT_UNCONFIGURED",deviationBps:null};
 const deviationBps=Math.abs(brokerMid-reference.price)/reference.price*10000;
 return {status:deviationBps<=maxDeviationBps?"PASS":"BLOCK",reason:deviationBps<=maxDeviationBps?null:"GOLD_REFERENCE_PRICE_DIVERGENCE",deviationBps:Number(deviationBps.toFixed(2)),maxDeviationBps,provider:"XAUS",asOf:reference.asOf};
}

export function resetXausGoldReferenceCacheForTests(){cached=null;pending=null;}
