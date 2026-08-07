(() => {
  const DATABASE_VERSION = 1;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function openDatabase(databaseName) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('state')) database.createObjectStore('state');
        if (!database.objectStoreNames.contains('keys')) database.createObjectStore('keys');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getKey(database) {
    const store = database.transaction('keys', 'readwrite').objectStore('keys');
    const existing = await requestResult(store.get('current'));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await requestResult(store.put(key, 'current'));
    return key;
  }

  async function read(databaseName, legacyKey) {
    const database = await openDatabase(databaseName);
    const key = await getKey(database);
    const stored = await requestResult(database.transaction('state').objectStore('state').get('current'));
    if (stored) {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, key, stored.ciphertext);
      return JSON.parse(new TextDecoder().decode(plaintext));
    }
    const legacy = localStorage.getItem(legacyKey);
    if (!legacy) return null;
    const migrated = JSON.parse(legacy);
    await write(database, key, migrated);
    localStorage.removeItem(legacyKey);
    return migrated;
  }

  async function write(database, key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    await requestResult(database.transaction('state', 'readwrite').objectStore('state').put({ iv, ciphertext }, 'current'));
  }

  async function save(databaseName, value) {
    const database = await openDatabase(databaseName);
    await write(database, await getKey(database), value);
  }

  async function clear(databaseName, legacyKey) {
    const database = await openDatabase(databaseName);
    await requestResult(database.transaction('state', 'readwrite').objectStore('state').delete('current'));
    localStorage.removeItem(legacyKey);
  }

  window.RebootSecureStorage = { read, save, clear };
})();
