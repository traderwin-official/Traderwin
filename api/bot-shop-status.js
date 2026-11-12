import { createClient } from "@supabase/supabase-js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET"){res.setHeader("Allow","GET");return res.status(405).json({error:"Method not allowed"});}
 const id=String(req.query?.orderId||"");
 if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:"Invalid order reference"});
 const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await db.from("bot_license_orders").select("status,delivery_status").eq("id",id).maybeSingle();
 if(error)return res.status(503).json({error:"Status unavailable"});
 if(!data)return res.status(404).json({error:"Order not found"});
 return res.status(200).json({status:data.status,deliveryStatus:data.delivery_status,paid:["PAID","FULFILLED"].includes(data.status),delivered:data.delivery_status==="DELIVERED"});
}
