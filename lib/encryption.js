import crypto from "node:crypto";

/**
 * Encrypt a broker token with AES-256-GCM.
 * TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).
 * Keep this key in server-side environment variables only.
 */
export function encryptToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("A non-empty token is required.");
  }
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), ciphertext.toString("hex")].join(":");
}
