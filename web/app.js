const DATABASE_NAME = 'reboot-local-v1';
const LEGACY_STORAGE_KEY = 'reboot-local-v1';
const CALCULATOR_DATABASE = 'reboot-calculator-v1';
const CALCULATOR_STORE = 'reboot-site-v02';
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
  refunds: [],
  reserves: [],
  importedBankOperations: [],
  auditEvents: [],
  backupStatus: {},
  onboarding: null
});

let state = defaultState();
let storageError = '';
let calculatorRefreshReason = '';
let editingExpenseId = null;
let editingReserveId = null;
const $ = (selector) => document.querySelector(selector);

async function loadState() {
  const stored = await RebootSecureStorage.read(DATABASE_NAME, LEGACY_STORAGE_KEY);
  return stored ? { ...defaultState(), ...stored } : defaultState();
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  saveQueue = saveQueue.then(() => RebootSecureStorage.save(DATABASE_NAME, state)).then(() => {
    storageError = '';
  }).catch((error) => {
    storageError = `${error?.name || 'Erreur inconnue'}${error?.message ? `: ${error.message}` : ''}`;
    console.error('REBOOT storage error', error);
    $('#freshness').innerHTML = `<span class="status-dot" style="background:#d96b50"></span>Stockage local indisponible (${storageError})`;
  });
  return saveQueue;
}

function showSyncCompleteNotice() {
  let notice;
  try { notice = JSON.parse(sessionStorage.getItem('reboot-sync-complete') || 'null'); sessionStorage.removeItem('reboot-sync-complete'); } catch { return false; }
  if (!notice) return false;
  $('#syncCompleteMessage').textContent = notice.restored
    ? 'Votre budget Google a été récupéré sur cet appareil. Vous pouvez maintenant reprendre votre suivi.'
    : notice.merged
    ? 'Votre copie Google est à jour et les changements trouvés sur vos autres appareils ont été réunis.'
    : `Votre sauvegarde ${notice.mode === 'protected' ? 'protégée' : ''} est maintenant enregistrée dans Google Drive.`;
  $('#syncCompleteDialog').showModal();
  return true;
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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  const reserveDeduction = state.reserves
    .filter((reserve) => !reserve.closedAt && !reserve.includedInCalculatorBudget)
    .reduce((sum, reserve) => sum + Math.ceil((reserve.annualTargetMinor || 0) / 52), 0);
  return Math.max(0, base - reserveDeduction);
}

function reserveDeductionMinor() {
  return state.reserves
    .filter((reserve) => !reserve.closedAt && !reserve.includedInCalculatorBudget)
    .reduce((sum, reserve) => sum + Math.ceil((reserve.annualTargetMinor || 0) / 52), 0);
}

