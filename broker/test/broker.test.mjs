import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { createBroker } from '../broker.mjs';
import { BrokerDatabase } from '../database.mjs';

const active = [];
afterEach(async () => { while (active.length) { const item = active.pop(); await new Promise(resolve => item.server.close(resolve)); item.database.close(); } });

function testConfig(overrides = {}) {
  return {
    nodeEnv: 'test', host: '127.0.0.1', port: 0,
    googleClientId: 'client.apps.googleusercontent.com', googleClientSecret: 'server-only-secret',
    googleRedirectUri: 'http://reboot.test/api/oauth/google/callback',
    tokenEncryptionKeys: { v1: randomBytes(32) }, activeTokenKeyVersion: 'v1',
    sessionSecret: 'a-test-session-secret-with-more-than-32-characters',
    databasePath: ':memory:', allowedOrigins: ['http://reboot.test'], secureCookies: false,
    sessionTtlMs: 90 * 86400000, stateTtlMs: 600000, syncLeaseTtlMs: 15000, tombstoneRetentionDays: 90,
    googleAuthorizationUrl: 'https://google.test/auth', googleTokenUrl: 'https://google.test/token',
    googleTokenInfoUrl: 'https://google.test/tokeninfo', googleRevokeUrl: 'https://google.test/revoke',
    ...overrides
  };
}

async function setup({ authorizationFailure = null, refreshFailure = null, tokenNetworkFailure = false, grantedScopes = 'openid https://www.googleapis.com/auth/drive.appdata', config = testConfig() } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: String(options.body || '') });
    if (String(url).startsWith(config.googleTokenInfoUrl)) return Response.json({ sub: 'google-subject-1', aud: config.googleClientId, iss: 'https://accounts.google.com' });
    if (url === config.googleTokenUrl) {
      const body = new URLSearchParams(options.body), grant = body.get('grant_type');
      if (grant === 'authorization_code') return authorizationFailure ? Response.json({ error: authorizationFailure }, { status: 400 }) : Response.json({ access_token: 'short-access-1', refresh_token: 'critical-refresh-token', id_token: 'signed-google-id-token', expires_in: 3600, scope: grantedScopes });
      if (tokenNetworkFailure) throw new Error('network down');
      if (refreshFailure) return Response.json({ error: refreshFailure }, { status: 400 });
      return Response.json({ access_token: 'short-access-2', expires_in: 3600 });
    }
    if (url === config.googleRevokeUrl) return new Response('', { status: 200 });
    throw new Error(`Unexpected fetch ${url}`);
  };
  const database = new BrokerDatabase(':memory:'), broker = createBroker(config, { database, fetchImpl, logger: { info() {} } });
  await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
  active.push(broker);
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  return { ...broker, base, calls, config };
}

async function connect(context) {
  const start = await fetch(`${context.base}/api/oauth/google/start?return_to=${encodeURIComponent('/drive.html?drive=connected')}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get('location'));
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  assert.equal(authorization.searchParams.get('prompt'), 'consent');
  assert.equal(authorization.searchParams.get('scope'), 'openid https://www.googleapis.com/auth/drive.appdata');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const callback = await fetch(`${context.base}/api/oauth/google/callback?code=authorization-code&state=${authorization.searchParams.get('state')}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/drive.html?drive=connected');
  return cookie;
}

test('OAuth start, callback and refresh keep financial data out of the broker', async () => {
  const context = await setup(), cookie = await connect(context);
  const statusResponse = await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } });
  const status = await statusResponse.json();
  assert.equal(status.connected, true);
  assert.deepEqual(status.scopes.sort(), ['https://www.googleapis.com/auth/drive.appdata', 'openid']);
  assert.ok(status.csrf_token);
  assert.equal(status.dataset_id, null);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) AS count FROM datasets').get().count, 0);
  const tokenResponse = await fetch(`${context.base}/api/oauth/google/token`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'X-CSRF-Token': status.csrf_token } });
  const token = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200);
  assert.equal(token.access_token, 'short-access-2');
  assert.ok(token.expires_at > Date.now());
  const stored = context.database.db.prepare('SELECT encrypted_refresh_token FROM google_connections').get().encrypted_refresh_token;
  assert.equal(stored.includes('critical-refresh-token'), false);
  assert.equal(context.calls.some(call => /transaction|budget|balance|income|expense/i.test(call.body)), false);
});

async function leaseStatus(context, cookie) { return (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json(); }
async function acquireLease(context, cookie, status, datasetId) {
  return fetch(`${context.base}/api/sync/lease`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token }, body: JSON.stringify({ datasetId }) });
}
async function adoptDataset(context, cookie, status, datasetId) {
  return fetch(`${context.base}/api/sync/dataset/adopt`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token }, body: JSON.stringify({ datasetId }) });
}
async function replaceDataset(context, cookie, status, datasetId, confirmation = 'use_drive_dataset') {
  return fetch(`${context.base}/api/sync/dataset/replace`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token }, body: JSON.stringify({ datasetId, confirmation }) });
}

