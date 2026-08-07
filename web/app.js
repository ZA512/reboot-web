const DATABASE_NAME = 'reboot-local-v1';
const DATABASE_VERSION = 1;
const LEGACY_STORAGE_KEY = 'reboot-local-v1';
const DATA_STORE = 'encryptedState';
const KEY_STORE = 'encryptionKeys';
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const currency = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
let saveQueue = Promise.resolve();

const defaultState = () => ({
  householdName: 'Notre foyer',
  configured: false,
  baseWeeklyBudgetMinor: 0,
  weeklyBudgetMinor: 0,
  rebootDay: null,
  expenses: [],
  reserves: []
});

let state = defaultState();
let storageError = '';
const $ = (selector) => document.querySelector(selector);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATA_STORE)) database.createObjectStore(DATA_STORE);
      if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRecord(database, storeName, key, value) {
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(storeName, 'readwrite');
      const request = transaction.objectStore(storeName).put(value, key);
      request.onerror = () => reject(request.error || new Error(`Écriture refusée dans ${storeName}`));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error(`Transaction refusée dans ${storeName}`));
      transaction.onabort = () => reject(transaction.error || new Error(`Transaction annulée dans ${storeName}`));
    } catch (error) {
      reject(error);
    }
  });
}

async function getEncryptionKey(database) {
  let existing;
  try {
    existing = await requestResult(database.transaction(KEY_STORE).objectStore(KEY_STORE).get('current'));
  } catch (error) {
    error.message = `read-key: ${error.message}`;
    throw error;
  }
  if (existing) return crypto.subtle.importKey('raw', existing, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', key);
  try {
    await putRecord(database, KEY_STORE, 'current', rawKey);
  } catch (error) {
    error.message = `write-key: ${error.message}`;
    throw error;
  }
  return key;
}

async function readEncryptedState() {
  const database = await openDatabase();
  const key = await getEncryptionKey(database);
  const stored = await requestResult(database.transaction(DATA_STORE).objectStore(DATA_STORE).get('current'));
  if (!stored) return null;
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, key, stored.ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function writeEncryptedState(nextState) {
  let stage = 'open';
  try {
    const database = await openDatabase();
    stage = 'key';
    const key = await getEncryptionKey(database);
    stage = 'encrypt';
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(nextState));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    stage = 'put';
    await putRecord(database, DATA_STORE, 'current', { iv, ciphertext });
  } catch (error) {
    throw new Error(`write-state/${stage}: ${error.name || 'Error'}: ${error.message || ''}`);
  }
}

async function loadState() {
  const encrypted = await readEncryptedState();
  if (encrypted) return { ...defaultState(), ...encrypted };
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  const migrated = legacy ? { ...defaultState(), ...JSON.parse(legacy) } : defaultState();
  await writeEncryptedState(migrated);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return migrated;
}

function saveState() {
  saveQueue = saveQueue.then(() => writeEncryptedState(state)).then(() => {
    storageError = '';
  }).catch((error) => {
    storageError = `${error?.name || 'Erreur inconnue'}${error?.message ? `: ${error.message}` : ''}`;
    console.error('REBOOT storage error', error);
    $('#freshness').innerHTML = `<span class="status-dot" style="background:#d96b50"></span>Stockage local indisponible (${storageError})`;
  });
  return saveQueue;
}

function eurosToMinor(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized || !/^\d+(\.\d{1,2})?$/.test(normalized)) return 0;
  const [euros, cents = ''] = normalized.split('.');
  return Number(euros) * 100 + Number((cents + '00').slice(0, 2));
}

function formatMoney(minor) {
  return currency.format((Number(minor) || 0) / 100);
}

function dateKey(date) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return local.toISOString().slice(0, 10);
}

function startOfCycle(today = new Date()) {
  if (state.rebootDay === null || state.rebootDay === undefined || !state.configured) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const difference = (start.getDay() - Number(state.rebootDay) + 7) % 7;
  start.setDate(start.getDate() - difference);
  return start;
}

function effectiveWeeklyBudgetMinor() {
  const base = state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor || 0;
  const reserveDeduction = state.reserves.reduce((sum, reserve) => sum + Math.ceil((reserve.annualTargetMinor || 0) / 52), 0);
  return Math.max(0, base - reserveDeduction);
}

function reserveDeductionMinor() {
  return state.reserves.reduce((sum, reserve) => sum + Math.ceil((reserve.annualTargetMinor || 0) / 52), 0);
}