function cycleInfo() {
  const start = startOfCycle();
  if (!start) return { configured: false, start: null, end: null, daysLeft: null, spentMinor: 0, refundMinor: 0, budgetMinor: 0, remainingMinor: null };
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const today = new Date();
  const daysLeft = Math.max(1, Math.ceil((new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000));
  const weeklyExpenses = state.expenses.filter((expense) => expense.funding === 'weekly' && !expense.deletedAt && expense.date >= dateKey(start) && expense.date <= dateKey(end));
  const spentMinor = weeklyExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0);
  const refundMinor = state.refunds.filter((refund) => refund.applyToBudget && !refund.deletedAt && refund.date >= dateKey(start) && refund.date <= dateKey(end)).reduce((sum, refund) => sum + refund.amountMinor, 0);
  const budgetMinor = effectiveWeeklyBudgetMinor();
  return { configured: true, start, end, daysLeft, spentMinor, refundMinor, budgetMinor, remainingMinor: budgetMinor - spentMinor + refundMinor };
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

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordEvent(type, entity, entityId, before = null, after = null) {
  state.auditEvents.push({ id: createId(), type, entity, entityId, at: new Date().toISOString(), before: before ? snapshot(before) : null, after: after ? snapshot(after) : null });
}

function calculatorIncludesReserve(name, monthlyContributionMinor) {
  const lines = state.calculatorBudget?.permanentReserveLines || [];
  return lines.some((line) => String(line.name).trim().toLocaleUpperCase('fr-FR') === String(name).trim().toLocaleUpperCase('fr-FR')
    && Math.abs(Number(line.monthlyContributionMinor) - Number(monthlyContributionMinor)) <= 1);
}

function renderFreshness() {
  const freshness = $('#freshness');
  if (storageError) {
    freshness.innerHTML = `<span class="status-dot" style="background:#d96b50"></span>Stockage local indisponible (${storageError})`;
    return;
  }
  const backups = Object.entries(state.backupStatus || {}).filter(([, at]) => at && Number.isFinite(new Date(at).getTime())).sort(([, first], [, second]) => new Date(second) - new Date(first));
  if (!backups.length) {
    freshness.innerHTML = '<span class="status-dot"></span>Local uniquement';
    return;
  }
  const [kind, at] = backups[0];
  const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  freshness.innerHTML = `<span class="status-dot"></span>${kind === 'drive' ? 'Drive synchronisé' : 'Sauvegarde locale'} · ${date}`;
}

function render() {
  const cycle = cycleInfo();
  const onboardingActive = Boolean(!cycle.configured && state.onboarding?.storage);
  document.body.classList.toggle('onboarding-active', onboardingActive);
  $('#onboardingPanel').classList.toggle('hidden', !onboardingActive);
  if (onboardingActive) {
    $('#onboardingStorageNote').textContent = state.onboarding.storage === 'drive'
      ? 'Après le calcul, vous choisirez la protection de votre première sauvegarde Google Drive.'
      : 'Votre dossier restera dans ce navigateur. Vous pourrez activer Google Drive plus tard si vous le souhaitez.';
  }
  renderReviewStatus();
  if (!cycle.configured) {
    $('#remaining').textContent = '—';
    $('#budgetTotal').textContent = 'À définir';
    $('#cycleDates').textContent = 'Aucun cycle configuré';
    $('#daysLeft').textContent = 'Configurez votre semaine';
    $('#dailyGuide').textContent = '—';
    $('#balanceTrack').style.width = '0%';
    $('#reserveDeduction').classList.add('hidden');
    renderFreshness();
    renderSignal(cycle);
    renderExpenses(null);
    renderReserves();
    updateSettingsFields();
    return;
  }
  const budget = cycle.budgetMinor;
  const percentageSpent = budget > 0 ? Math.min(100, Math.max(0, ((cycle.spentMinor - cycle.refundMinor) / budget) * 100)) : 0;
  const dailyGuide = cycle.daysLeft ? Math.max(0, cycle.remainingMinor) / cycle.daysLeft : 0;
  const remaining = $('#remaining');
  remaining.textContent = formatMoney(cycle.remainingMinor);
  remaining.classList.toggle('negative', cycle.remainingMinor < 0);
  $('#budgetTotal').textContent = formatMoney(budget);
  $('#cycleDates').textContent = `${shortDate(dateKey(cycle.start))} → ${shortDate(dateKey(cycle.end))}`;
  $('#daysLeft').textContent = cycle.daysLeft === 1 ? 'jusqu’à demain' : `${cycle.daysLeft} jours restants`;
  $('#dailyGuide').textContent = `${formatMoney(dailyGuide)} / jour`;
  const deduction = reserveDeductionMinor();
  $('#reserveDeduction').classList.toggle('hidden', deduction === 0 && cycle.refundMinor === 0);
  $('#reserveDeduction').innerHTML = [deduction ? `Réserves : − ${formatMoney(deduction)} / semaine` : '', cycle.refundMinor ? `Remboursements : + ${formatMoney(cycle.refundMinor)}` : ''].filter(Boolean).join('<br>');
  $('#balanceTrack').style.width = `${percentageSpent}%`;
  $('#balanceTrack').style.background = cycle.remainingMinor < 0 ? '#e58b76' : '';
  renderFreshness();
  renderSignal(cycle);
  renderExpenses(cycle);
  renderReserves();
  updateSettingsFields();
}

function renderReviewStatus() {
  const reviewText = $('#reviewText');
  if (!reviewText) return;
  const reviewDot = reviewText.previousElementSibling;
  reviewDot?.classList.toggle('warn', Boolean(calculatorRefreshReason));
  if (calculatorRefreshReason) {
    reviewText.textContent = calculatorRefreshReason === 'expired' ? 'Une charge est arrivée à échéance' : 'Budget modifié à envoyer au suivi';
    return;
  }
  const pendingOperations = (state.importedBankOperations || []).filter((operation) => !operation.classification && !operation.reconciledExpenseId).length;
  if (pendingOperations) {
    reviewText.textContent = `${pendingOperations} opération${pendingOperations > 1 ? 's' : ''} à vérifier`;
    return;
  }
  if (state.budgetSource !== 'calculator' || !state.calculatorBudget?.updatedAt) {
    reviewText.textContent = 'Budget provisoire à structurer';
    return;
  }
  const updatedAt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(state.calculatorBudget.updatedAt));
  reviewText.textContent = `Budget calculé le ${updatedAt}`;
}

