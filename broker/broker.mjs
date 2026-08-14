import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { BrokerDatabase } from './database.mjs';
import { decryptSecret, encryptSecret } from './secrets.mjs';

const SESSION_COOKIE = 'reboot_session';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const OAUTH_SCOPES = `openid ${DRIVE_SCOPE}`;

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}
function redirect(response, location, headers = {}) { response.writeHead(302, { 'Cache-Control': 'no-store', Location: location, ...headers }); response.end(); }
function cookieMap(header = '') { return Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2)); }
function hmac(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function signedSession(id, secret) { return `${id}.${hmac(id, secret)}`; }
function verifiedSessionId(value, secret) {
  const [id, signature] = String(value || '').split('.');
  if (!id || !signature) return '';
  const expected = hmac(id, secret), left = Buffer.from(signature), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right) ? id : '';
}
function sessionCookie(session, config) { return `${SESSION_COOKIE}=${encodeURIComponent(signedSession(session.id, config.sessionSecret))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${config.secureCookies ? '; Secure' : ''}`; }
function clearedCookie(config) { return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? '; Secure' : ''}`; }
function randomBase64(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function safeReturnTo(value) { const text = String(value || '/drive.html?drive=connected'); return text.startsWith('/') && !text.startsWith('//') ? text : '/drive.html?drive=connected'; }
function errorCategory(code) {
  if (['invalid_grant', 'revoked_token', 'authorization_removed'].includes(code)) return 'reauth_required';
  if (['invalid_client', 'redirect_uri_mismatch', 'unauthorized_client'].includes(code)) return 'configuration_error';
  return 'temporary';
}
function publicError(category) { return category === 'reauth_required' ? 'Google Drive doit être reconnecté.' : category === 'temporary' ? 'Google Drive est temporairement indisponible.' : 'La connexion Google Drive est indisponible.'; }
function opaqueId(value) { return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12); }
function hasDriveAppDataScope(connection) { return String(connection?.granted_scopes || '').split(' ').includes(DRIVE_SCOPE); }
async function requestJson(request, maxBytes = 4096) {
  let size = 0, source = '';
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('payload_too_large');
    source += chunk;
  }
  try { return source ? JSON.parse(source) : {}; } catch { throw new Error('invalid_json'); }
}

export function createBroker(config, options = {}) {
  const database = options.database || new BrokerDatabase(config.databasePath), fetchImpl = options.fetchImpl || fetch, logger = options.logger || console;
  function log(event, details = {}) { logger.info?.(JSON.stringify({ event, at: new Date().toISOString(), ...details })); }
  function getSession(request) {
    const id = verifiedSessionId(cookieMap(request.headers.cookie)[SESSION_COOKIE], config.sessionSecret);
    const session = id && database.session(id);
    if (session) database.touchSession(id, Date.now() + config.sessionTtlMs);
    return session || null;
  }
  function originAllowed(request) { const origin = request.headers.origin; return !origin || config.allowedOrigins.includes(origin); }
  function corsHeaders(request) { const origin = request.headers.origin; return origin && config.allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {}; }
  function csrfAllowed(request, session) { return originAllowed(request) && session && request.headers['x-csrf-token'] === session.csrfToken; }
  async function googleForm(url, parameters) {
    let response;
    try { response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters) }); }
    catch { return { ok: false, category: 'temporary', code: 'network_error' }; }
    let body = {}; try { body = await response.json(); } catch {}
    if (response.ok) return { ok: true, body };
    const code = String(body.error || `http_${response.status}`);
    return { ok: false, body, code, category: errorCategory(code) };
  }
  async function handler(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`), pathname = url.pathname;
    const common = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...corsHeaders(request) };
    if (request.method === 'OPTIONS') {
      if (!originAllowed(request)) return json(response, 403, { error: 'origin_not_allowed' }, common);
      response.writeHead(204, { ...common, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token' }); response.end(); return;
    }
    if (pathname === '/healthz' && request.method === 'GET') return json(response, 200, { ok: true }, common);
    if (pathname === '/api/oauth/google/status' && request.method === 'GET') {
      const session = getSession(request), association = session && database.anyConnectionForSession(session.id);
      const authorizationIncomplete = association && !association.revoked_at && !hasDriveAppDataScope(association);
      const connection = association && !association.revoked_at && !authorizationIncomplete ? association : null;
      // The broker is a lease/token helper, not the source of truth for a budget.
      // A fresh broker must therefore report "no association" without creating one:
      // the browser first discovers structurally valid datasets in Drive and may then
      // explicitly adopt one.
      const dataset = connection ? database.datasetForSession(session.id) : null;
      return json(response, 200, { connected: Boolean(connection), reauth_required: Boolean(association?.revoked_at || authorizationIncomplete), provider: association ? 'google' : null, scopes: association ? String(association.granted_scopes).split(' ').filter(Boolean) : [], csrf_token: session?.csrfToken || null, dataset_id: dataset?.id || null, tombstone_retention_days: config.tombstoneRetentionDays }, { ...common, ...(session ? { 'Set-Cookie': sessionCookie(session, config) } : {}) });
    }
    if (pathname === '/api/oauth/google/start' && request.method === 'GET') {
      database.cleanup();
      let session = getSession(request), setCookie;
      if (!session) { session = database.createSession(Date.now() + config.sessionTtlMs); setCookie = sessionCookie(session, config); }
      const state = randomBase64(), verifier = randomBase64(48), challenge = createHash('sha256').update(verifier).digest('base64url');
      database.createOAuthState(session.id, state, verifier, safeReturnTo(url.searchParams.get('return_to')), Date.now() + config.stateTtlMs);
      const target = new URL(config.googleAuthorizationUrl);
      target.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: config.googleRedirectUri, response_type: 'code', scope: OAUTH_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256' });
      log('oauth_start');
      return redirect(response, target.toString(), { ...common, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });
    }
    if (pathname === '/api/oauth/google/callback' && request.method === 'GET') {
      const session = getSession(request), oauthState = session && database.consumeOAuthState(url.searchParams.get('state'), session.id);
      if (!session || !oauthState || !url.searchParams.get('code')) { log('oauth_callback_failed', { code: 'invalid_state' }); return json(response, 400, { error: 'invalid_oauth_state' }, common); }
      const tokenResult = await googleForm(config.googleTokenUrl, { code: url.searchParams.get('code'), client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: config.googleRedirectUri, grant_type: 'authorization_code', code_verifier: oauthState.codeVerifier });
      if (!tokenResult.ok || !tokenResult.body.refresh_token || !tokenResult.body.id_token) { log('oauth_callback_failed', { code: tokenResult.code || 'missing_token' }); return redirect(response, '/drive.html?drive=oauth_error', common); }
      let identityResponse, identity;
      try { identityResponse = await fetchImpl(`${config.googleTokenInfoUrl}?id_token=${encodeURIComponent(tokenResult.body.id_token)}`, { headers: { Accept: 'application/json' } }); identity = await identityResponse.json(); } catch { identityResponse = null; }
      if (!identityResponse?.ok || !identity?.sub || identity.aud !== config.googleClientId || !['accounts.google.com', 'https://accounts.google.com'].includes(identity.iss)) { log('oauth_callback_failed', { code: 'invalid_identity' }); return redirect(response, '/drive.html?drive=oauth_error', common); }
      if (!hasDriveAppDataScope({ granted_scopes: tokenResult.body.scope || OAUTH_SCOPES })) { log('oauth_callback_failed', { code: 'missing_drive_appdata_scope' }); return redirect(response, '/drive.html?drive=oauth_scope_missing', common); }
      const encrypted = encryptSecret(tokenResult.body.refresh_token, config.tokenEncryptionKeys, config.activeTokenKeyVersion);
      database.attachGoogleConnection(session.id, identity.sub, encrypted, String(tokenResult.body.scope || OAUTH_SCOPES), config.activeTokenKeyVersion);
      log('oauth_connected');
      return redirect(response, oauthState.returnTo, { ...common, 'Set-Cookie': sessionCookie(session, config) });
    }
    if (pathname === '/api/oauth/google/token' && request.method === 'POST') {
      const session = getSession(request);
      if (!session) return json(response, 401, { error: 'session_required', category: 'reauth_required', message: 'Session REBOOT absente.' }, common);
      if (!csrfAllowed(request, session)) return json(response, 403, { error: 'csrf_failed', category: 'configuration_error', message: 'Requête refusée.' }, common);
      const connection = database.connectionForSession(session.id);
      if (!connection) return json(response, 401, { error: 'reauth_required', category: 'reauth_required', message: 'Google Drive doit être reconnecté.' }, common);
      if (!hasDriveAppDataScope(connection)) return json(response, 401, { error: 'missing_drive_appdata_scope', category: 'reauth_required', message: 'Google Drive doit être reconnecté.' }, common);
      let refreshToken;
      try { refreshToken = decryptSecret(connection.encrypted_refresh_token, config.tokenEncryptionKeys); }
      catch { log('token_refresh_failed', { code: 'decrypt_failed' }); return json(response, 503, { error: 'broker_configuration', category: 'configuration_error', message: publicError('configuration_error') }, common); }
      const result = await googleForm(config.googleTokenUrl, { client_id: config.googleClientId, client_secret: config.googleClientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
      if (!result.ok) {
        if (result.category === 'reauth_required') database.markRevoked(connection.id);
        log('token_refresh_failed', { code: result.code, category: result.category });
        return json(response, result.category === 'reauth_required' ? 401 : 503, { error: result.code, category: result.category, message: publicError(result.category) }, common);
      }
      database.markRefreshed(connection.id); log('token_refreshed');
      const expiresIn = Math.max(60, Number(result.body.expires_in || 3600));
      return json(response, 200, { access_token: result.body.access_token, expires_in: expiresIn, expires_at: Date.now() + expiresIn * 1000 }, common);
    }
    if (pathname === '/api/oauth/google/disconnect' && request.method === 'POST') {
      const session = getSession(request);
      if (!csrfAllowed(request, session)) return json(response, session ? 403 : 401, { error: session ? 'csrf_failed' : 'session_required' }, common);
      const connection = database.anyConnectionForSession(session.id);
      if (connection) {
        try { const token = decryptSecret(connection.encrypted_refresh_token, config.tokenEncryptionKeys); await fetchImpl(config.googleRevokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }); } catch {}
        database.disconnectSessionUser(session.id);
      } else database.deleteSession(session.id);
      log('oauth_disconnected');
      return json(response, 200, { disconnected: true }, { ...common, 'Set-Cookie': clearedCookie(config) });
    }
    if (pathname === '/api/sync/dataset/adopt' && request.method === 'POST') {
      const session = getSession(request);
      if (!csrfAllowed(request, session)) return json(response, session ? 403 : 401, { error: session ? 'csrf_failed' : 'session_required' }, common);
      if (!database.connectionForSession(session.id)) return json(response, 401, { error: 'reauth_required', category: 'reauth_required' }, common);
      let body;
      try { body = await requestJson(request); } catch { return json(response, 400, { error: 'invalid_dataset_request' }, common); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'datasetId')) return json(response, 400, { error: 'invalid_dataset_request' }, common);
      const datasetId = String(body.datasetId || '');
      if (!/^[a-f\d-]{36}$/i.test(datasetId)) return json(response, 400, { error: 'invalid_dataset_id' }, common);
      const existing = database.datasetForSession(session.id);
      if (existing && existing.id !== datasetId) {
        log('dataset_adoption_conflict', { known: opaqueId(existing.id), requested: opaqueId(datasetId) });
        return json(response, 409, { error: 'dataset_conflict', dataset_id: existing.id, message: 'Ce compte REBOOT est déjà associé à un autre budget.' }, common);
      }
      const dataset = database.adoptDatasetForSession(session.id, datasetId);
      log('dataset_adopted', { dataset: opaqueId(dataset.id) });
      return json(response, 200, { dataset_id: dataset.id, adopted: !existing }, common);
    }
    if (pathname === '/api/sync/dataset/create' && request.method === 'POST') {
      const session = getSession(request);
      if (!csrfAllowed(request, session)) return json(response, session ? 403 : 401, { error: session ? 'csrf_failed' : 'session_required' }, common);
      if (!database.connectionForSession(session.id)) return json(response, 401, { error: 'reauth_required', category: 'reauth_required' }, common);
      const existing = database.datasetForSession(session.id);
      if (existing) return json(response, 200, { dataset_id: existing.id, created: false }, common);
      const dataset = database.createDatasetForSession(session.id);
      log('dataset_created', { dataset: opaqueId(dataset.id) });
      return json(response, 201, { dataset_id: dataset.id, created: true }, common);
    }
    if (pathname === '/api/sync/dataset/replace' && request.method === 'POST') {
      const session = getSession(request);
      if (!csrfAllowed(request, session)) return json(response, session ? 403 : 401, { error: session ? 'csrf_failed' : 'session_required' }, common);
      if (!database.connectionForSession(session.id)) return json(response, 401, { error: 'reauth_required', category: 'reauth_required' }, common);
      let body;
      try { body = await requestJson(request); } catch { return json(response, 400, { error: 'invalid_dataset_request' }, common); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['datasetId', 'confirmation'].includes(key)) || body.confirmation !== 'use_drive_dataset') return json(response, 400, { error: 'invalid_dataset_replacement' }, common);
      const datasetId = String(body.datasetId || '');
      if (!/^[a-f\d-]{36}$/i.test(datasetId)) return json(response, 400, { error: 'invalid_dataset_id' }, common);
      const dataset = database.replaceDatasetForSession(session.id, datasetId);
      log('dataset_replaced_after_confirmation', { previous: opaqueId(dataset.previousId), dataset: opaqueId(dataset.id) });
      return json(response, 200, { dataset_id: dataset.id, replaced: dataset.replaced }, common);
    }
    if (pathname === '/api/sync/lease' && request.method === 'POST') {
      const session = getSession(request);
      if (!csrfAllowed(request, session)) return json(response, session ? 403 : 401, { error: session ? 'csrf_failed' : 'session_required' }, common);
      if (!database.connectionForSession(session.id)) return json(response, 401, { error: 'reauth_required', category: 'reauth_required' }, common);
      let body;
      try { body = await requestJson(request); } catch { return json(response, 400, { error: 'invalid_lease_request' }, common); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'datasetId')) return json(response, 400, { error: 'invalid_lease_request' }, common);
      const datasetId = String(body.datasetId || '');
      if (!/^[a-f\d-]{36}$/i.test(datasetId)) return json(response, 400, { error: 'invalid_dataset_id' }, common);
      const lease = database.acquireLease(session.id, datasetId, config.syncLeaseTtlMs);
      if (lease.status === 'forbidden') return json(response, 403, { error: 'dataset_forbidden' }, common);
      if (lease.status === 'busy') {
        log('sync_lease_busy', { dataset: opaqueId(datasetId) });
        return json(response, 423, { status: 'busy', retryAfterMs: lease.retryAfterMs }, { ...common, 'Retry-After': String(Math.max(1, Math.ceil(lease.retryAfterMs / 1000))) });
      }
      log('sync_lease_acquired', { dataset: opaqueId(datasetId) });
      return json(response, 200, { status: 'acquired', leaseId: lease.leaseId, expiresAt: new Date(lease.expiresAt).toISOString() }, common);
    }
    const releaseMatch = pathname.match(/^\/api\/sync\/lease\/([a-f\d-]{36})$/i);
    if (releaseMatch && request.method === 'DELETE') {
      const session = getSession(request);
      if (!csrfAllowed(request, session)) return json(response, session ? 403 : 401, { error: session ? 'csrf_failed' : 'session_required' }, common);
      const released = database.releaseLease(session.id, releaseMatch[1]);
      if (released.status === 'forbidden') return json(response, 403, { error: 'lease_forbidden' }, common);
      log('sync_lease_released');
      response.writeHead(204, common); response.end(); return;
    }
    return json(response, 404, { error: 'not_found' }, common);
  }
  const server = createServer((request, response) => handler(request, response).catch(error => { log('broker_error', { code: error?.code || 'internal_error' }); if (!response.headersSent) json(response, 500, { error: 'internal_error', category: 'configuration_error', message: publicError('configuration_error') }); else response.end(); }));
  return { server, database, handler };
}