function cycleInfo() {
  const start = startOfCycle();
  if (!start) return { configured: false, start: null, end: null, daysLeft: null, spentMinor: 0, budgetMinor: 0, remainingMinor: null };
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const today = new Date();
  const daysLeft = Math.max(1, Math.ceil((new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000));
  const weeklyExpenses = state.expenses.filter((expense) => expense.funding === 'weekly' && !expense.deletedAt && expense.date >= dateKey(start) && expense.date <= dateKey(end));
  const spentMinor = weeklyExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0);
  const budgetMinor = effectiveWeeklyBudgetMinor();
  return { configured: true, start, end, daysLeft, spentMinor, budgetMinor, remainingMinor: budgetMinor - spentMinor };
}

function shortDate(dateString) {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(`${dateString}T12:00:00`));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function render() {
  const cycle = cycleInfo();
  if (!cycle.configured) {
    $('#remaining').textContent = '—';
    $('#budgetTotal').textContent = 'À définir';
    $('#cycleDates').textContent = 'Aucun cycle configuré';
    $('#daysLeft').textContent = 'Configurez votre semaine';
    $('#dailyGuide').textContent = '—';
    $('#balanceTrack').style.width = '0%';
    $('#reserveDeduction').classList.add('hidden');
    $('#freshness').innerHTML = storageError ? `<span class="status-dot" style="background:#d96b50"></span>Stockage local indisponible (${storageError})` : '<span class="status-dot"></span>Configuration locale';
    renderSignal(cycle);
    renderExpenses(null);
    renderReserves();
    updateSettingsFields();
    return;
  }
  const budget = cycle.budgetMinor;
  const percentageSpent = budget > 0 ? Math.min(100, Math.max(0, (cycle.spentMinor / budget) * 100)) : 0;
  const dailyGuide = cycle.daysLeft ? Math.max(0, cycle.remainingMinor) / cycle.daysLeft : 0;
  const remaining = $('#remaining');
  remaining.textContent = formatMoney(cycle.remainingMinor);
  remaining.classList.toggle('negative', cycle.remainingMinor < 0);
  $('#budgetTotal').textContent = formatMoney(budget);
  $('#cycleDates').textContent = `${shortDate(dateKey(cycle.start))} → ${shortDate(dateKey(cycle.end))}`;
  $('#daysLeft').textContent = cycle.daysLeft === 1 ? 'jusqu’à demain' : `${cycle.daysLeft} jours restants`;
  $('#dailyGuide').textContent = `${formatMoney(dailyGuide)} / jour`;
  const deduction = reserveDeductionMinor();
  $('#reserveDeduction').classList.toggle('hidden', deduction === 0);
  $('#reserveDeduction').innerHTML = deduction ? `Réserves : − ${formatMoney(deduction)} / semaine` : '';
  $('#balanceTrack').style.width = `${percentageSpent}%`;
  $('#balanceTrack').style.background = cycle.remainingMinor < 0 ? '#e58b76' : '';
  $('#freshness').innerHTML = storageError ? `<span class="status-dot" style="background:#d96b50"></span>Stockage local indisponible (${storageError})` : '<span class="status-dot"></span>Local uniquement';
  renderSignal(cycle);
  renderExpenses(cycle);
  renderReserves();
  updateSettingsFields();
}

function renderSignal(cycle) {
  const title = $('#signalTitle');
  const text = $('#signalText');
  if (!cycle.configured || (!state.baseWeeklyBudgetMinor && !state.weeklyBudgetMinor)) {
    title.textContent = 'Configurez votre semaine';
    text.textContent = 'Définissez le budget et le jour REBOOT de votre foyer pour commencer.';
    return;
  }
  if (cycle.remainingMinor < 0) {
    title.textContent = 'Le cycle est dépassé';
    text.textContent = `${formatMoney(Math.abs(cycle.remainingMinor))} au-delà du budget prévu. Le cycle suivant ne sera pas modifié automatiquement.`;
  } else if (cycle.daysLeft <= 2) {
    title.textContent = 'Derniers jours du cycle';
    text.textContent = `Il reste ${formatMoney(cycle.remainingMinor)} à tenir jusqu’au ${DAY_NAMES[state.rebootDay]}.`;
  } else {
    title.textContent = 'Le cap est clair';
    text.textContent = `Votre repère pour aujourd’hui est de ${formatMoney(Math.max(0, cycle.remainingMinor) / cycle.daysLeft)}. Il reste ${cycle.daysLeft} jours.`;
  }
}