function renderSignal(cycle) {
  const title = $('#signalTitle');
  const text = $('#signalText');
  if (!cycle.configured || (!state.baseWeeklyBudgetMinor && !state.weeklyBudgetMinor)) {
    title.textContent = 'Préparez votre budget';
    text.textContent = 'Ajoutez vos revenus, charges et dépenses annuelles dans le calculateur avant de suivre vos dépenses.';
    return;
  }
  if (calculatorRefreshReason) {
    title.textContent = 'Budget à actualiser';
    text.textContent = calculatorRefreshReason === 'expired'
      ? 'Une charge du calculateur est arrivée à échéance. Confirmez-la puis renvoyez le budget vers ce suivi.'
      : 'Le calculateur a été modifié depuis le dernier envoi. Renvoyez le budget une fois vos changements vérifiés.';
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
    $('#historySection').classList.add('hidden');
    return;
  }
  const entries = [...state.expenses.filter((expense) => !expense.deletedAt).map((expense) => ({ ...expense, entryType: 'expense' })), ...state.refunds.filter((refund) => !refund.deletedAt).map((refund) => ({ ...refund, entryType: 'refund' }))];
  const currentEntries = entries.filter((entry) => entry.date >= dateKey(cycle.start) && entry.date <= dateKey(cycle.end)).sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`));
  $('#emptyState').classList.toggle('hidden', currentEntries.length > 0);
  list.innerHTML = currentEntries.map(expenseHtml).join('');
  const historicalEntries = entries.filter((entry) => entry.date < dateKey(cycle.start) || entry.date > dateKey(cycle.end)).sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`));
  $('#historySection').classList.toggle('hidden', historicalEntries.length === 0);
  $('#historyList').innerHTML = historicalEntries.map(expenseHtml).join('') || '<p class="muted">Aucune opération en dehors de ce cycle.</p>';
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteExpense(button.dataset.delete)));
  document.querySelectorAll('[data-edit-expense]').forEach((button) => button.addEventListener('click', () => openExpenseDialog(state.expenses.find((expense) => expense.id === button.dataset.editExpense))));
  document.querySelectorAll('[data-delete-refund]').forEach((button) => button.addEventListener('click', () => deleteRefund(button.dataset.deleteRefund)));
}

function expenseHtml(expense) {
    if (expense.entryType === 'refund') {
      const linked = expense.expenseId ? state.expenses.find((item) => item.id === expense.expenseId)?.label : '';
      return `<article class="expense-item refund"><div class="expense-symbol" aria-hidden="true">+</div><div><div class="expense-label">${escapeHtml(expense.label)}</div><div class="expense-meta">${shortDate(expense.date)} · Remboursement${linked ? ` · ${escapeHtml(linked)}` : ''}${expense.applyToBudget ? ' · rétablit le cycle' : ' · historique seulement'}</div></div><div class="expense-amount">+ ${formatMoney(expense.amountMinor)}</div><div class="expense-actions"><button class="delete-expense" data-delete-refund="${expense.id}" type="button">Supprimer</button></div></article>`;
    }
    const fundingLabel = expense.funding === 'weekly' ? 'Budget de la semaine' : expense.funding === 'reserve' ? `Réserve · ${escapeHtml(expense.reserveName || 'sans nom')}` : expense.funding === 'annualized' ? 'Charge déjà prévue' : 'Transfert interne';
    const symbol = expense.funding === 'reserve' ? '↗' : expense.funding === 'transfer' ? '⇄' : '−';
    const tags = [expense.nature ? ({ necessary: 'Nécessaire', pleasure: 'Plaisir', postponable: 'Reportable', unexpected: 'Imprévu' }[expense.nature] || '') : '', expense.health ? 'Santé' : ''].filter(Boolean).join(' · ');
    return `<article class="expense-item ${expense.funding}"><div class="expense-symbol" aria-hidden="true">${symbol}</div><div><div class="expense-label">${escapeHtml(expense.label)}</div><div class="expense-meta">${shortDate(expense.date)} · ${fundingLabel}${tags ? ` · ${escapeHtml(tags)}` : ''}</div></div><div class="expense-amount">− ${formatMoney(expense.amountMinor)}</div><div class="expense-actions"><button class="delete-expense" data-edit-expense="${expense.id}" type="button">Modifier</button><button class="delete-expense" data-delete="${expense.id}" type="button">Supprimer</button></div></article>`;
}