test('a dataset lease is atomic, owner-bound and reusable after release', async () => {
  const context = await setup(), firstCookie = await connect(context), secondCookie = await connect(context);
  const firstStatus = await leaseStatus(context, firstCookie), datasetId = '11111111-1111-4111-8111-111111111111';
  assert.equal((await adoptDataset(context, firstCookie, firstStatus, datasetId)).status, 200);
  const [adoptedFirstStatus, secondStatus] = await Promise.all([leaseStatus(context, firstCookie), leaseStatus(context, secondCookie)]);
  assert.equal(adoptedFirstStatus.dataset_id, secondStatus.dataset_id);
  const [first, second] = await Promise.all([acquireLease(context, firstCookie, adoptedFirstStatus, adoptedFirstStatus.dataset_id), acquireLease(context, secondCookie, secondStatus, secondStatus.dataset_id)]);
  const responses = [first, second], acquired = responses.find(response => response.status === 200), busy = responses.find(response => response.status === 423);
  assert.ok(acquired);
  assert.ok(busy);
  const lease = await acquired.json(), busyBody = await busy.json();
  assert.equal(lease.status, 'acquired');
  assert.equal(busyBody.status, 'busy');
  const fraud = await fetch(`${context.base}/api/sync/lease/${lease.leaseId}`, { method: 'DELETE', headers: { Cookie: secondCookie, Origin: 'http://reboot.test', 'X-CSRF-Token': secondStatus.csrf_token } });
  assert.equal(fraud.status, 403);
  const ownerCookie = acquired === first ? firstCookie : secondCookie, ownerStatus = acquired === first ? adoptedFirstStatus : secondStatus;
  const release = await fetch(`${context.base}/api/sync/lease/${lease.leaseId}`, { method: 'DELETE', headers: { Cookie: ownerCookie, Origin: 'http://reboot.test', 'X-CSRF-Token': ownerStatus.csrf_token } });
  assert.equal(release.status, 204);
  const retry = await acquireLease(context, secondCookie, secondStatus, secondStatus.dataset_id);
  assert.equal(retry.status, 200);
});

test('an abandoned lease expires and its API only accepts technical identifiers', async () => {
  const context = await setup({ config: testConfig({ syncLeaseTtlMs: 5 }) }), firstCookie = await connect(context), secondCookie = await connect(context);
  const firstStatus = await leaseStatus(context, firstCookie);
  assert.equal((await adoptDataset(context, firstCookie, firstStatus, '22222222-2222-4222-8222-222222222222')).status, 200);
  const [firstStatusAfterAdoption, secondStatus] = await Promise.all([leaseStatus(context, firstCookie), leaseStatus(context, secondCookie)]);
  const acquired = await acquireLease(context, firstCookie, firstStatusAfterAdoption, firstStatusAfterAdoption.dataset_id);
  assert.equal(acquired.status, 200);
  const rejectedPayload = await fetch(`${context.base}/api/sync/lease`, { method: 'POST', headers: { Cookie: secondCookie, Origin: 'http://reboot.test', 'Content-Type': 'application/json', 'X-CSRF-Token': secondStatus.csrf_token }, body: JSON.stringify({ datasetId: secondStatus.dataset_id, expenses: [{ amount: 42 }] }) });
  assert.equal(rejectedPayload.status, 400);
  await new Promise(resolve => setTimeout(resolve, 10));
  const afterExpiry = await acquireLease(context, secondCookie, secondStatus, secondStatus.dataset_id);
  assert.equal(afterExpiry.status, 200);
});

test('a fresh broker can adopt a Drive dataset, but never replaces an existing association', async () => {
  const context = await setup(), cookie = await connect(context), status = await leaseStatus(context, cookie);
  const abc = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', xyz = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const adopted = await adoptDataset(context, cookie, status, abc);
  assert.equal(adopted.status, 200);
  assert.equal((await adopted.json()).dataset_id, abc);
  const after = await leaseStatus(context, cookie);
  assert.equal(after.dataset_id, abc);
  const conflict = await adoptDataset(context, cookie, after, xyz);
  assert.equal(conflict.status, 409);
  assert.equal((await leaseStatus(context, cookie)).dataset_id, abc);
});

