import { resolve } from 'node:path';

function required(environment, name) {
  const value = String(environment[name] || '').trim();
  if (!value) throw new Error(`Configuration serveur manquante : ${name}`);
  return value;
}

function encryptionKey(value) {
  const text = String(value || '').trim();
  let bytes;
  if (/^[a-f\d]{64}$/i.test(text)) bytes = Buffer.from(text, 'hex');
  else {
    try { bytes = Buffer.from(text, 'base64'); } catch { bytes = Buffer.alloc(0); }
  }
  if (bytes.length !== 32) throw new Error('REBOOT_TOKEN_ENCRYPTION_KEY doit contenir exactement 32 octets encodés en base64 ou hexadécimal.');
  return bytes;
}

export function loadConfig(environment = process.env) {
  const nodeEnv = String(environment.NODE_ENV || 'development');
  const allowedOrigins = required(environment, 'ALLOWED_ORIGIN').split(',').map(value => value.trim()).filter(Boolean);
  const sessionSecret = required(environment, 'SESSION_SECRET');
  if (Buffer.byteLength(sessionSecret) < 32) throw new Error('SESSION_SECRET doit contenir au moins 32 caractères.');
  return {
    nodeEnv,
    host: String(environment.BROKER_HOST || '0.0.0.0'),
    port: Number(environment.BROKER_PORT || 3000),
    googleClientId: required(environment, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: required(environment, 'GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: required(environment, 'GOOGLE_REDIRECT_URI'),
    tokenEncryptionKeys: { v1: encryptionKey(required(environment, 'REBOOT_TOKEN_ENCRYPTION_KEY')) },
    activeTokenKeyVersion: 'v1',
    sessionSecret,
    databasePath: resolve(String(environment.DATABASE_URL || './data/oauth.sqlite').replace(/^sqlite:/, '')),
    allowedOrigins,
    secureCookies: nodeEnv === 'production',
    sessionTtlMs: Number(environment.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 90),
    stateTtlMs: Number(environment.OAUTH_STATE_TTL_MS || 1000 * 60 * 10),
    syncLeaseTtlMs: Math.max(5000, Number(environment.SYNC_LEASE_TTL_SECONDS || 15) * 1000),
    tombstoneRetentionDays: Math.max(1, Number(environment.TOMBSTONE_RETENTION_DAYS || 90)),
    googleAuthorizationUrl: String(environment.GOOGLE_AUTHORIZATION_URL || 'https://accounts.google.com/o/oauth2/v2/auth'),
    googleTokenUrl: String(environment.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'),
    googleTokenInfoUrl: String(environment.GOOGLE_TOKEN_INFO_URL || 'https://oauth2.googleapis.com/tokeninfo'),
    googleRevokeUrl: String(environment.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke')
  };
}