function renderExpenses(cycle) {
  const list = $('#expenseList');
  if (!cycle) {
    $('#emptyState').classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  const activeExpenses = state.expenses.filter((expense) => !expense.deletedAt && expense.date >= dateKey(cycle.start) && expense.date <= dateKey(cycle.end)).sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`));
  $('#emptyState').classList.toggle('hidden', activeExpenses.length > 0);
  list.innerHTML = activeExpenses.map((expense) => {
    const fundingLabel = expense.funding === 'weekly' ? 'Budget de la semaine' : `Réserve · ${escapeHtml(expense.reserveName || 'sans nom')}`;
    const symbol = expense.funding === 'reserve' ? '↗' : '−';
    return `<article class="expense-item ${expense.funding}"><div class="expense-symbol" aria-hidden="true">${symbol}</div><div><div class="expense-label">${escapeHtml(expense.label)}</div><div class="expense-meta">${shortDate(expense.date)} · ${fundingLabel}</div></div><div class="expense-amount">− ${formatMoney(expense.amountMinor)}</div><div class="expense-actions"><button class="delete-expense" data-delete="${expense.id}" type="button">Supprimer</button></div></article>`;
  }).join('');
  list.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteExpense(button.dataset.delete)));
}

function renderReserves() {
  const list = $('#reserveList');
  if (!state.reserves.length) {
    list.innerHTML = '<p class="no-reserve">Aucune réserve pour le moment.</p>';
    return;
  }
  list.innerHTML = state.reserves.map((reserve) => `<div class="reserve-item"><div><span class="reserve-name">${escapeHtml(reserve.name)}</span><span class="reserve-kind">${reserve.real ? 'Compte séparé' : 'Virtuelle'} · ${formatMoney(reserve.monthlyContributionMinor || 0)} / mois · − ${formatMoney(Math.ceil((reserve.annualTargetMinor || 0) / 52))} / sem.</span></div><span class="reserve-balance">${formatMoney(reserveBalance(reserve))}</span></div>`).join('');
}

function openExpenseDialog() {
  $('#expenseForm').reset();
  populateReserveOptions();
  renderRecentLabels();
  toggleReserveChoice();
  $('#expenseDialog').showModal();
  $('#expenseAmount').focus();
}

function populateReserveOptions() {
  const select = $('#expenseReserve');
  select.innerHTML = state.reserves.length ? state.reserves.map((reserve) => `<option value="${reserve.id}">${escapeHtml(reserve.name)} · ${formatMoney(reserveBalance(reserve))}</option>`).join('') : '<option value="">Aucune réserve disponible</option>';
}

function toggleReserveChoice() {
  $('#reserveFundingChoice').classList.toggle('hidden', !state.reserves.length);
  $('#reserveChoice').classList.toggle('hidden', document.querySelector('input[name="funding"]:checked')?.value !== 'reserve');
}

function renderRecentLabels() {
  const labels = [...new Set(state.expenses.filter((expense) => !expense.deletedAt).sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`)).map((expense) => expense.label.trim()).filter(Boolean))].slice(0, 4);
  $('#recentLabels').innerHTML = labels.map((label) => `<button class="recent-label" type="button" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join('');
  $('#recentLabels').querySelectorAll('[data-label]').forEach((button) => button.addEventListener('click', () => { $('#expenseLabel').value = button.dataset.label; $('#expenseLabel').focus(); }));
}

function monthsSince(dateString, today = new Date()) {
  const opened = new Date(`${dateString}T12:00:00`);
  let months = (today.getFullYear() - opened.getFullYear()) * 12 + today.getMonth() - opened.getMonth();
  if (today.getDate() < opened.getDate()) months -= 1;
  return Math.max(0, months);
}

function currentReservePeriodStart(reserve, today = new Date()) {
  const opened = new Date(`${reserve.openedOn || dateKey(today)}T12:00:00`);
  let anniversary = new Date(today.getFullYear(), opened.getMonth(), opened.getDate(), 12);
  if (anniversary > today) anniversary.setFullYear(anniversary.getFullYear() - 1);
  return anniversary < opened ? opened : anniversary;
}

function monthsBetween(startDate, endDate) {
  return Math.max(0, (endDate.getFullYear() - startDate.getFullYear()) * 12 + endDate.getMonth() - startDate.getMonth() - (endDate.getDate() < startDate.getDate() ? 1 : 0));
}

function reserveBalance(reserve) {
  const opened = new Date(`${reserve.openedOn || dateKey(new Date())}T12:00:00`);
  const periodStart = currentReservePeriodStart(reserve);
  const initialBalance = reserve.initialBalanceMinor ?? reserve.balanceMinor ?? 0;
  const monthlyContribution = reserve.monthlyContributionMinor || 0;
  const expenses = state.expenses.filter((expense) => expense.funding === 'reserve' && expense.reserveId === reserve.id && !expense.deletedAt);
  const beforePeriod = expenses.filter((expense) => new Date(`${expense.date}T12:00:00`) < periodStart).reduce((sum, expense) => sum + expense.amountMinor, 0);
  const inPeriod = expenses.filter((expense) => new Date(`${expense.date}T12:00:00`) >= periodStart).reduce((sum, expense) => sum + expense.amountMinor, 0);
  const balanceAtPeriodStart = initialBalance + monthsBetween(opened, periodStart) * monthlyContribution - beforePeriod;
  return Math.max(0, balanceAtPeriodStart + monthsSince(dateKey(periodStart)) * monthlyContribution - inPeriod);
}

async function saveExpense(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = new FormData($('#expenseForm'));
  const amountMinor = eurosToMinor(form.get('amount'));
  if (!amountMinor || !String(form.get('label')).trim()) return;
  const funding = form.get('funding');
  const reserve = state.reserves.find((item) => item.id === form.get('reserve'));
  if (funding === 'reserve' && !reserve) return;
  state.expenses.push({ id: createId(), date: dateKey(new Date()), createdAt: new Date().toISOString(), amountMinor, label: String(form.get('label')).trim(), funding, reserveId: reserve?.id || '', reserveName: reserve?.name || '' });
  await saveState();
  $('#expenseDialog').close();
  render();
}

function deleteExpense(id) {
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense) return;
  expense.deletedAt = new Date().toISOString();
  saveState();
  render();
}

function openSettings() {
  updateSettingsFields();
  $('#settingsDialog').showModal();
}

function updateSettingsFields() {
  $('#householdName').value = state.householdName;
  $('#weeklyBudget').value = (state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor) ? ((state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor) / 100).toFixed(2) : '';
  $('#rebootDay').value = state.rebootDay ?? '';
}

async function saveSettings(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  state.householdName = $('#householdName').value.trim() || 'Notre foyer';
  if (!$('#weeklyBudget').value || $('#rebootDay').value === '') return;
  state.baseWeeklyBudgetMinor = eurosToMinor($('#weeklyBudget').value);
  state.weeklyBudgetMinor = state.baseWeeklyBudgetMinor;
  state.rebootDay = Number($('#rebootDay').value);
  state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined);
  await saveState();
  $('#settingsDialog').close();
  render();
}

async function saveReserve(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const name = $('#reserveName').value.trim();
  if (!name) return;
  const monthlyValue = eurosToMinor($('#reserveMonthly').value);
  const annualTargetMinor = monthlyValue ? monthlyValue * 12 : eurosToMinor($('#reserveTarget').value);
  if (!monthlyValue && !annualTargetMinor) return;
  state.reserves.push({ id: createId(), name, initialBalanceMinor: eurosToMinor($('#reserveBalance').value), annualTargetMinor, monthlyContributionMinor: monthlyValue || Math.floor(annualTargetMinor / 12), openedOn: $('#reserveOpenedOn').value || dateKey(new Date()), real: $('#reserveReal').checked });
  await saveState();
  $('#reserveDialog').close();
  render();
}

function updateReservePreview() {
  const monthly = eurosToMinor($('#reserveMonthly').value);
  const annual = monthly ? monthly * 12 : eurosToMinor($('#reserveTarget').value);
  const weekly = Math.ceil(annual / 52);
  $('#reserveImpact').innerHTML = annual ? `Cette réserve réduira le budget disponible de<strong>${formatMoney(weekly)} par semaine</strong>` : 'Indiquez un versement mensuel ou un objectif annuel pour voir l’impact sur votre budget.';
  $('#reserveBankWarning').classList.toggle('hidden', !$('#reserveReal').checked || !monthly);
  if (!$('#reserveBankWarning').classList.contains('hidden')) $('#reserveBankWarning').textContent = `Vérification importante : veuillez mettre en place un virement permanent de votre compte principal vers le compte de réserve, de ${formatMoney(monthly)} par mois.`;
}

$('#addExpenseButton').addEventListener('click', openExpenseDialog);
$('#emptyAddButton').addEventListener('click', openExpenseDialog);
$('#settingsButton').addEventListener('click', openSettings);
$('#addReserveButton').addEventListener('click', () => { $('#reserveForm').reset(); $('#reserveOpenedOn').value = dateKey(new Date()); updateReservePreview(); $('#reserveDialog').showModal(); });
$('#expenseForm').addEventListener('submit', saveExpense);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#reserveForm').addEventListener('submit', saveReserve);
document.querySelectorAll('input[name="funding"]').forEach((input) => input.addEventListener('change', toggleReserveChoice));
['reserveMonthly', 'reserveTarget', 'reserveReal'].forEach((id) => $(`#${id}`).addEventListener('input', updateReservePreview));
$('#startLocalButton').addEventListener('click', () => { $('#welcomeDialog').close(); openSettings(); });

async function init() {
  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=4', { updateViaCache: 'none' }).catch(() => {});
    state = await loadState();
    state.baseWeeklyBudgetMinor ||= state.weeklyBudgetMinor || 0;
    state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== '');
    render();
    if (!state.configured) $('#welcomeDialog').showModal();
  } catch {
    storageError = 'Coffre IndexedDB verrouillé';
    render();
    $('#welcomeDialog').showModal();
  }
}

init();
