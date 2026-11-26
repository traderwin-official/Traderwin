const ENDPOINT="https://api.gdeltproject.org/api/v2/doc/doc";
const QUERY='("Federal Reserve" OR Fed OR ECB OR "European Central Bank" OR "Bank of Japan" OR "Bank of England" OR "interest rate" OR inflation OR CPI OR "jobs report" OR "nonfarm payrolls" OR sanctions OR tariff OR war OR invasion OR intervention)';
const CACHE_MS=15*60*1000;
const MAX_AGE_MS=20*60*1000;
let cached=null;
let pending=null;

const severeHeadline=/(emergency|surprise|unexpected|rate decision|rate hike|rate cut|inflation|consumer price|\bCPI\b|nonfarm|\bNFP\b|sanction|tariff|invasion|military strike|war|default|currency intervention|central bank)/i;

function parseSeenAt(value){
 if(typeof value!=="string")return NaN;
 const raw=value.trim();
 const gdelt=raw.match(/^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z$/);
 const normalized=gdelt?`${gdelt[1]}-${gdelt[2]}-${gdelt[3]}T${gdelt[4]}:${gdelt[5]}:${gdelt[6]}Z`:raw;
 return Date.parse(normalized);
}

function parseArticles(payload,now){
 const rows=Array.isArray(payload?.articles)?payload.articles:[];
 return rows.slice(0,250).map(row=>({
  title:String(row?.title||"").trim().slice(0,300),
  url:typeof row?.url==="string"?row.url.slice(0,1000):null,
  seenAt:typeof row?.seendate==="string"?row.seendate:null,
  seenAtMs:parseSeenAt(row?.seendate),
  domain:typeof row?.domain==="string"?row.domain.slice(0,120):null
 })).filter(row=>row.title&&Number.isFinite(row.seenAtMs)&&now-row.seenAtMs>=0&&now-row.seenAtMs<=MAX_AGE_MS);
}

/**
 * GDELT is used only as an adverse-news tripwire.
 * No results never means CLEAR: news coverage is incomplete and DOC search
 * can be delayed/rate-limited. A detected risk headline can only block.
 */
export async function getGdeltNewsRiskStatus({now=Date.now(),fetchImpl=globalThis.fetch}={}){
 if(!Number.isFinite(now)||typeof fetchImpl!=="function")return {status:"UNKNOWN",reason:"NEWS_PROVIDER_UNAVAILABLE",checkedAt:null,articles:[]};
 if(cached&&now-cached.fetchedAt>=0&&now-cached.fetchedAt<CACHE_MS)return cached.result;
 if(pending)return pending;
 pending=(async()=>{
  try{
   const url=new URL(ENDPOINT);
   url.searchParams.set("query",QUERY);
   url.searchParams.set("mode","ArtList");
   url.searchParams.set("format","json");
   url.searchParams.set("timespan","15m");
   url.searchParams.set("maxrecords","100");
   url.searchParams.set("sort","DateDesc");
   const response=await fetchImpl(url.toString(),{headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)});
   if(!response?.ok)return {status:"UNKNOWN",reason:"NEWS_PROVIDER_HTTP_ERROR",checkedAt:null,articles:[]};
   const type=String(response.headers?.get?.("content-type")||"").toLowerCase();
   if(!type.includes("json"))return {status:"UNKNOWN",reason:"NEWS_PROVIDER_INVALID_CONTENT_TYPE",checkedAt:null,articles:[]};
   const payload=await response.json();
   const articles=parseArticles(payload,now);
   const flagged=articles.filter(article=>severeHeadline.test(article.title));
   const result={
    status:flagged.length?"BLACKOUT":"UNKNOWN",
    reason:flagged.length?"POTENTIAL_HIGH_IMPACT_HEADLINE":"NEWS_CLEARANCE_NOT_ESTABLISHED",
    checkedAt:new Date(now).toISOString(),
    articles:flagged.slice(0,10),
    provider:"GDELT_DOC_2_0",
    attribution:"GDELT Project — https://www.gdeltproject.org/"
   };
   cached={fetchedAt:now,result};
   return result;
  }catch{
   return {status:"UNKNOWN",reason:"NEWS_PROVIDER_REQUEST_FAILED",checkedAt:null,articles:[]};
  }finally{pending=null;}
 })();
 return pending;
}

export function resetGdeltNewsRiskCacheForTests(){cached=null;pending=null;}
