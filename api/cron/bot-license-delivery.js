import { deliverPendingBotLicenseEmails } from "../../lib/standalone-bot-licenses.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
 const expected=process.env.CRON_SECRET||"",provided=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(!expected||provided.length!==expected.length||!Buffer.from(provided).equals(Buffer.from(expected)))return res.status(401).json({error:"Unauthorized"});
 try{const result=await deliverPendingBotLicenseEmails({limit:20});return res.status(200).json({ok:true,...result});}
 catch(error){console.error("Bot license delivery worker failed:",error.message);return res.status(503).json({error:"Delivery worker failed"});}
}
