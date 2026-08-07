const ENTRY_DATABASE = 'reboot-local-v1';
const ENTRY_DATA_STORE = 'encryptedState';
const ENTRY_KEY_STORE = 'encryptionKeys';

function entryRequestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openEntryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ENTRY_DATABASE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function hasConfiguredLocalTracker() {
  const database = await openEntryDatabase();
  try {
    if (!database.objectStoreNames.contains(ENTRY_DATA_STORE) || !database.objectStoreNames.contains(ENTRY_KEY_STORE)) return false;
    const rawKey = await entryRequestResult(database.transaction(ENTRY_KEY_STORE).objectStore(ENTRY_KEY_STORE).get('current'));
    const stored = await entryRequestResult(database.transaction(ENTRY_DATA_STORE).objectStore(ENTRY_DATA_STORE).get('current'));
    if (!rawKey || !stored) return false;
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, key, stored.ciphertext);
    const state = JSON.parse(new TextDecoder().decode(plaintext));
    return Number(state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor) > 0 && state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== '';
  } finally {
    database.close();
  }
}

hasConfiguredLocalTracker().then((configured) => {
  if (configured) window.location.replace('app.html');
}).catch(() => {
  // An unreadable local store must never block access to the onboarding page.
});