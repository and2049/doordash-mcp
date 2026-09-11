import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const ENCRYPTION_VERSION = 'v1';

export function parseEncryptionKey(encoded: string | undefined | null): Buffer | null {
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be base64-encoded 32 bytes.');
  }
  return key;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashProviderId(providerId: string, key: Buffer | null): string {
  return key
    ? createHmac('sha256', key).update(providerId).digest('hex')
    : createHash('sha256').update(providerId).digest('hex');
}

export function encryptString(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptString(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== ENCRYPTION_VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Unsupported encrypted payload format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