test('a confirmed recovery can replace a stale broker association without deleting its history', async () => {
  const context = await setup(), cookie = await connect(context), status = await leaseStatus(context, cookie);
  const oldDataset = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', driveDataset = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  assert.equal((await adoptDataset(context, cookie, status, oldDataset)).status, 200);
  const afterAdoption = await leaseStatus(context, cookie);
  assert.equal((await replaceDataset(context, cookie, afterAdoption, driveDataset, 'no')).status, 400);
  const replaced = await replaceDataset(context, cookie, afterAdoption, driveDataset);
  assert.equal(replaced.status, 200);
  assert.deepEqual(await replaced.json(), { dataset_id: driveDataset, replaced: true });
  assert.equal((await leaseStatus(context, cookie)).dataset_id, driveDataset);
  assert.ok(context.database.db.prepare('SELECT id FROM datasets WHERE id=?').get(oldDataset));
  assert.ok(context.database.db.prepare('SELECT id FROM datasets WHERE id=?').get(driveDataset));
});

test('OAuth state is bound to the HttpOnly session and consumed once', async () => {
  const context = await setup();
  const start = await fetch(`${context.base}/api/oauth/google/start`, { redirect: 'manual' });
  const authorization = new URL(start.headers.get('location')), cookie = start.headers.get('set-cookie').split(';')[0], state = authorization.searchParams.get('state');
  const invalid = await fetch(`${context.base}/api/oauth/google/callback?code=x&state=wrong`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(invalid.status, 400);
  const valid = await fetch(`${context.base}/api/oauth/google/callback?code=x&state=${state}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(valid.status, 302);
  const replay = await fetch(`${context.base}/api/oauth/google/callback?code=x&state=${state}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(replay.status, 400);
});

test('an expired authorization code fails without creating an association', async () => {
  const context = await setup({ authorizationFailure: 'invalid_grant' });
  const start = await fetch(`${context.base}/api/oauth/google/start`, { redirect: 'manual' }), authorization = new URL(start.headers.get('location')), cookie = start.headers.get('set-cookie').split(';')[0];
  const callback = await fetch(`${context.base}/api/oauth/google/callback?code=expired&state=${authorization.searchParams.get('state')}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/drive.html?drive=oauth_error');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) AS count FROM google_connections').get().count, 0);
});

test('an authorization without the private Drive scope is rejected before it is stored', async () => {
  const context = await setup({ grantedScopes: 'openid' });
  const start = await fetch(`${context.base}/api/oauth/google/start`, { redirect: 'manual' }), authorization = new URL(start.headers.get('location')), cookie = start.headers.get('set-cookie').split(';')[0];
  const callback = await fetch(`${context.base}/api/oauth/google/callback?code=missing-scope&state=${authorization.searchParams.get('state')}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/drive.html?drive=oauth_scope_missing');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) AS count FROM google_connections').get().count, 0);
});

test('a revoked refresh token is classified as reauth_required', async () => {
  const context = await setup({ refreshFailure: 'invalid_grant' }), cookie = await connect(context);
  const status = await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json();
  const response = await fetch(`${context.base}/api/oauth/google/token`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'X-CSRF-Token': status.csrf_token } });
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.category, 'reauth_required');
  const after = await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json();
  assert.equal(after.connected, false);
  assert.equal(after.reauth_required, true);
});

test('a Google outage stays temporary and does not revoke the association', async () => {
  const context = await setup({ tokenNetworkFailure: true }), cookie = await connect(context);
  const status = await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json();
  const response = await fetch(`${context.base}/api/oauth/google/token`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'X-CSRF-Token': status.csrf_token } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).category, 'temporary');
  assert.equal((await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json()).connected, true);
});

test('session, CSRF, origin and disconnect protections are enforced', async () => {
  const context = await setup();
  assert.equal((await fetch(`${context.base}/api/oauth/google/token`, { method: 'POST' })).status, 401);
  const cookie = await connect(context), status = await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json();
  assert.equal((await fetch(`${context.base}/api/oauth/google/token`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'X-CSRF-Token': status.csrf_token } })).status, 403);
  const disconnected = await fetch(`${context.base}/api/oauth/google/disconnect`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://reboot.test', 'X-CSRF-Token': status.csrf_token } });
  assert.equal(disconnected.status, 200);
  assert.match(disconnected.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json()).connected, false);
});

test('expired sessions are rejected', async () => {
  const context = await setup({ config: testConfig({ sessionTtlMs: 1 }) });
  const start = await fetch(`${context.base}/api/oauth/google/start`, { redirect: 'manual' }), cookie = start.headers.get('set-cookie').split(';')[0];
  await new Promise(resolve => setTimeout(resolve, 5));
  const status = await (await fetch(`${context.base}/api/oauth/google/status`, { headers: { Cookie: cookie } })).json();
  assert.equal(status.connected, false);
  assert.equal(status.csrf_token, null);
});

test('production sessions are HttpOnly, Secure and SameSite=Lax', async () => {
  const context = await setup({ config: testConfig({ nodeEnv: 'production', secureCookies: true }) });
  const response = await fetch(`${context.base}/api/oauth/google/start`, { redirect: 'manual' }), cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});
