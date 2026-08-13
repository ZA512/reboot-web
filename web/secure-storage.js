(() => {
  const DATABASE_VERSION = 2;
  const STATE_STORE = 'state';
  const KEY_STORE = 'keys';
  const LEGACY_DAILY_STATE_STORE = 'encryptedState';
  const LEGACY_DAILY_KEY_STORE = 'encryptionKeys';

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function isCryptoKey(value) {
    return value && typeof value === 'object' && value.type && value.algorithm && value.usages;
  }

  async function openDatabase(databaseName) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE);
        if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getKey(database) {
    const existing = await requestResult(database.transaction(KEY_STORE).objectStore(KEY_STORE).get('current'));
    if (isCryptoKey(existing)) return existing;
    if (existing) return crypto.subtle.importKey('raw', existing, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await requestResult(database.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(key, 'current'));
    return key;
  }

  async function legacyDailyState(database) {
    if (!database.objectStoreNames.contains(LEGACY_DAILY_STATE_STORE) || !database.objectStoreNames.contains(LEGACY_DAILY_KEY_STORE)) return null;
    const transaction = database.transaction([LEGACY_DAILY_STATE_STORE, LEGACY_DAILY_KEY_STORE]);
    const storedRequest = transaction.objectStore(LEGACY_DAILY_STATE_STORE).get('current');
    const keyRequest = transaction.objectStore(LEGACY_DAILY_KEY_STORE).get('current');
    const [stored, rawKey] = await Promise.all([requestResult(storedRequest), requestResult(keyRequest)]);
    if (!stored || !rawKey) return null;
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, key, stored.ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function write(database, key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    await requestResult(database.transaction(STATE_STORE, 'readwrite').objectStore(STATE_STORE).put({ iv, ciphertext }, 'current'));
  }

  async function read(databaseName, legacyKey) {
    const database = await openDatabase(databaseName);
    try {
      const key = await getKey(database);
      const stored = await requestResult(database.transaction(STATE_STORE).objectStore(STATE_STORE).get('current'));
      if (stored) {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, key, stored.ciphertext);
        return JSON.parse(new TextDecoder().decode(plaintext));
      }

      const legacyDaily = await legacyDailyState(database);
      if (legacyDaily) {
        await write(database, key, legacyDaily);
        return legacyDaily;
      }

      const legacy = legacyKey ? localStorage.getItem(legacyKey) : null;
      if (!legacy) return null;
      const migrated = JSON.parse(legacy);
      await write(database, key, migrated);
      localStorage.removeItem(legacyKey);
      return migrated;
    } finally {
      database.close();
    }
  }

  async function save(databaseName, value) {
    const database = await openDatabase(databaseName);
    try {
      await write(database, await getKey(database), value);
    } finally {
      database.close();
    }
    window.dispatchEvent(new CustomEvent('reboot:storage-saved', { detail: { databaseName } }));
  }

  async function clear(databaseName, legacyKey) {
    const database = await openDatabase(databaseName);
    try {
      const stores = [STATE_STORE];
      if (database.objectStoreNames.contains(LEGACY_DAILY_STATE_STORE)) stores.push(LEGACY_DAILY_STATE_STORE);
      const transaction = database.transaction(stores, 'readwrite');
      const requests = [requestResult(transaction.objectStore(STATE_STORE).delete('current'))];
      if (stores.includes(LEGACY_DAILY_STATE_STORE)) requests.push(requestResult(transaction.objectStore(LEGACY_DAILY_STATE_STORE).delete('current')));
      await Promise.all(requests);
      if (legacyKey) localStorage.removeItem(legacyKey);
    } finally {
      database.close();
    }
    window.dispatchEvent(new CustomEvent('reboot:storage-cleared', { detail: { databaseName } }));
  }

  window.RebootSecureStorage = { read, save, clear };
})();