function renderReserves() {
  const list = $('#reserveList');
  const activeReserves = state.reserves.filter((reserve) => !reserve.closedAt);
  if (!activeReserves.length) {
    list.innerHTML = '<p class="no-reserve">Aucune réserve pour le moment.</p>';
    return;
  }
  list.innerHTML = activeReserves.map((reserve) => {
    const budgetLabel = reserve.includedInCalculatorBudget ? 'déjà comprise dans le budget' : `− ${formatMoney(Math.ceil((reserve.annualTargetMinor || 0) / 52))} / sem.`;
    const goal = reserve.kind === 'goal';
    const progress = goal && reserve.targetMinor ? ` · ${formatMoney(reserveBalance(reserve))} / ${formatMoney(reserve.targetMinor)}` : '';
    return `<div class="reserve-item"><div><span class="reserve-name">${escapeHtml(reserve.name)}</span><span class="reserve-kind">${goal ? 'Projet temporaire' : 'Provisionnement annuel'} · ${reserve.real ? 'Compte séparé' : 'Virtuelle'} · ${formatMoney(reserve.monthlyContributionMinor || 0)} / mois · ${budgetLabel}${progress}</span></div><div><span class="reserve-balance">${formatMoney(reserveBalance(reserve))}</span><button class="delete-expense" data-edit-reserve="${reserve.id}" type="button">Modifier</button>${goal ? `<button class="delete-expense" data-close-reserve="${reserve.id}" type="button">Terminer</button>` : ''}</div></div>`;
  }).join('');
  list.querySelectorAll('[data-edit-reserve]').forEach((button) => button.addEventListener('click', () => openReserveDialog(state.reserves.find((reserve) => reserve.id === button.dataset.editReserve))));
  list.querySelectorAll('[data-close-reserve]').forEach((button) => button.addEventListener('click', () => closeReserve(button.dataset.closeReserve)));
}

function openExpenseDialog(expense = null) {
  editingExpenseId = expense?.id || null;
  $('#expenseForm').reset();
  populateReserveOptions();
  renderRecentLabels();
  $('#expenseDialogKicker').textContent = expense ? 'Correction d’une dépense' : 'Nouvelle dépense';
  $('#expenseDialogTitle').textContent = expense ? 'Modifier l’opération' : 'Ajouter au cycle';
  $('#saveExpenseButton').textContent = expense ? 'Enregistrer les modifications' : 'Enregistrer';
  $('#expenseDate').value = expense?.date || dateKey(new Date());
  if (expense) {
    $('#expenseAmount').value = (expense.amountMinor / 100).toFixed(2);
    $('#expenseLabel').value = expense.label;
    const funding = document.querySelector(`input[name="funding"][value="${expense.funding}"]`);
    if (funding) funding.checked = true;
    $('#expenseReserve').value = expense.reserveId || '';
    $('#expenseNature').value = expense.nature || '';
    $('#expenseHealth').checked = Boolean(expense.health);
  }
  toggleReserveChoice();
  $('#expenseDialog').showModal();
  $('#expenseAmount').focus();
}

