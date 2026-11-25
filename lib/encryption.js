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

/**
 * Decrypt a stored AES-256-GCM broker token. Authentication failure throws;
 * callers must never fall back to an unencrypted token.
 */
export function decryptToken(envelope) {
  if (typeof envelope !== "string") throw new TypeError("Encrypted token envelope is required.");
  const parts = envelope.split(":");
  if (parts.length !== 3 || !parts.every((part) => /^[0-9a-f]+$/i.test(part))) {
    throw new Error("Encrypted token envelope is malformed.");
  }
  const [ivHex, tagHex, ciphertextHex] = parts;
  if (ivHex.length !== 24 || tagHex.length !== 32 || ciphertextHex.length === 0 || ciphertextHex.length % 2 !== 0) {
    throw new Error("Encrypted token envelope has invalid lengths.");
  }
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
  if (!plaintext) throw new Error("Decrypted token is empty.");
  return plaintext;
}
