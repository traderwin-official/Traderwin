import crypto from "node:crypto";

function encryptionKey(){
 const raw=process.env.BOT_LICENSE_ENCRYPTION_KEY||"";
 const key=Buffer.from(raw,"base64");
 if(key.length!==32) throw new Error("BOT_LICENSE_ENCRYPTION_KEY must be base64-encoded 32 bytes");
 return key;
}
export function encryptLicenseKey(value){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey(),iv);
 const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
 return [iv.toString("base64"),cipher.getAuthTag().toString("base64"),encrypted.toString("base64")].join(".");
}
export function decryptLicenseKey(value){
 const [iv,tag,data]=String(value||"").split(".");
 if(!iv||!tag||!data) throw new Error("Invalid encrypted license key");
 const decipher=crypto.createDecipheriv("aes-256-gcm",encryptionKey(),Buffer.from(iv,"base64"));
 decipher.setAuthTag(Buffer.from(tag,"base64"));
 return Buffer.concat([decipher.update(Buffer.from(data,"base64")),decipher.final()]).toString("utf8");
}
export function hashLicenseKey(value){return crypto.createHash("sha256").update(value).digest("hex");}
export function makeLicenseKey(){const p=()=>crypto.randomBytes(3).toString("hex").toUpperCase();return "TW-"+p()+"-"+p()+"-"+p()+"-"+p();}
