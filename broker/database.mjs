import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class BrokerDatabase {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS google_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        google_subject_id TEXT NOT NULL UNIQUE,
        encrypted_refresh_token TEXT NOT NULL,
        granted_scopes TEXT NOT NULL,
        token_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_refresh_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        code_verifier TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_members (
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(dataset_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS sync_leases (
        dataset_id TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL UNIQUE,
        owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
      CREATE INDEX IF NOT EXISTS dataset_members_user ON dataset_members(user_id);
      CREATE INDEX IF NOT EXISTS sync_leases_expiry ON sync_leases(expires_at);
    `);
  }

  close() { this.db.close(); }
  cleanup(now = Date.now()) {
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM sync_leases WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
  createSession(expiresAt, now = Date.now()) {
    const session = { id: randomUUID(), userId: null, csrfToken: randomUUID(), expiresAt, createdAt: now, lastSeenAt: now };
    this.db.prepare('INSERT INTO sessions(id,user_id,csrf_token,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(session.id, null, session.csrfToken, expiresAt, now, now);
    return session;
  }
  session(id, now = Date.now()) {
    const row = this.db.prepare('SELECT id,user_id,csrf_token,expires_at,created_at,last_seen_at FROM sessions WHERE id=? AND expires_at>?').get(id, now);
    return row ? { id: row.id, userId: row.user_id, csrfToken: row.csrf_token, expiresAt: row.expires_at, createdAt: row.created_at, lastSeenAt: row.last_seen_at } : null;
  }
  touchSession(id, expiresAt, now = Date.now()) { this.db.prepare('UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id=?').run(now, expiresAt, id); }
  deleteSession(id) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  createOAuthState(sessionId, state, verifier, returnTo, expiresAt, now = Date.now()) {
    this.db.prepare('INSERT INTO oauth_states(state,session_id,code_verifier,return_to,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(state, sessionId, verifier, returnTo, expiresAt, now);
  }
  consumeOAuthState(state, sessionId, now = Date.now()) {
    const row = this.db.prepare('SELECT state,session_id,code_verifier,return_to,expires_at FROM oauth_states WHERE state=? AND session_id=?').get(state, sessionId);
    if (!row) return null;
    this.db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    if (row.expires_at <= now) return null;
    return { state: row.state, sessionId: row.session_id, codeVerifier: row.code_verifier, returnTo: row.return_to, expiresAt: row.expires_at };
  }
  attachGoogleConnection(sessionId, subject, encryptedToken, scopes, tokenVersion, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id,user_id,encrypted_refresh_token,created_at FROM google_connections WHERE google_subject_id=?').get(subject);
      const session = this.db.prepare('SELECT user_id FROM sessions WHERE id=?').get(sessionId);
      let userId = existing?.user_id || session?.user_id;
      if (!userId) {
        userId = randomUUID();
        this.db.prepare('INSERT INTO users(id,created_at,last_seen_at) VALUES(?,?,?)').run(userId, now, now);
      } else this.db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(now, userId);
      if (existing) {
        this.db.prepare('UPDATE google_connections SET encrypted_refresh_token=?,granted_scopes=?,token_version=?,updated_at=?,revoked_at=NULL WHERE id=?').run(encryptedToken || existing.encrypted_refresh_token, scopes, tokenVersion, now, existing.id);
      } else {
        this.db.prepare('INSERT INTO google_connections(id,user_id,google_subject_id,encrypted_refresh_token,granted_scopes,token_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), userId, subject, encryptedToken, scopes, tokenVersion, now, now);
      }
      this.db.prepare('UPDATE sessions SET user_id=?,last_seen_at=? WHERE id=?').run(userId, now, sessionId);
      this.db.exec('COMMIT');
      return userId;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  connectionForSession(sessionId) {
    const row = this.db.prepare(`SELECT gc.* FROM google_connections gc JOIN sessions s ON s.user_id=gc.user_id WHERE s.id=? AND gc.revoked_at IS NULL`).get(sessionId);
    return row || null;
  }
  anyConnectionForSession(sessionId) {
    const row = this.db.prepare(`SELECT gc.* FROM google_connections gc JOIN sessions s ON s.user_id=gc.user_id WHERE s.id=?`).get(sessionId);
    return row || null;
  }
  markRefreshed(id, now = Date.now()) { this.db.prepare('UPDATE google_connections SET last_refresh_at=?,updated_at=? WHERE id=?').run(now, now, id); }
  markRevoked(id, now = Date.now()) { this.db.prepare('UPDATE google_connections SET revoked_at=?,updated_at=? WHERE id=?').run(now, now, id); }
  datasetForSession(sessionId) {
    const session = this.db.prepare('SELECT user_id FROM sessions WHERE id=?').get(sessionId);
    if (!session?.user_id) return null;
    const membership = this.db.prepare('SELECT dataset_id,role FROM dataset_members WHERE user_id=? ORDER BY created_at LIMIT 1').get(session.user_id);
    return membership ? { id: membership.dataset_id, role: membership.role } : null;
  }
  adoptDatasetForSession(sessionId, datasetId, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db.prepare('SELECT user_id FROM sessions WHERE id=?').get(sessionId);
      if (!session?.user_id) { this.db.exec('COMMIT'); return null; }
      let membership = this.db.prepare('SELECT dataset_id,role FROM dataset_members WHERE user_id=? ORDER BY created_at LIMIT 1').get(session.user_id);
      if (!membership) {
        this.db.prepare('INSERT OR IGNORE INTO datasets(id,created_at) VALUES(?,?)').run(datasetId, now);
        this.db.prepare('INSERT INTO dataset_members(dataset_id,user_id,role,created_at) VALUES(?,?,?,?)').run(datasetId, session.user_id, 'owner', now);
        membership = { dataset_id: datasetId, role: 'owner' };
      }
      this.db.exec('COMMIT');
      return { id: membership.dataset_id, role: membership.role };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createDatasetForSession(sessionId, now = Date.now()) { return this.adoptDatasetForSession(sessionId, randomUUID(), now); }
  replaceDatasetForSession(sessionId, datasetId, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db.prepare('SELECT user_id FROM sessions WHERE id=?').get(sessionId);
      if (!session?.user_id) { this.db.exec('COMMIT'); return null; }
      const current = this.db.prepare('SELECT dataset_id FROM dataset_members WHERE user_id=? ORDER BY created_at LIMIT 1').get(session.user_id);
      if (current?.dataset_id === datasetId) { this.db.exec('COMMIT'); return { id: datasetId, replaced: false, previousId: datasetId }; }
      this.db.prepare('INSERT OR IGNORE INTO datasets(id,created_at) VALUES(?,?)').run(datasetId, now);
      // Keep the old dataset row intact: the broker has no financial data and
      // must never erase a possible historical association during recovery.
      this.db.prepare('DELETE FROM dataset_members WHERE user_id=?').run(session.user_id);
      this.db.prepare('INSERT INTO dataset_members(dataset_id,user_id,role,created_at) VALUES(?,?,?,?)').run(datasetId, session.user_id, 'owner', now);
      this.db.exec('COMMIT');
      return { id: datasetId, replaced: true, previousId: current?.dataset_id || null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquireLease(sessionId, datasetId, ttlMs, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sync_leases WHERE expires_at <= ?').run(now);
      const membership = this.db.prepare(`SELECT dm.dataset_id FROM dataset_members dm JOIN sessions s ON s.user_id=dm.user_id WHERE s.id=? AND dm.dataset_id=?`).get(sessionId, datasetId);
      if (!membership) { this.db.exec('COMMIT'); return { status: 'forbidden' }; }
      const existing = this.db.prepare('SELECT expires_at FROM sync_leases WHERE dataset_id=?').get(datasetId);
      if (existing) { this.db.exec('COMMIT'); return { status: 'busy', retryAfterMs: Math.max(200, Math.min(1000, existing.expires_at - now)) }; }
      const lease = { leaseId: randomUUID(), acquiredAt: now, expiresAt: now + ttlMs };
      this.db.prepare('INSERT INTO sync_leases(dataset_id,lease_id,owner_session_id,acquired_at,expires_at) VALUES(?,?,?,?,?)').run(datasetId, lease.leaseId, sessionId, lease.acquiredAt, lease.expiresAt);
      this.db.exec('COMMIT');
      return { status: 'acquired', ...lease };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  releaseLease(sessionId, leaseId, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sync_leases WHERE expires_at <= ?').run(now);
      const released = this.db.prepare('DELETE FROM sync_leases WHERE lease_id=? AND owner_session_id=?').run(leaseId, sessionId);
      if (released.changes) { this.db.exec('COMMIT'); return { status: 'released' }; }
      const existing = this.db.prepare('SELECT lease_id FROM sync_leases WHERE lease_id=?').get(leaseId);
      this.db.exec('COMMIT');
      return existing ? { status: 'forbidden' } : { status: 'released' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  disconnectSessionUser(sessionId) {
    const connection = this.anyConnectionForSession(sessionId);
    if (connection) this.db.prepare('UPDATE google_connections SET encrypted_refresh_token=?,granted_scopes=?,revoked_at=?,updated_at=? WHERE id=?').run('', '', Date.now(), Date.now(), connection.id);
    this.deleteSession(sessionId);
  }
}
