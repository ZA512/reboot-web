(() => {
  const CONFIG_KEY = 'reboot-drive-config-v2';
  const LEGACY_CONFIG_KEY = 'reboot-drive-config-v1';
  const TOKEN_KEY = 'reboot-google-access-token-v1';
  const DEVICE_KEY = 'reboot-device-id-v1';
  const FILE_NAME = 'reboot-data.json';
  const DAILY = { database: 'reboot-local-v1', legacy: 'reboot-local-v1' };
  const CALCULATOR = { database: 'reboot-calculator-v1', legacy: 'reboot-site-v02' };
  const MAX_LEASE_ATTEMPTS = 5;
  let syncTimer = null, queuedSync = null, syncing = false, listening = false, applyingRemote = false, storageChangePending = false;

  class RebootDriveError extends Error {
    constructor(message, category = 'temporary', code = 'drive_error') { super(message); this.name = 'RebootDriveError'; this.category = category; this.code = code; }
  }

  function storedConfig() { try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } catch { return {}; } }
  function saveConfig(changes) { localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...storedConfig(), ...changes })); }
  function config() { const stored = storedConfig(); return { ...stored, configured: Boolean(stored.brokerConnected), autoSync: Boolean(stored.brokerConnected) }; }
  function setStatus(state, message = '') { window.dispatchEvent(new CustomEvent('reboot:drive-status', { detail: { state, message, at: new Date().toISOString() } })); }
  function clearLegacyConfiguration() { if (localStorage.getItem(LEGACY_CONFIG_KEY)) localStorage.removeItem(LEGACY_CONFIG_KEY); }
  function newId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function deviceId() { let id = localStorage.getItem(DEVICE_KEY); if (!id) { id = `device-${newId()}`; localStorage.setItem(DEVICE_KEY, id); } return id; }
  function timestamp(value) { const parsed = new Date(value || 0).getTime(); return Number.isFinite(parsed) ? parsed : 0; }
  function itemTimestamp(item = {}) { return Math.max(...['modifiedAt', 'updatedAt', 'deletedAt', 'closedAt', 'reviewedAt', 'createdAt', 'importedAt'].map(key => timestamp(item[key]))); }
  function compareItems(first = {}, second = {}) {
    const delta = itemTimestamp(first) - itemTimestamp(second);
    if (delta) return delta;
    return String(first.modifiedBy || '').localeCompare(String(second.modifiedBy || ''));
  }
  function latest(first, second) { return compareItems(second, first) > 0 ? second : first; }
  function mergeList(local = [], remote = [], key) {
    const values = new Map();
    [...remote, ...local].forEach(item => { const id = key(item); if (id) values.set(id, values.has(id) ? latest(values.get(id), item) : item); });
    return [...values.values()];
  }
  function mergeBackupStatus(local = {}, remote = {}) { return Object.fromEntries([...new Set([...Object.keys(local), ...Object.keys(remote)])].map(key => [key, timestamp(local[key]) >= timestamp(remote[key]) ? local[key] : remote[key]])); }
  function hasMeaningfulReserve(items = []) { return items.some(item => item && !item.deletedAt && (item.kind !== 'health' || item.real || Number(item.initialBalanceMinor) || Number(item.monthlyContributionMinor) || Number(item.annualTargetMinor))); }
  function hasMeaningfulDailyState(daily = {}) {
    if (!daily || typeof daily !== 'object') return false;
    if (daily.configured || daily.onboarding?.storage || daily.budgetSource || daily.calculatorBudget || (daily.householdName && daily.householdName !== 'Notre foyer')) return true;
    if (['expenses', 'refunds', 'reserveTransfers', 'importedBankOperations', 'weeklyCycles', 'allocations'].some(key => Array.isArray(daily[key]) && daily[key].some(item => item && !item.deletedAt))) return true;
    return hasMeaningfulReserve(daily.reserves);
  }
  function hasMeaningfulCalculatorState(calculator = {}) {
    if (!calculator || typeof calculator !== 'object') return false;
    return ['manualMonthly', 'annual', 'tx', 'groups', 'selectedTemplates'].some(key => Array.isArray(calculator[key]) && calculator[key].length > 0);
  }
  function hasMeaningfulStates(states = {}) { return hasMeaningfulDailyState(states.daily) || hasMeaningfulCalculatorState(states.calculator); }
  function purgeTombstones(items = [], retentionDays = 90) {
    const threshold = Date.now() - retentionDays * 86400000;
    return items.filter(item => !item.deletedAt || itemTimestamp(item) >= threshold);
  }
  function mergeDaily(local = {}, remote = {}, retentionDays = 90) {
    const localMeaningful = hasMeaningfulDailyState(local), remoteMeaningful = hasMeaningfulDailyState(remote);
    const base = localMeaningful !== remoteMeaningful ? (localMeaningful ? local : remote) : (timestamp(remote.updatedAt) > timestamp(local.updatedAt) ? remote : local);
    const mapping = timestamp(remote.bankImportMapping?.updatedAt) > timestamp(local.bankImportMapping?.updatedAt) ? remote.bankImportMapping : local.bankImportMapping;
    return {
      ...base,
      expenses: purgeTombstones(mergeList(local.expenses, remote.expenses, item => item.id), retentionDays),
      refunds: purgeTombstones(mergeList(local.refunds, remote.refunds, item => item.id), retentionDays),
      reserves: purgeTombstones(mergeList(local.reserves, remote.reserves, item => item.id), retentionDays),
      reserveTransfers: purgeTombstones(mergeList(local.reserveTransfers, remote.reserveTransfers, item => item.id), retentionDays),
      auditEvents: mergeList(local.auditEvents, remote.auditEvents, item => item.id),
      importedBankOperations: mergeList(local.importedBankOperations, remote.importedBankOperations, item => item.fingerprint || item.id),
      weeklyCycles: purgeTombstones(mergeList(local.weeklyCycles, remote.weeklyCycles, item => item.id), retentionDays),
      allocations: purgeTombstones(mergeList(local.allocations, remote.allocations, item => item.id), retentionDays),
      bankImportMapping: mapping,
      backupStatus: mergeBackupStatus(local.backupStatus, remote.backupStatus),
      updatedAt: new Date(Math.max(timestamp(local.updatedAt), timestamp(remote.updatedAt))).toISOString()
    };
  }
  function mergeStates(local = {}, remote = {}, options = {}) {
    const localCalculator = local.calculator || {}, remoteCalculator = remote.calculator || {};
    const localCalculatorMeaningful = hasMeaningfulCalculatorState(localCalculator), remoteCalculatorMeaningful = hasMeaningfulCalculatorState(remoteCalculator);
    const calculator = localCalculatorMeaningful !== remoteCalculatorMeaningful ? (localCalculatorMeaningful ? localCalculator : remoteCalculator) : (compareItems(remoteCalculator, localCalculator) > 0 ? remoteCalculator : localCalculator);
    return { daily: mergeDaily(local.daily || {}, remote.daily || {}, options.tombstoneRetentionDays || 90), calculator };
  }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  function comparable(states) { const value = JSON.parse(JSON.stringify(states || {})); if (value.daily?.syncStatus) delete value.daily.syncStatus; return canonical(value); }
  function sameStates(first, second) { return JSON.stringify(comparable(first)) === JSON.stringify(comparable(second)); }
  async function saveStates(states) {
    applyingRemote = true;
    try {
      if (states.daily) await RebootSecureStorage.save(DAILY.database, states.daily);
      if (states.calculator) await RebootSecureStorage.save(CALCULATOR.database, states.calculator);
    } finally { applyingRemote = false; }
  }
  function stampItem(item, owner) {
    if (!item || typeof item !== 'object') return item;
    const lastChange = itemTimestamp(item), currentStamp = timestamp(item.modifiedAt);
    const modifiedAt = currentStamp >= lastChange && item.modifiedAt ? item.modifiedAt : new Date(lastChange || Date.now()).toISOString();
    return { ...item, modifiedAt, modifiedBy: currentStamp >= lastChange && item.modifiedBy ? item.modifiedBy : owner };
  }
  function prepareSyncStates(states, owner) {
    const copy = JSON.parse(JSON.stringify(states || {})), daily = copy.daily;
    if (daily) {
      ['expenses', 'refunds', 'reserves', 'reserveTransfers', 'auditEvents', 'importedBankOperations', 'weeklyCycles', 'allocations'].forEach(name => {
        if (Array.isArray(daily[name])) daily[name] = daily[name].map(item => stampItem(item, owner));
      });
      const dailyStamp = stampItem(daily, owner);
      Object.assign(daily, { modifiedAt: dailyStamp.modifiedAt, modifiedBy: dailyStamp.modifiedBy });
    }
    if (copy.calculator) {
      const calculatorStamp = stampItem(copy.calculator, owner);
      Object.assign(copy.calculator, { modifiedAt: calculatorStamp.modifiedAt, modifiedBy: calculatorStamp.modifiedBy });
    }
    return copy;
  }

  class GoogleTokenProviderBroker {
    constructor() { this.status = null; }
    cachedToken() {
      try { const value = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); return value?.access_token && Number(value.expires_at) > Date.now() + 30000 ? value : null; } catch { return null; }
    }
    clearToken() { sessionStorage.removeItem(TOKEN_KEY); }
    async responseJson(response) { try { return await response.json(); } catch { return {}; } }
    async getStatus() {
      let response;
      try { response = await fetch('/api/oauth/google/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } }); }
      catch { throw new RebootDriveError('Le service de synchronisation est momentanément inaccessible.', 'temporary', 'broker_unavailable'); }
      if (!response.ok) throw new RebootDriveError('Le service de synchronisation est momentanément inaccessible.', 'temporary', `broker_${response.status}`);
      this.status = await this.responseJson(response);
      saveConfig({ brokerConnected: Boolean(this.status.connected || this.status.reauth_required) });
      if (!this.status.connected) this.clearToken();
      return this.status;
    }
    connect(returnTo = '/drive.html?drive=connected') { location.assign(`/api/oauth/google/start?return_to=${encodeURIComponent(returnTo)}`); }
    async getAccessToken(force = false) {
      if (!force) { const cached = this.cachedToken(); if (cached) return cached; }
      const status = this.status?.csrf_token ? this.status : await this.getStatus();
      if (!status.connected) throw new RebootDriveError('Google Drive doit être reconnecté.', 'reauth_required', 'not_connected');
      let response;
      try { response = await fetch('/api/oauth/google/token', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': status.csrf_token } }); }
      catch { throw new RebootDriveError('Le renouvellement Google est momentanément indisponible.', 'temporary', 'broker_unavailable'); }
      const body = await this.responseJson(response);
      if (!response.ok) {
        const category = body.category || (response.status === 401 ? 'reauth_required' : 'temporary');
        if (category === 'reauth_required') { this.clearToken(); saveConfig({ brokerConnected: false }); }
        throw new RebootDriveError(body.message || 'Impossible d’obtenir un accès Google Drive.', category, body.error || `token_${response.status}`);
      }
      const token = { access_token: body.access_token, expires_at: Number(body.expires_at) || Date.now() + Number(body.expires_in || 3600) * 1000 };
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
      return token;
    }
    async disconnect() {
      const status = this.status?.csrf_token ? this.status : await this.getStatus();
      if (!status.csrf_token) return;
      const response = await fetch('/api/oauth/google/disconnect', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': status.csrf_token } });
      if (!response.ok) throw new RebootDriveError('La déconnexion est momentanément impossible.', 'temporary', 'disconnect_failed');
      this.clearToken(); this.status = null; localStorage.removeItem(CONFIG_KEY); clearLegacyConfiguration();
    }
    async acquireLease(datasetId) {
      const status = this.status?.csrf_token ? this.status : await this.getStatus();
      let response;
      try { response = await fetch('/api/sync/lease', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token }, body: JSON.stringify({ datasetId }) }); }
      catch { throw new RebootDriveError('Le service de synchronisation est momentanément inaccessible.', 'temporary', 'broker_unavailable'); }
      const body = await this.responseJson(response);
      if (response.status === 423) return { status: 'busy', retryAfterMs: Number(body.retryAfterMs) || 300 };
      if (!response.ok) throw new RebootDriveError(response.status === 401 ? 'Google Drive doit être reconnecté.' : 'Le verrou de synchronisation est indisponible.', response.status === 401 ? 'reauth_required' : 'temporary', body.error || `lease_${response.status}`);
      return body;
    }
    async releaseLease(leaseId) {
      const status = this.status?.csrf_token ? this.status : await this.getStatus();
      try {
        const response = await fetch(`/api/sync/lease/${encodeURIComponent(leaseId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': status.csrf_token } });
        if (!response.ok && response.status !== 404) throw new RebootDriveError('La libération du verrou de synchronisation est indisponible.', 'temporary', `lease_release_${response.status}`);
      } catch (error) {
        if (error instanceof RebootDriveError) throw error;
      }
    }
    async datasetRequest(action, datasetId = '', extra = {}) {
      const status = this.status?.csrf_token ? this.status : await this.getStatus();
      let response;
      try {
        const payload = { ...(datasetId ? { datasetId } : {}), ...extra };
        response = await fetch(`/api/sync/dataset/${action}`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token }, ...(Object.keys(payload).length ? { body: JSON.stringify(payload) } : {}) });
      } catch { throw new RebootDriveError('Le service de synchronisation est momentanément inaccessible.', 'temporary', 'broker_unavailable'); }
      const body = await this.responseJson(response);
      if (response.status === 409) throw new RebootDriveError(body.message || 'Ce navigateur est déjà associé à un autre budget REBOOT.', 'configuration_error', 'dataset_conflict');
      if (!response.ok || !body.dataset_id) throw new RebootDriveError('L’association avec ce budget est indisponible.', response.status === 401 ? 'reauth_required' : 'temporary', body.error || `dataset_${response.status}`);
      this.status = { ...status, dataset_id: body.dataset_id };
      return this.status;
    }
    adoptDataset(datasetId) { return this.datasetRequest('adopt', datasetId); }
    createDataset() { return this.datasetRequest('create'); }
    replaceDataset(datasetId) { return this.datasetRequest('replace', datasetId, { confirmation: 'use_drive_dataset' }); }
  }

  class GoogleAppDataStorageProvider {
    constructor(tokenProvider) { this.tokenProvider = tokenProvider; }
    async authorizedFetch(url, options = {}, retry = true) {
      const token = await this.tokenProvider.getAccessToken(!retry);
      let response;
      try { response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token.access_token}`, ...(options.headers || {}) } }); }
      catch { throw new RebootDriveError('Google Drive est momentanément inaccessible.', 'temporary', 'network_error'); }
      if (response.status === 401 && retry) { this.tokenProvider.clearToken(); return this.authorizedFetch(url, options, false); }
      if (!response.ok) {
        let detail = {}; try { detail = await response.json(); } catch {}
        const code = detail?.error?.errors?.[0]?.reason || `drive_${response.status}`;
        const category = response.status >= 500 || response.status === 429 ? 'temporary' : response.status === 401 ? 'reauth_required' : 'configuration_error';
        throw new RebootDriveError(category === 'temporary' ? 'Google Drive est momentanément indisponible.' : 'L’accès au stockage Google Drive a échoué.', category, code);
      }
      return response;
    }
    async getKnownMetadata() {
      const knownId = storedConfig().driveFileId;
      if (!knownId) return null;
      try { return await (await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${knownId}?fields=id,name,createdTime,modifiedTime,version,appProperties`)).json(); }
      catch (error) { if (!['configuration_error'].includes(error.category)) throw error; saveConfig({ driveFileId: '' }); return null; }
    }
    async listMetadata() {
      const query = encodeURIComponent(`name='${FILE_NAME}' and trashed=false and appProperties has { key='reboot' and value='plain-archive-v1' }`);
      const fields = 'nextPageToken,files(id,name,createdTime,modifiedTime,version,appProperties)';
      const files = []; let pageToken = '';
      do {
        const suffix = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const response = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&pageSize=100&orderBy=modifiedTime desc&fields=${fields}${suffix}`);
        const page = await response.json(); files.push(...(page.files || [])); pageToken = page.nextPageToken || '';
      } while (pageToken);
      return files;
    }
    async loadFile(file) {
      const response = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
      const payload = await RebootArchive.open(await response.text(), '');
      const sync = payload?.sync || {};
      // schemaVersion was added after the first Drive datasets. The archive
      // envelope already validates its own format/version, so a missing sync
      // schema remains a supported historical dataset rather than a reason to
      // strand it after this migration.
      if (!payload?.states || !/^[a-f\d-]{36}$/i.test(String(sync.datasetId || '')) || (sync.schemaVersion !== undefined && (!Number.isInteger(Number(sync.schemaVersion)) || Number(sync.schemaVersion) < 1))) throw new RebootDriveError('Un fichier REBOOT trouvé sur Drive ne possède pas de métadonnées de synchronisation valides.', 'configuration_error', 'invalid_dataset');
      return { file, payload, datasetId: sync.datasetId };
    }
    async discoverDatasets() {
      const known = await this.getKnownMetadata(), listed = await this.listMetadata();
      const files = [...new Map([...(known ? [known] : []), ...listed].map(file => [file.id, file])).values()];
      const candidates = [], invalid = [];
      for (const file of files) {
        try { candidates.push(await this.loadFile(file)); }
        catch (error) { invalid.push({ file, code: error?.code || 'invalid_dataset' }); }
      }
      return { candidates, invalid, filesFound: files.length };
    }
    async load(datasetId = '') {
      const discovery = await this.discoverDatasets();
      if (!discovery.candidates.length) return { remote: null, discovery };
      const knownId = storedConfig().driveFileId;
      const remote = datasetId ? discovery.candidates.find(candidate => candidate.datasetId === datasetId && candidate.file.id === knownId) || discovery.candidates.find(candidate => candidate.datasetId === datasetId) || null : discovery.candidates[0];
      return { remote, discovery };
    }
    async save(snapshot, existing = null, sync = null) {
      const content = await RebootArchive.createFromStates(snapshot, '', { encrypted: false, ...(sync ? { sync } : {}) });
      const boundary = `reboot-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
      const metadata = { name: FILE_NAME, mimeType: 'application/json', appProperties: { reboot: 'plain-archive-v1' }, ...(existing ? {} : { parents: ['appDataFolder'] }) };
      const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(metadata), `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`, content, `\r\n--${boundary}--`], { type: `multipart/related; boundary=${boundary}` });
      const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,name,modifiedTime,version` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,version';
      return (await this.authorizedFetch(url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
    }
  }

  const tokenProvider = new GoogleTokenProviderBroker();
  const storageProvider = new GoogleAppDataStorageProvider(tokenProvider);

  function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
  function retryDelay(attempt, retryAfterMs = 0) { return Math.max(retryAfterMs, 200 * (2 ** attempt)) + Math.floor(Math.random() * 180); }
  function publicCandidate(candidate) { return { datasetId: candidate.datasetId, fileId: candidate.file.id, createdTime: candidate.file.createdTime || '', modifiedTime: candidate.file.modifiedTime || '', version: String(candidate.file.version || '') }; }
  function rememberCandidates(candidates = []) { saveConfig({ remoteCandidates: candidates.map(publicCandidate), discoveredAt: new Date().toISOString() }); }
  async function prepareDataset(status, rawLocalStates) {
    const discovery = await storageProvider.discoverDatasets(), candidates = discovery.candidates;
    rememberCandidates(candidates);
    if (status.dataset_id) {
      const matches = candidates.filter(candidate => candidate.datasetId === status.dataset_id), knownId = storedConfig().driveFileId;
      const remote = matches.find(candidate => candidate.file.id === knownId) || (matches.length === 1 ? matches[0] : null);
      if (remote) { saveConfig({ remoteCandidates: [] }); return { status, remote, discovery }; }
      if (matches.length > 1) {
        setStatus('dataset_selection_required', 'Plusieurs copies de ce budget REBOOT ont été trouvées sur Google Drive.');
        return { selectionRequired: true, discovery };
      }
      if (candidates.length) throw new RebootDriveError('Google Drive présente un autre budget REBOOT que celui déjà associé à ce navigateur. Aucun budget n’a été fusionné.', 'configuration_error', 'dataset_conflict');
      if (discovery.invalid.length) throw new RebootDriveError('Un fichier REBOOT trouvé sur Google Drive est invalide. REBOOT ne créera rien tant qu’il n’aura pas été vérifié.', 'configuration_error', 'invalid_dataset');
      return { status, remote: null, discovery };
    }
    if (candidates.length) {
      saveConfig({ brokerConnected: true, syncPendingSetup: false, lastSyncErrorCode: '', lastSyncErrorMessage: '', dirty: false });
      setStatus('dataset_selection_required', candidates.length > 1 ? 'Plusieurs budgets REBOOT ont été trouvés sur Google Drive.' : 'Un budget REBOOT existant a été trouvé sur Google Drive.');
      return { selectionRequired: true, discovery };
    }
    if (discovery.invalid.length || discovery.filesFound) throw new RebootDriveError('Un fichier REBOOT trouvé sur Google Drive est invalide. REBOOT ne créera rien tant qu’il n’aura pas été vérifié.', 'configuration_error', 'invalid_dataset');
    if (!hasMeaningfulStates(rawLocalStates)) {
      saveConfig({ brokerConnected: true, syncPendingSetup: true, lastSyncErrorCode: '', lastSyncErrorMessage: '', dirty: false });
      return { pendingSetup: true, discovery };
    }
    const adoptedStatus = await tokenProvider.createDataset();
    return { status: adoptedStatus, remote: null, discovery };
  }
  async function synchronize(status, syncRevision) {
    const rawLocalStates = await RebootArchive.readStates(), localStates = prepareSyncStates(rawLocalStates, deviceId());
    // The lease is held before this second read. It prevents two devices from
    // independently applying a merge after the read-only discovery phase.
    const loaded = await storageProvider.load(status.dataset_id);
    const remote = loaded.remote;
    if (!remote && loaded.discovery?.candidates?.length) throw new RebootDriveError('Google Drive présente un autre budget REBOOT. Aucun budget n’a été fusionné.', 'configuration_error', 'dataset_conflict');
    if (!remote && loaded.discovery?.invalid?.length) throw new RebootDriveError('Un fichier REBOOT trouvé sur Google Drive est invalide.', 'configuration_error', 'invalid_dataset');
    const remoteSync = remote?.payload?.sync || {}, datasetId = status.dataset_id;
    if (!datasetId) throw new RebootDriveError('Le jeu de données synchronisé est indisponible.', 'temporary', 'dataset_missing');
    if (remoteSync.datasetId && remoteSync.datasetId !== datasetId) throw new RebootDriveError('Ce fichier Google Drive appartient à un autre jeu de données REBOOT.', 'configuration_error', 'dataset_mismatch');
    const remoteStates = remote?.payload?.states || null;
    if (!hasMeaningfulStates(localStates) && !hasMeaningfulStates(remoteStates || {})) {
      const config = storedConfig();
      saveConfig({ brokerConnected: true, datasetId, driveFileId: remote?.file?.id || config.driveFileId || '', driveVersion: String(remote?.file?.version || config.driveVersion || ''), syncPendingSetup: true, lastSyncErrorCode: '', lastSyncErrorMessage: '', dirty: false });
      return { file: remote?.file || null, merged: false, uploaded: false, pendingSetup: true, revision: Number(remoteSync.revision) || 0 };
    }
    const mergedStates = remoteStates ? mergeStates(localStates, remoteStates, { tombstoneRetentionDays: Number(status.tombstone_retention_days) || 90 }) : localStates;
    const localChanged = !sameStates(mergedStates, rawLocalStates), remoteChanged = !remoteStates || !sameStates(mergedStates, remoteStates);
    const revision = Math.max(0, Number(remoteSync.revision) || 0) + (remoteChanged ? 1 : 0);
    if (localChanged) await saveStates(mergedStates);
    const file = remoteChanged ? await storageProvider.save(mergedStates, remote?.file, { datasetId, revision, schemaVersion: 3 }) : remote.file;
    const latestConfig = storedConfig(), unchangedSinceSnapshot = Number(latestConfig.localRevision || 0) === syncRevision;
    saveConfig({ brokerConnected: true, datasetId, driveFileId: file?.id || remote?.file?.id || '', driveVersion: String(file?.version || remote?.file?.version || ''), driveRevision: revision, lastSyncAt: new Date().toISOString(), syncPendingSetup: false, remoteCandidates: [], lastSyncErrorCode: '', lastSyncErrorMessage: '', dirty: !unchangedSinceSnapshot, lastSyncedLocalRevision: unchangedSinceSnapshot ? syncRevision : Number(latestConfig.lastSyncedLocalRevision || 0) });
    if (localChanged) window.dispatchEvent(new CustomEvent('reboot:drive-merged'));
    return { file, merged: localChanged, uploaded: remoteChanged, revision };
  }
  async function syncWithLease(status, syncRevision) {
    const datasetId = status.dataset_id;
    for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt += 1) {
      const lease = await tokenProvider.acquireLease(datasetId);
      if (lease.status === 'busy') { await wait(retryDelay(attempt, lease.retryAfterMs)); continue; }
      if (lease.status !== 'acquired' || !lease.leaseId) throw new RebootDriveError('Le verrou de synchronisation est indisponible.', 'temporary', 'lease_unavailable');
      try { return await synchronize(status, syncRevision); }
      finally { try { await tokenProvider.releaseLease(lease.leaseId); } catch {} }
    }
    throw new RebootDriveError('Synchronisation retardée : un autre appareil est probablement en train de synchroniser. Vos modifications sont conservées sur cet appareil.', 'temporary', 'sync_busy');
  }
  async function syncNow() {
    if (syncing) { storageChangePending = true; return null; }
    syncing = true;
    try {
      const status = await tokenProvider.getStatus();
      if (status.reauth_required) { setStatus('reauth_required', 'Google Drive doit être reconnecté.'); return null; }
      if (!status.connected) { saveConfig({ brokerConnected: false }); setStatus('disconnected'); return null; }
      const syncRevision = Number(storedConfig().localRevision || 0);
      const rawLocalStates = await RebootArchive.readStates();
      const prepared = await prepareDataset(status, rawLocalStates);
      if (prepared.selectionRequired || prepared.pendingSetup) { setStatus('connected_idle'); return prepared; }
      setStatus('syncing');
      const result = await syncWithLease(prepared.status, syncRevision); setStatus('connected_idle'); return result;
    } catch (error) {
      const category = error?.category || 'temporary';
      saveConfig({ lastSyncErrorCode: error?.code || 'sync_error', lastSyncErrorMessage: error?.message || 'Synchronisation impossible.' });
      setStatus(category === 'reauth_required' ? 'reauth_required' : error?.code === 'sync_busy' ? 'sync_delayed' : 'sync_error', error.message || 'Synchronisation impossible.');
      return null;
    } finally {
      syncing = false;
      if (storageChangePending) { storageChangePending = false; queueAutomaticSync(); }
    }
  }
  function queueAutomaticSync() {
    if (applyingRemote) return;
    if (syncing) { storageChangePending = true; return; }
    clearTimeout(queuedSync); queuedSync = setTimeout(syncNow, 900);
  }
  function noteLocalChange(event) {
    if (applyingRemote) return;
    const databaseName = event?.detail?.databaseName;
    if (databaseName && ![DAILY.database, CALCULATOR.database].includes(databaseName)) return;
    const previous = storedConfig();
    saveConfig({ deviceId: deviceId(), localRevision: Number(previous.localRevision || 0) + 1, dirty: true });
    queueAutomaticSync();
  }
  async function startAutoSync(options = {}) {
    clearLegacyConfiguration();
    if (!listening) {
      listening = true;
      window.addEventListener('reboot:storage-saved', noteLocalChange);
      window.addEventListener('online', syncNow);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
    }
    clearInterval(syncTimer); syncTimer = setInterval(syncNow, options.intervalMs || 120000);
    return syncNow();
  }
  async function disconnect() { await tokenProvider.disconnect(); setStatus('disconnected'); }
  async function useDataset(datasetId) {
    const candidate = (storedConfig().remoteCandidates || []).find(item => item.datasetId === datasetId);
    if (!candidate) throw new RebootDriveError('Ce budget Google Drive doit être recherché à nouveau avant utilisation.', 'configuration_error', 'dataset_not_discovered');
    const status = await tokenProvider.adoptDataset(datasetId);
    saveConfig({ driveFileId: candidate.fileId, datasetId, syncPendingSetup: false, remoteCandidates: [], lastSyncErrorCode: '', lastSyncErrorMessage: '' });
    return syncNow(status);
  }
  async function replaceDataset(datasetId) {
    const candidate = (storedConfig().remoteCandidates || []).find(item => item.datasetId === datasetId);
    if (!candidate) throw new RebootDriveError('Ce budget Google Drive doit être recherché à nouveau avant utilisation.', 'configuration_error', 'dataset_not_discovered');
    const status = await tokenProvider.replaceDataset(datasetId);
    saveConfig({ driveFileId: candidate.fileId, datasetId, syncPendingSetup: false, remoteCandidates: [], lastSyncErrorCode: '', lastSyncErrorMessage: '' });
    return syncNow(status);
  }

  const initialSync = startAutoSync();
  window.RebootDrive = { config, synchronize: syncNow, upload: syncNow, pull: syncNow, mergeStates, syncNow, useDataset, replaceDataset, startAutoSync, initialSync: () => initialSync, disconnect, connect: returnTo => tokenProvider.connect(returnTo), deviceId, tokenProvider, storageProvider, RebootDriveError };
})();
