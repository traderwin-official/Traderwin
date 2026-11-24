// Legacy immediate-open endpoint is intentionally disabled.
// All new MANUAL DEMO entries must be submitted as pending batches so the
// server can reserve aggregate risk and wait for a verified price touch.
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 res.setHeader("Allow","POST");
 if(req.method!=="POST")return res.status(405).json({error:"Method not allowed."});
 return res.status(410).json({
  error:"Immediate manual entries are disabled. Use the pending manual setup form; positions activate only after a fresh verified quote touches or crosses your planned entry.",
  code:"MANUAL_ENTRY_REQUIRES_PENDING_BATCH"
 });
}
