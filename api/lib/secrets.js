const crypto = require('crypto');
const config = require('./config');

const MASTER_KEY = config.SECRETS_MASTER_KEY;
if (!MASTER_KEY) {
  console.warn('[secrets] SECRETS_MASTER_KEY is not set. Secret environment variables will fail to encrypt/decrypt.');
}

const deriveKey = () => crypto.createHash('sha256').update(MASTER_KEY || '').digest();

function encryptSecret(plaintext) {
  if (!MASTER_KEY) {
    throw new Error('Secret encryption is not configured (missing SECRETS_MASTER_KEY)');
  }
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]);
  return payload.toString('base64');
}

function decryptSecret(ciphertext) {
  if (!MASTER_KEY) {
    throw new Error('Secret decryption is not configured (missing SECRETS_MASTER_KEY)');
  }
  const raw = Buffer.from(ciphertext, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptSecret,
  decryptSecret
};
