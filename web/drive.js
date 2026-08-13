(() => {
  const CONFIG_KEY = 'reboot-drive-config-v1';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FILE_NAME = 'REBOOT-sauvegarde.json';
  const LEGACY_FILE_NAME = 'REBOOT-sauvegarde-chiffree.json';
  const DAILY = { database: 'reboot-local-v1', legacy: 'reboot-local-v1' };
  const CALCULATOR = { database: 'reboot-calculator-v1', legacy: 'reboot-site-v02' };
  let gisPromise;

  function storedConfig() { try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } catch { return {}; } }
  function config() {
    const stored = storedConfig();
    return { ...stored, configured: Boolean(stored.driveFileId), clientId: String(window.REBOOT_GOOGLE_CLIENT_ID || stored.clientId || '').trim() };
  }
  function rememberRemote(file, mode) { if (file?.id) localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...storedConfig(), driveFileId: file.id, driveVersion: String(file.version || ''), protectionMode: mode || storedConfig().protectionMode || 'protected', lastSyncAt: new Date().toISOString() })); }
  function timestamp(value) { const parsed = new Date(value || 0).getTime(); return Number.isFinite(parsed) ? parsed : 0; }
  function itemTimestamp(item = {}) { return Math.max(...['updatedAt', 'deletedAt', 'closedAt', 'reviewedAt', 'createdAt', 'importedAt'].map((key) => timestamp(item[key]))); }
  function latest(first, second) { return itemTimestamp(second) > itemTimestamp(first) ? second : first; }
  function mergeList(local = [], remote = [], key) {
    const values = new Map();
    [...remote, ...local].forEach((item) => {
      const id = key(item);
      if (!id) return;
      values.set(id, values.has(id) ? latest(values.get(id), item) : item);
    });
    return [...values.values()];
  }
  function mergeBackupStatus(local = {}, remote = {}) {
    return Object.fromEntries([...new Set([...Object.keys(local), ...Object.keys(remote)])].map((key) => [key, timestamp(local[key]) >= timestamp(remote[key]) ? local[key] : remote[key]]));
  }
  function mergeDaily(local = {}, remote = {}) {
    const base = timestamp(remote.updatedAt) > timestamp(local.updatedAt) ? remote : local;
    const mapping = timestamp(remote.bankImportMapping?.updatedAt) > timestamp(local.bankImportMapping?.updatedAt) ? remote.bankImportMapping : local.bankImportMapping;
    return {
      ...base,
      expenses: mergeList(local.expenses, remote.expenses, (item) => item.id),
      refunds: mergeList(local.refunds, remote.refunds, (item) => item.id),
      reserves: mergeList(local.reserves, remote.reserves, (item) => item.id),
      reserveTransfers: mergeList(local.reserveTransfers, remote.reserveTransfers, (item) => item.id),
      auditEvents: mergeList(local.auditEvents, remote.auditEvents, (item) => item.id),
      importedBankOperations: mergeList(local.importedBankOperations, remote.importedBankOperations, (item) => item.fingerprint || item.id),
      bankImportMapping: mapping,
      backupStatus: mergeBackupStatus(local.backupStatus, remote.backupStatus),
      updatedAt: new Date().toISOString(),
      syncStatus: { lastSyncAt: new Date().toISOString(), mode: 'merged' }
    };
  }
  function mergeStates(local = {}, remote = {}) {
    const localCalculator = local.calculator || {};
    const remoteCalculator = remote.calculator || {};
    return {
      daily: mergeDaily(local.daily || {}, remote.daily || {}),
      calculator: timestamp(remoteCalculator.updatedAt) > timestamp(localCalculator.updatedAt) ? remoteCalculator : localCalculator
    };
  }
  async function saveStates(states) {
    if (states.daily) await RebootSecureStorage.save(DAILY.database, states.daily);
    if (states.calculator) await RebootSecureStorage.save(CALCULATOR.database, states.calculator);
  }
  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.onload = resolve; script.onerror = () => reject(new Error('Impossible de charger le module de connexion Google.')); document.head.append(script); });
    return gisPromise;
  }
  async function accessToken(clientId) {
    if (!clientId) throw new Error('Google Drive n’est pas encore configuré sur ce site.');
    await loadGis();
    return new Promise((resolve, reject) => { const client = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: response => response.error ? reject(new Error(response.error_description || response.error)) : resolve(response.access_token), error_callback: error => reject(new Error(error.type || 'Connexion Google annulée.')) }); client.requestAccessToken({ prompt: 'consent' }); });
  }
  async function driveFetch(url, token, options = {}) {
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
    if (!response.ok) { let detail = ''; try { detail = (await response.json())?.error?.message || ''; } catch {} throw new Error(detail || `Google Drive a répondu ${response.status}.`); }
    return response;
  }
  async function latestFile(token) {
    const query = encodeURIComponent(`(name='${FILE_NAME}' or name='${LEGACY_FILE_NAME}') and trashed=false`);
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&orderBy=modifiedTime desc&pageSize=1&fields=files(id,name,modifiedTime,version)`, token);
    return (await response.json()).files?.[0] || null;
  }
  function multipart(metadata, content) {
    const boundary = `reboot-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    return { contentType: `multipart/related; boundary=${boundary}`, body: new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(metadata), `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`, content, `\r\n--${boundary}--`], { type: `multipart/related; boundary=${boundary}` }) };
  }
  function securityChoice(value) {
    if (typeof value === 'string') return { mode: 'protected', code: value };
    return { mode: value?.mode === 'simple' ? 'simple' : 'protected', code: String(value?.code || '') };
  }
  async function uploadMerged(token, existing, security) {
    const content = await RebootArchive.create(security.code, { encrypted: security.mode === 'protected' });
    const payload = multipart({ name: FILE_NAME, mimeType: 'application/json', appProperties: { reboot: security.mode === 'protected' ? 'encrypted-archive-v1' : 'plain-archive-v1' } }, content);
    const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,name,modifiedTime,version` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,version';
    const response = await driveFetch(url, token, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': payload.contentType }, body: payload.body });
    return response.json();
  }
  async function synchronize(choice) {
    const security = securityChoice(choice);
    const token = await accessToken(config().clientId);
    const existing = await latestFile(token);
    let merged = false;
    if (existing) {
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`, token);
      const remotePayload = await RebootArchive.open(await response.text(), security.code);
      const localStates = await RebootArchive.readStates();
      await saveStates(mergeStates(localStates, remotePayload.states));
      merged = true;
    }
    const file = await uploadMerged(token, existing, security);
    rememberRemote(file, security.mode);
    await RebootArchive.noteBackup('drive');
    return { ...file, merged };
  }
  async function download(choice) {
    const security = securityChoice(choice);
    const token = await accessToken(config().clientId);
    const file = await latestFile(token);
    if (!file) throw new Error('Aucune sauvegarde REBOOT créée par cette application n’a été trouvée dans ce Drive.');
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, token);
    const payload = await RebootArchive.open(await response.text(), security.code);
    rememberRemote(file, security.mode);
    return { file, payload };
  }
  async function pull(choice) {
    const security = securityChoice(choice);
    const token = await accessToken(config().clientId);
    const file = await latestFile(token);
    if (!file) throw new Error('Aucune sauvegarde REBOOT n’a été trouvée dans ce Drive.');
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, token);
    const remotePayload = await RebootArchive.open(await response.text(), security.code);
    const localStates = await RebootArchive.readStates();
    await saveStates(mergeStates(localStates, remotePayload.states));
    rememberRemote(file, security.mode);
    await RebootArchive.noteBackup('drive');
    return { file, merged: true };
  }
  window.RebootDrive = { config, synchronize, upload: synchronize, download, pull, mergeStates };
})();
