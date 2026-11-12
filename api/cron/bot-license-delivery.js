import { createClient } from "@supabase/supabase-js";
import { deliverStandaloneBotLicense } from "../../lib/bot-license-delivery.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
 const expected=process.env.CRON_SECRET||"",provided=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(!expected||provided.length!==expected.length||!Buffer.from(provided).equals(Buffer.from(expected)))return res.status(401).json({error:"Unauthorized"});
 const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:orders,error}=await db.from("bot_license_orders").select("id").eq("status","FULFILLED").in("delivery_status",["PENDING","FAILED"]).order("fulfilled_at",{ascending:true}).limit(25);
 if(error)return res.status(503).json({error:"Could not load pending license deliveries"});
 let delivered=0,failed=0;
 for(const order of orders||[]){try{await deliverStandaloneBotLicense(order.id);delivered++;}catch{failed++;}}
 return res.status(200).json({processed:(orders||[]).length,delivered,failed});
}
