import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptSecret(secret, keys, version = 'v1') {
  const key = keys[version];
  if (!key) throw new Error('Version de clé de chiffrement inconnue.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return JSON.stringify({ version, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}

export function decryptSecret(payload, keys) {
  const envelope = JSON.parse(payload);
  const key = keys[envelope.version];
  if (!key) throw new Error('Version de clé de chiffrement inconnue.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
