(() => {
  const DAILY = { database: 'reboot-local-v1', legacy: 'reboot-local-v1' };
  const CALCULATOR = { database: 'reboot-calculator-v1', legacy: 'reboot-site-v02' };
  const ARCHIVE_FORMAT = 'reboot-encrypted-archive';
  const PLAIN_ARCHIVE_FORMAT = 'reboot-plain-archive';
  const ARCHIVE_VERSION = 1;
  const KDF_ITERATIONS = 600000;
  const AAD = new TextEncoder().encode('REBOOT archive v1');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function keyFromPassphrase(passphrase, salt, usages) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, usages);
  }

  async function readStates() {
    return {
      daily: await RebootSecureStorage.read(DAILY.database, DAILY.legacy),
      calculator: await RebootSecureStorage.read(CALCULATOR.database, CALCULATOR.legacy)
    };
  }

  async function createFromStates(states, passphrase, options = {}) {
    const payload = { format: 'reboot-archive-payload', version: ARCHIVE_VERSION, exportedAt: new Date().toISOString(), states, ...(options.sync ? { sync: options.sync } : {}) };
    if (options.encrypted === false) return JSON.stringify({ format: PLAIN_ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: payload.exportedAt, payload }, null, 2);
    if (typeof passphrase !== 'string' || passphrase.length < 16) throw new Error('Le code de chiffrement doit contenir au moins 16 caractères.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFromPassphrase(passphrase, salt, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, encoder.encode(JSON.stringify(payload)));
    return JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: payload.exportedAt, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64(salt) }, cipher: { name: 'AES-GCM', iv: toBase64(iv), ciphertext: toBase64(ciphertext) } }, null, 2);
  }

  async function create(passphrase, options = {}) { return createFromStates(await readStates(), passphrase, options); }

  async function open(text, passphrase) {
    let archive;
    try { archive = JSON.parse(text); } catch { throw new Error('Le fichier n’est pas une sauvegarde REBOOT valide.'); }
    if (archive?.format === PLAIN_ARCHIVE_FORMAT && archive.version === ARCHIVE_VERSION) {
      if (archive.payload?.format === 'reboot-archive-payload' && archive.payload.version === ARCHIVE_VERSION && archive.payload.states) return archive.payload;
      throw new Error('Contenu de sauvegarde invalide.');
    }
    if (archive?.format !== ARCHIVE_FORMAT || archive.version !== ARCHIVE_VERSION || archive.kdf?.name !== 'PBKDF2' || archive.cipher?.name !== 'AES-GCM') throw new Error('Format de sauvegarde REBOOT inconnu.');
    try {
      const salt = fromBase64(archive.kdf.salt);
      const iv = fromBase64(archive.cipher.iv);
      const ciphertext = fromBase64(archive.cipher.ciphertext);
      const key = await keyFromPassphrase(passphrase, salt, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, ciphertext);
      const payload = JSON.parse(decoder.decode(plaintext));
      if (payload?.format !== 'reboot-archive-payload' || payload.version !== ARCHIVE_VERSION || !payload.states) throw new Error('Contenu de sauvegarde invalide.');
      return payload;
    } catch (error) {
      if (error.message === 'Contenu de sauvegarde invalide.') throw error;
      throw new Error('Impossible d’ouvrir la sauvegarde : code de récupération incorrect ou fichier altéré.');
    }
  }

  async function restore(payload) {
    if (!payload?.states) throw new Error('Contenu de sauvegarde invalide.');
    if (payload.states.daily) await RebootSecureStorage.save(DAILY.database, payload.states.daily);
    else await RebootSecureStorage.clear(DAILY.database, DAILY.legacy);
    if (payload.states.calculator) await RebootSecureStorage.save(CALCULATOR.database, payload.states.calculator);
    else await RebootSecureStorage.clear(CALCULATOR.database, CALCULATOR.legacy);
  }

  async function noteBackup(kind) {
    if (!['local', 'drive'].includes(kind)) return;
    const daily = await RebootSecureStorage.read(DAILY.database, DAILY.legacy);
    if (!daily) return;
    daily.backupStatus = { ...(daily.backupStatus || {}), [kind]: new Date().toISOString() };
    await RebootSecureStorage.save(DAILY.database, daily);
  }

  function recoveryCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const groups = [];
    for (let group = 0; group < 5; group += 1) {
      let value = '';
      for (let index = 0; index < 4; index += 1) value += alphabet[bytes[group * 4 + index] % alphabet.length];
      groups.push(value);
    }
    return groups.join('-');
  }

  window.RebootArchive = { create, createFromStates, open, restore, readStates, noteBackup, recoveryCode };
})();
