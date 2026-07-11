import crypto from 'crypto';

/**
 * AES-256-GCM encryption for secrets at rest (social login sessions).
 * The key comes from APP_ENCRYPTION_KEY — a 64-char hex string (32 bytes) is
 * used directly; anything else is stretched with scrypt. If the key is unset,
 * encryption throws rather than storing secrets in plaintext.
 */

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set — required to store social login sessions securely.'
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    cachedKey = crypto.scryptSync(raw, 'social-engine-v1', 32);
  }
  return cachedKey;
}

export function isEncryptionConfigured(): boolean {
  return !!process.env.APP_ENCRYPTION_KEY;
}

/** Returns base64(iv | authTag | ciphertext). */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