function openRefundDialog() {
  $('#refundForm').reset();
  $('#refundDate').value = dateKey(new Date());
  const expenses = state.expenses.filter((expense) => !expense.deletedAt).sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`));
  $('#refundExpense').innerHTML = `<option value="">Aucune dépense précise</option>${expenses.map((expense) => `<option value="${expense.id}">${escapeHtml(expense.label)} · ${formatMoney(expense.amountMinor)} · ${shortDate(expense.date)}</option>`).join('')}`;
  $('#refundDialog').showModal();
  $('#refundAmount').focus();
}

function populateReserveOptions() {
  const select = $('#expenseReserve');
  const activeReserves = state.reserves.filter((reserve) => !reserve.closedAt);
  select.innerHTML = activeReserves.length ? activeReserves.map((reserve) => `<option value="${reserve.id}">${escapeHtml(reserve.name)} · ${formatMoney(reserveBalance(reserve))}</option>`).join('') : '<option value="">Aucune réserve disponible</option>';
}

function toggleReserveChoice() {
  $('#reserveFundingChoice').classList.toggle('hidden', !state.reserves.some((reserve) => !reserve.closedAt));
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
  if (reserve.kind === 'goal') return Math.max(0, initialBalance + monthsSince(reserve.openedOn || dateKey(new Date())) * monthlyContribution - expenses.reduce((sum, expense) => sum + expense.amountMinor, 0));
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
  const existing = editingExpenseId ? state.expenses.find((item) => item.id === editingExpenseId) : null;
  const expense = { id: existing?.id || createId(), date: String(form.get('date') || dateKey(new Date())), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), amountMinor, label: String(form.get('label')).trim(), funding, reserveId: reserve?.id || '', reserveName: reserve?.name || '', nature: String(form.get('nature') || ''), health: form.get('health') === 'on' };
  if (existing) { const before = snapshot(existing); Object.assign(existing, expense); recordEvent('updated', 'expense', existing.id, before, existing); }
  else { state.expenses.push(expense); recordEvent('created', 'expense', expense.id, null, expense); }
  await saveState();
  $('#expenseDialog').close();
  render();
}

function deleteExpense(id) {
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense) return;
  const before = snapshot(expense);
  expense.deletedAt = new Date().toISOString();
  recordEvent('deleted', 'expense', expense.id, before, expense);
  saveState();
  render();
}

async function saveRefund(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = new FormData($('#refundForm'));
  const amountMinor = eurosToMinor(form.get('amount'));
  if (!amountMinor || !String(form.get('label')).trim()) return;
  const refund = { id: createId(), date: String(form.get('date') || dateKey(new Date())), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), amountMinor, label: String(form.get('label')).trim(), expenseId: String(form.get('expense') || ''), applyToBudget: form.get('apply') === 'on' };
  state.refunds.push(refund);
  recordEvent('created', 'refund', refund.id, null, refund);
  await saveState();
  $('#refundDialog').close();
  render();
}

function deleteRefund(id) {
  const refund = state.refunds.find((item) => item.id === id);
  if (!refund) return;
  const before = snapshot(refund);
  refund.deletedAt = new Date().toISOString();
  recordEvent('deleted', 'refund', refund.id, before, refund);
  saveState();
  render();
}

function openSettings() {
  updateSettingsFields();
  $('#settingsDialog').showModal();
}

function updateSettingsFields() {
  $('#householdName').value = state.householdName;
  const budgetInput = $('#weeklyBudget');
  const budgetFromCalculator = state.budgetSource === 'calculator';
  budgetInput.value = (state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor) ? ((state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor) / 100).toFixed(2) : '';
  budgetInput.disabled = budgetFromCalculator;
  $('#weeklyBudgetHelp').textContent = budgetFromCalculator
    ? 'Ce montant vient du calculateur. Révisez vos revenus, charges et provisionnements depuis « Réviser le budget ».'
    : 'Budget provisoire : préparez votre budget dans le calculateur pour le rendre traçable et modifiable.';
  $('#rebootDay').value = state.rebootDay ?? '';
}

async function saveSettings(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  state.householdName = $('#householdName').value.trim() || 'Notre foyer';
  if (!$('#weeklyBudget').value || $('#rebootDay').value === '') return;
  if (state.budgetSource !== 'calculator') {
    state.baseWeeklyBudgetMinor = eurosToMinor($('#weeklyBudget').value);
    state.weeklyBudgetMinor = state.baseWeeklyBudgetMinor;
  }
  state.rebootDay = Number($('#rebootDay').value);
  state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined);
  await saveState();
  $('#settingsDialog').close();
  render();
}

function openReserveDialog(reserve = null) {
  editingReserveId = reserve?.id || null;
  $('#reserveForm').reset();
  $('#reserveDialogKicker').textContent = reserve ? 'Correction d’une réserve' : 'Nouvelle réserve';
  $('#reserveDialogTitle').textContent = reserve ? 'Modifier la réserve' : 'Mettre de côté';
  $('#saveReserveButton').textContent = reserve ? 'Enregistrer les modifications' : 'Créer la réserve';
  $('#reserveOpenedOn').value = reserve?.openedOn || dateKey(new Date());
  const kind = reserve?.kind || 'recurring';
  document.querySelector(`input[name="reserveKind"][value="${kind}"]`).checked = true;
  if (reserve) {
    $('#reserveName').value = reserve.name;
    $('#reserveBalance').value = ((reserve.initialBalanceMinor ?? reserve.balanceMinor ?? 0) / 100).toFixed(2);
    $('#reserveMonthly').value = ((reserve.monthlyContributionMinor || 0) / 100).toFixed(2);
    const target = kind === 'goal' ? reserve.targetMinor : reserve.annualTargetMinor;
    $('#reserveTarget').value = target ? (target / 100).toFixed(2) : '';
    $('#reserveReal').checked = Boolean(reserve.real);
  }
  updateReservePreview();
  $('#reserveDialog').showModal();
}

async function saveReserve(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const name = $('#reserveName').value.trim();
  if (!name) return;
  const kind = document.querySelector('input[name="reserveKind"]:checked')?.value || 'recurring';
  const monthlyValue = eurosToMinor($('#reserveMonthly').value);
  const targetMinor = eurosToMinor($('#reserveTarget').value);
  const annualTargetMinor = monthlyValue ? monthlyValue * 12 : (kind === 'recurring' ? targetMinor : 0);
  if (!monthlyValue && !targetMinor) return;
  const monthlyContributionMinor = monthlyValue || (kind === 'recurring' ? Math.floor(annualTargetMinor / 12) : 0);
  const existing = editingReserveId ? state.reserves.find((item) => item.id === editingReserveId) : null;
  const reserve = { id: existing?.id || createId(), name, kind, initialBalanceMinor: eurosToMinor($('#reserveBalance').value), annualTargetMinor, targetMinor: kind === 'goal' ? targetMinor : 0, monthlyContributionMinor, openedOn: $('#reserveOpenedOn').value || dateKey(new Date()), real: $('#reserveReal').checked, includedInCalculatorBudget: kind === 'recurring' && calculatorIncludesReserve(name, monthlyContributionMinor), updatedAt: new Date().toISOString() };
  if (existing) {
    const before = snapshot(existing);
    Object.assign(existing, reserve);
    state.expenses.filter((expense) => expense.funding === 'reserve' && expense.reserveId === existing.id).forEach((expense) => { expense.reserveName = name; expense.updatedAt = new Date().toISOString(); });
    recordEvent('updated', 'reserve', existing.id, before, existing);
  } else { state.reserves.push(reserve); recordEvent('created', 'reserve', reserve.id, null, reserve); }
  await saveState();
  $('#reserveDialog').close();
  render();
}

function updateReservePreview() {
  const kind = document.querySelector('input[name="reserveKind"]:checked')?.value || 'recurring';
  const monthly = eurosToMinor($('#reserveMonthly').value);
  const target = eurosToMinor($('#reserveTarget').value);
  const annual = monthly ? monthly * 12 : (kind === 'recurring' ? target : 0);
  const weekly = Math.ceil(annual / 52);
  $('#reserveTargetLabel').textContent = kind === 'goal' ? 'Objectif total du projet (facultatif si versement mensuel)' : 'Ou objectif sur un an';
  $('#reserveTargetHelp').textContent = kind === 'goal' ? 'Le solde ne recommence pas à zéro. Un objectif sans versement permet simplement de suivre une somme déjà disponible.' : 'Renseignez l’un ou l’autre. Si les deux sont remplis, le versement mensuel est prioritaire.';
  $('#reserveOpenedHelp').textContent = kind === 'goal' ? 'Le solde et les versements restent acquis jusqu’à ce que vous terminiez le projet.' : 'À chaque anniversaire, le calcul repartira du solde de cette date.';
  $('#reserveImpact').innerHTML = annual ? `Cette réserve réduira le budget disponible de<strong>${formatMoney(weekly)} par semaine</strong>` : kind === 'goal' && target ? 'Ce projet est financé avec la réserve déjà disponible : il ne réduit pas le budget chaque semaine.' : 'Indiquez un versement mensuel ou un objectif annuel pour voir l’impact sur votre budget.';
  $('#reserveBankWarning').classList.toggle('hidden', !$('#reserveReal').checked || !monthly);
  if (!$('#reserveBankWarning').classList.contains('hidden')) $('#reserveBankWarning').textContent = `Vérification importante : veuillez mettre en place un virement permanent de votre compte principal vers le compte de réserve, de ${formatMoney(monthly)} par mois.`;
}

function closeReserve(id) {
  const reserve = state.reserves.find((item) => item.id === id);
  if (!reserve || !confirm(`Terminer le projet « ${reserve.name} » ? Il restera dans la sauvegarde, mais ne réduira plus le budget.`)) return;
  const before = snapshot(reserve);
  reserve.closedAt = new Date().toISOString();
  reserve.updatedAt = reserve.closedAt;
  recordEvent('closed', 'reserve', reserve.id, before, reserve);
  saveState();
  render();
}

async function refreshCalculatorSyncStatus() {
  calculatorRefreshReason = '';
  if (state.budgetSource !== 'calculator' || !state.calculatorBudget) return;
  try {
    const calculator = await RebootSecureStorage.read(CALCULATOR_DATABASE, CALCULATOR_STORE);
    if (!calculator) return;
    const sourceUpdatedAt = calculator.updatedAt || '';
    const sentUpdatedAt = state.calculatorBudget.sourceUpdatedAt || '';
    if (sourceUpdatedAt && (!sentUpdatedAt || sourceUpdatedAt > sentUpdatedAt)) {
      calculatorRefreshReason = 'changed';
      return;
    }
    const today = dateKey(new Date());
    const sentDay = sentUpdatedAt.slice(0, 10);
    const endedSinceLastSend = (calculator.manualMonthly || []).some((entry) => entry.endsOn && entry.endsOn < today && (!sentDay || entry.endsOn >= sentDay));
    if (endedSinceLastSend) calculatorRefreshReason = 'expired';
  } catch {
    // Le suivi reste utilisable même si le dossier du calculateur est absent.
  }
}

$('#addExpenseButton').addEventListener('click', openExpenseDialog);
$('#emptyAddButton').addEventListener('click', openExpenseDialog);
$('#addRefundButton').addEventListener('click', openRefundDialog);
$('#settingsButton').addEventListener('click', openSettings);
$('#addReserveButton').addEventListener('click', () => openReserveDialog());
$('#expenseForm').addEventListener('submit', saveExpense);
$('#refundForm').addEventListener('submit', saveRefund);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#reserveForm').addEventListener('submit', saveReserve);
document.querySelectorAll('input[name="funding"]').forEach((input) => input.addEventListener('change', toggleReserveChoice));
['reserveMonthly', 'reserveTarget', 'reserveReal'].forEach((id) => $(`#${id}`).addEventListener('input', updateReservePreview));
document.querySelectorAll('input[name="reserveKind"]').forEach((input) => input.addEventListener('change', updateReservePreview));
async function beginOnboarding(storage) {
  state.onboarding = { storage, startedAt: new Date().toISOString() };
  await saveState();
  $('#welcomeDialog').close();
  window.location.assign('calculateur.html?onboarding=1');
}

$('#startLocalButton').addEventListener('click', () => beginOnboarding('local'));
$('#startDriveButton').addEventListener('click', () => beginOnboarding('drive'));

async function init() {
  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=26', { updateViaCache: 'none' }).catch(() => {});
    state = await loadState();
    state.baseWeeklyBudgetMinor ||= state.weeklyBudgetMinor || 0;
    state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== '');
    await refreshCalculatorSyncStatus();
    render();
    const syncNoticeShown = showSyncCompleteNotice();
    if (!state.configured && !state.onboarding?.storage && !syncNoticeShown) $('#welcomeDialog').showModal();
  } catch {
    storageError = 'Coffre IndexedDB verrouillé';
    render();
    $('#welcomeDialog').showModal();
  }
}

init();
