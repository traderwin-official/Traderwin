import {createClient} from "@supabase/supabase-js";
import {analyseCandles} from "../../lib/strategy-engine.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Analysis service is not configured."});
 const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({error:"Sign in is required."});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:u,error}=await db.auth.getUser(h.slice(7).trim());if(error||!u.user)return res.status(401).json({error:"Invalid login session."});
  const b=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
  if(!Array.isArray(b.candles)||b.candles.length>500)return res.status(400).json({error:"Supply 35 to 500 completed OHLC candles."});
  const result=analyseCandles(b.candles);
  return res.status(200).json({ok:true,market:b.market||"UNSPECIFIED",timeframe:b.timeframe||"UNSPECIFIED",source:b.source||"USER_SUPPLIED_CANDLES",analysedAt:new Date().toISOString(),result,execution:"NONE",message:"Analysis only. This endpoint does not open, modify or close broker trades."});
 }catch(e){return res.status(400).json({error:e.message||"Analysis failed."});}
}
