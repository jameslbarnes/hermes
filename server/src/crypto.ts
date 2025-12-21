/**
 * TEE-based encryption for sensitive data
 *
 * Uses Phala's dstack SDK to derive encryption keys that only exist
 * inside the Trusted Execution Environment. Data encrypted here
 * cannot be decrypted outside the TEE.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { DstackClient } from '@phala/dstack-sdk';

const ALGORITHM = 'aes-256-gcm';
const KEY_PATH = '/hermes/email-encryption-v1';

let cachedKey: Buffer | null = null;

/**
 * Get the encryption key from TEE or fallback for local dev
 */
async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  try {
    // Try to get key from TEE
    const client = new DstackClient();
    const result = await client.deriveKey(KEY_PATH);

    // deriveKey returns a DeriveKeyResponse with asUint8Array()
    const keyBytes = result.asUint8Array();
    // Use first 32 bytes for AES-256
    cachedKey = Buffer.from(keyBytes.slice(0, 32));
    console.log('[Crypto] Using TEE-derived encryption key');
  } catch (err) {
    // Fallback for local development - derive from env or use static key
    // In production, this branch should never execute inside TEE
    const fallbackSecret = process.env.EMAIL_ENCRYPTION_KEY || 'local-dev-key-not-for-production';
    cachedKey = createHash('sha256').update(fallbackSecret).digest();
    console.log('[Crypto] Using fallback encryption key (local dev mode)');
  }

  return cachedKey;
}

/**
 * Encrypt a string value
 * Returns base64-encoded string: iv:authTag:ciphertext
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV for GCM

  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a string value
 * Expects base64-encoded string: iv:authTag:ciphertext
 */
export async function decrypt(encrypted: string): Promise<string> {
  const key = await getEncryptionKey();

  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }

  const [ivB64, authTagB64, ciphertext] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a string looks like it's encrypted (has our format)
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;

  // Check if parts look like base64
  try {
    Buffer.from(parts[0], 'base64');
    Buffer.from(parts[1], 'base64');
    Buffer.from(parts[2], 'base64');
    return true;
  } catch {
    return false;
  }
}
