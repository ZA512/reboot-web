const DATABASE_NAME = 'reboot-local-v1';
const LEGACY_STORAGE_KEY = 'reboot-local-v1';
const CALCULATOR_DATABASE = 'reboot-calculator-v1';
const CALCULATOR_STORE = 'reboot-site-v02';
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const currency = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let saveQueue = Promise.resolve();
let state;
let calculatorState = null;
let calculatorRefreshReason = '';
let storageError = '';
let editingExpenseId = null;
let editingRefundId = null;
let editingReserveId = null;
let editingCharge = null;
let movementFilter = 'all';
let driveStatus = null;

const defaultState = () => ({ householdName: 'Notre foyer', configured: false, baseWeeklyBudgetMinor: 0, weeklyBudgetMinor: 0, rebootDay: null, expenses: [], refunds: [], reserves: [], reserveTransfers: [], importedBankOperations: [], auditEvents: [], backupStatus: {}, onboarding: null });
const createId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const snapshot = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shortDate = value => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
const formatMoney = minor => currency.format((Number(minor) || 0) / 100);
const eurosToMinor = value => { const normalized = String(value ?? '').trim().replace(',', '.'); if (!normalized || !/^\d+(\.\d{1,2})?$/.test(normalized)) return 0; const [euros, cents = ''] = normalized.split('.'); return Number(euros) * 100 + Number((cents + '00').slice(0, 2)); };

function ensureHealthReserve() {
  state.expenses ||= []; state.refunds ||= []; state.reserves ||= []; state.reserveTransfers ||= []; state.auditEvents ||= []; state.backupStatus ||= {};
  let health = state.reserves.find(reserve => reserve.kind === 'health');
  if (!health) {
    health = { id: createId(), name: 'Santé', kind: 'health', initialBalanceMinor: 0, openedOn: dateKey(new Date()), real: false, includedInCalculatorBudget: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.reserves.unshift(health);
    return true;
  }
  return false;
}

async function loadState() { const stored = await RebootSecureStorage.read(DATABASE_NAME, LEGACY_STORAGE_KEY); return { ...defaultState(), ...(stored || {}) }; }
function saveState() { state.updatedAt = new Date().toISOString(); saveQueue = saveQueue.then(() => RebootSecureStorage.save(DATABASE_NAME, state)).catch(error => { storageError = error?.message || 'Stockage indisponible'; renderFreshness(); }); return saveQueue; }
function recordEvent(type, entity, entityId, before = null, after = null) { state.auditEvents.push({ id: createId(), type, entity, entityId, at: new Date().toISOString(), before: before ? snapshot(before) : null, after: after ? snapshot(after) : null }); }

function startOfCycle(today = new Date()) { if (state.rebootDay === null || state.rebootDay === undefined || !state.configured) return null; const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()); start.setDate(start.getDate() - (start.getDay() - Number(state.rebootDay) + 7) % 7); return start; }
function reserveDeductionMinor() { return state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt && !reserve.includedInCalculatorBudget).reduce((sum, reserve) => sum + Math.ceil((reserve.annualTargetMinor || 0) / 52), 0); }
function effectiveWeeklyBudgetMinor() { return Math.max(0, (state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor || 0) - reserveDeductionMinor()); }
function cycleInfo() {
  const start = startOfCycle();
  if (!start) return { configured: false, start: null, end: null, daysLeft: null, spentMinor: 0, refundMinor: 0, budgetMinor: 0, remainingMinor: null };
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const startKey = dateKey(start), endKey = dateKey(end), today = new Date();
  const weeklyExpenses = state.expenses.filter(expense => expense.funding === 'weekly' && !expense.deletedAt && expense.date >= startKey && expense.date <= endKey);
  const weeklyTransfers = state.reserveTransfers.filter(transfer => transfer.sourceType === 'weekly' && !transfer.deletedAt && transfer.date >= startKey && transfer.date <= endKey);
  const spentMinor = weeklyExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0) + weeklyTransfers.reduce((sum, transfer) => sum + transfer.amountMinor, 0);
  const refundMinor = state.refunds.filter(refund => refund.applyToBudget && !refund.health && !refund.deletedAt && refund.date >= startKey && refund.date <= endKey).reduce((sum, refund) => sum + refund.amountMinor, 0);
  const daysLeft = Math.max(1, Math.ceil((new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000));
  const budgetMinor = effectiveWeeklyBudgetMinor();
  return { configured: true, start, end, daysLeft, spentMinor, refundMinor, budgetMinor, remainingMinor: budgetMinor - spentMinor + refundMinor };
}

function monthsSince(value, today = new Date()) { const opened = new Date(`${value}T12:00:00`); let months = (today.getFullYear() - opened.getFullYear()) * 12 + today.getMonth() - opened.getMonth(); if (today.getDate() < opened.getDate()) months -= 1; return Math.max(0, months); }
function reserveBalance(reserve) {
  const initial = reserve.initialBalanceMinor ?? reserve.balanceMinor ?? 0;
  const contribution = (reserve.monthlyContributionMinor || 0) * monthsSince(reserve.openedOn || dateKey(new Date()));
  const expenses = state.expenses.filter(expense => expense.funding === 'reserve' && expense.reserveId === reserve.id && !expense.deletedAt).reduce((sum, expense) => sum + expense.amountMinor, 0);
  const incoming = state.reserveTransfers.filter(transfer => transfer.toReserveId === reserve.id && !transfer.deletedAt).reduce((sum, transfer) => sum + transfer.amountMinor, 0);
  const outgoing = state.reserveTransfers.filter(transfer => transfer.sourceType === 'reserve' && transfer.sourceReserveId === reserve.id && !transfer.deletedAt).reduce((sum, transfer) => sum + transfer.amountMinor, 0);
  return initial + contribution + incoming - outgoing - expenses;
}
function isHealthRefund(refund) { if (refund.health) return true; const linked = refund.expenseId && state.expenses.find(expense => expense.id === refund.expenseId); return Boolean(linked?.health); }
function healthBalances() {
  const reserve = state.reserves.find(item => item.kind === 'health');
  const initial = reserve?.initialBalanceMinor || 0;
  const incoming = state.reserveTransfers.filter(transfer => transfer.toReserveId === reserve?.id && !transfer.deletedAt).reduce((sum, transfer) => sum + transfer.amountMinor, 0);
  const refunds = state.refunds.filter(refund => !refund.deletedAt && isHealthRefund(refund)).reduce((sum, refund) => sum + refund.amountMinor, 0);
  const healthExpenses = state.expenses.filter(expense => !expense.deletedAt && expense.health);
  const allExpenses = healthExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30); const cutoffKey = dateKey(cutoff);
  const settledExpenses = healthExpenses.filter(expense => expense.date < cutoffKey).reduce((sum, expense) => sum + expense.amountMinor, 0);
  return { current: initial + incoming + refunds - allExpenses, settled: initial + incoming + refunds - settledExpenses };
}

function renderFreshness() {
  const target = $('#freshness'); if (!target) return;
  if (storageError) { target.innerHTML = `<span class="status-dot" style="background:#d96b50"></span><span class="sync-label">Stockage indisponible</span>`; return; }
  const drive = window.RebootDrive?.config?.();
  const syncState = driveStatus?.state;
  $('#syncNow')?.classList.toggle('hidden', !drive?.configured && !['syncing', 'connected_idle', 'sync_error', 'sync_delayed', 'reauth_required'].includes(syncState));
  if (drive?.configured || ['syncing', 'connected_idle', 'sync_error', 'sync_delayed', 'reauth_required'].includes(syncState)) {
    const at = drive.lastSyncAt ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(drive.lastSyncAt)) : '';
    const label = syncState === 'syncing' ? 'Synchronisation…' : syncState === 'reauth_required' ? 'Drive à reconnecter' : syncState === 'sync_delayed' ? 'Sync retardée' : syncState === 'sync_error' ? 'Sync en attente' : `Drive synchronisé${at ? ` · ${at}` : ''}`;
    const color = syncState === 'reauth_required' ? '#d58a22' : ['sync_error', 'sync_delayed'].includes(syncState) ? '#7b8a86' : '#0e6f67';
    target.innerHTML = `<span class="status-dot" style="background:${color}"></span><span class="sync-label">${label}</span>`;
    return;
  }
  const backups = Object.entries(state.backupStatus || {}).filter(([, at]) => at).sort(([, a], [, b]) => new Date(b) - new Date(a));
  if (!backups.length) { target.innerHTML = '<span class="status-dot"></span><span class="sync-label">Local uniquement</span>'; return; }
  const [kind, at] = backups[0]; const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  target.innerHTML = `<span class="status-dot"></span><span class="sync-label">${kind === 'drive' ? 'Drive' : 'Sauvegardé'} · ${date}</span>`;
}

function renderWeek() {
  const cycle = cycleInfo();
  $('#householdHeader').textContent = state.householdName || 'Notre foyer';
  const onboarding = Boolean(!cycle.configured && state.onboarding?.storage); $('#onboardingPanel').classList.toggle('hidden', !onboarding);
  if (!cycle.configured) {
    $('#remaining').textContent = '—'; $('#budgetTotal').textContent = 'À définir'; $('#cycleDates').textContent = 'Non configuré'; $('#daysLeft').textContent = 'Préparez le budget'; $('#dailyGuide').textContent = '—'; $('#balanceTrack').style.width = '0%'; $('#reserveDeduction').classList.add('hidden');
  } else {
    $('#remaining').textContent = formatMoney(cycle.remainingMinor); $('#remaining').classList.toggle('negative', cycle.remainingMinor < 0); $('#budgetTotal').textContent = formatMoney(cycle.budgetMinor); $('#cycleDates').textContent = `${shortDate(dateKey(cycle.start))} → ${shortDate(dateKey(cycle.end))}`; $('#daysLeft').textContent = cycle.daysLeft === 1 ? 'jusqu’à demain' : `${cycle.daysLeft} jours restants`; $('#dailyGuide').textContent = `${formatMoney(Math.max(0, cycle.remainingMinor) / cycle.daysLeft)} / jour`; $('#balanceTrack').style.width = `${cycle.budgetMinor ? Math.min(100, Math.max(0, (cycle.spentMinor - cycle.refundMinor) / cycle.budgetMinor * 100)) : 0}%`;
    const deduction = reserveDeductionMinor(); $('#reserveDeduction').classList.toggle('hidden', !deduction); $('#reserveDeduction').textContent = deduction ? `Réserves : − ${formatMoney(deduction)} / semaine` : '';
  }
  renderSignal(cycle); renderCurrentExpenses(cycle); renderHealth(); renderFreshness();
}

function renderSignal(cycle) {
  const card = $('#signalCard'), action = $('#signalAction'); action.classList.add('hidden'); card.classList.remove('hidden');
  if (!cycle.configured) { $('#signalTitle').textContent = 'Budget à préparer'; $('#signalText').textContent = 'Définissez votre budget semaine avant de commencer.'; return; }
  if (calculatorRefreshReason) { $('#signalTitle').textContent = 'Budget à actualiser'; $('#signalText').textContent = calculatorRefreshReason === 'expired' ? 'Une charge est arrivée à sa date de fin.' : 'Le calculateur a été modifié depuis le dernier budget appliqué.'; action.classList.remove('hidden'); return; }
  if (cycle.remainingMinor < 0) { $('#signalTitle').textContent = 'Semaine dépassée'; $('#signalText').textContent = `${formatMoney(Math.abs(cycle.remainingMinor))} au-delà du budget prévu.`; return; }
  if (cycle.daysLeft <= 2) { $('#signalTitle').textContent = 'Derniers jours'; $('#signalText').textContent = `${formatMoney(cycle.remainingMinor)} jusqu’au prochain ${DAY_NAMES[state.rebootDay]}.`; return; }
  card.classList.add('hidden');
}

function entryHtml(entry) {
  if (entry.entryType === 'refund') {
    const health = isHealthRefund(entry); return `<article class="expense-item refund"><div class="expense-symbol">+</div><div><div class="expense-label">${escapeHtml(entry.label)}</div><div class="expense-meta">${shortDate(entry.date)} · ${health ? 'Remboursement Santé' : 'Remboursement'}</div></div><div class="expense-amount">+ ${formatMoney(entry.amountMinor)}</div><div class="expense-actions"><button class="delete-expense" data-edit-refund="${entry.id}">Modifier</button><button class="delete-expense" data-delete-refund="${entry.id}">Supprimer</button></div></article>`;
  }
  const fundingLabel = entry.health ? 'Réserve Santé' : entry.funding === 'weekly' ? 'Semaine' : entry.funding === 'reserve' ? `Réserve · ${escapeHtml(entry.reserveName || '')}` : entry.funding === 'annualized' ? 'Déjà prévue' : 'Transfert';
  const nature = ({ necessary: 'Nécessaire', pleasure: 'Plaisir', postponable: 'Reportable', unexpected: 'Imprévu' })[entry.nature] || '';
  return `<article class="expense-item ${entry.health ? 'health' : entry.funding}"><div class="expense-symbol">−</div><div><div class="expense-label">${escapeHtml(entry.label)}</div><div class="expense-meta">${shortDate(entry.date)} · ${fundingLabel}${nature ? ` · ${nature}` : ''}</div></div><div class="expense-amount">− ${formatMoney(entry.amountMinor)}</div><div class="expense-actions"><button class="delete-expense" data-edit-expense="${entry.id}">Modifier</button><button class="delete-expense" data-delete="${entry.id}">Supprimer</button></div></article>`;
}
function allEntries() { return [...state.expenses.filter(item => !item.deletedAt).map(item => ({ ...item, entryType: 'expense' })), ...state.refunds.filter(item => !item.deletedAt).map(item => ({ ...item, entryType: 'refund' }))].sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`)); }
function bindEntryActions(root = document) { root.querySelectorAll('[data-edit-expense]').forEach(button => button.onclick = () => openExpenseDialog(state.expenses.find(item => item.id === button.dataset.editExpense))); root.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => deleteExpense(button.dataset.delete)); root.querySelectorAll('[data-edit-refund]').forEach(button => button.onclick = () => openRefundDialog(state.refunds.find(item => item.id === button.dataset.editRefund))); root.querySelectorAll('[data-delete-refund]').forEach(button => button.onclick = () => deleteRefund(button.dataset.deleteRefund)); }
function renderCurrentExpenses(cycle) {
  const entries = !cycle.configured ? [] : allEntries().filter(entry => entry.date >= dateKey(cycle.start) && entry.date <= dateKey(cycle.end)).slice(0, 5);
  $('#expenseList').innerHTML = entries.map(entryHtml).join(''); $('#emptyState').classList.toggle('hidden', Boolean(entries.length)); bindEntryActions($('#expenseList'));
  const historical = cycle.configured ? allEntries().filter(entry => entry.date < dateKey(cycle.start) || entry.date > dateKey(cycle.end)) : []; $('#historySection').classList.toggle('hidden', !historical.length); $('#historyList').innerHTML = historical.map(entryHtml).join(''); bindEntryActions($('#historyList'));
}
function renderMovements() {
  const cycle = cycleInfo(), query = $('#movementSearch').value.trim().toLocaleLowerCase('fr-FR'); let entries = allEntries();
  if (movementFilter === 'week' && cycle.configured) entries = entries.filter(entry => entry.date >= dateKey(cycle.start) && entry.date <= dateKey(cycle.end));
  if (movementFilter === 'health') entries = entries.filter(entry => entry.health || entry.entryType === 'refund' && isHealthRefund(entry));
  if (movementFilter === 'refund') entries = entries.filter(entry => entry.entryType === 'refund');
  if (query) entries = entries.filter(entry => String(entry.label).toLocaleLowerCase('fr-FR').includes(query));
  $('#allMovementsList').innerHTML = entries.map(entryHtml).join(''); $('#movementsEmpty').classList.toggle('hidden', Boolean(entries.length)); bindEntryActions($('#allMovementsList'));
}

function renderHealth() {
  const balances = healthBalances(); $('#healthCurrentBalance').textContent = formatMoney(balances.current); $('#healthSettledBalance').textContent = formatMoney(balances.settled); $('#healthCurrentCard').classList.toggle('negative', balances.current < 0); $('#healthAlert').classList.toggle('hidden', balances.current > -5000);
  const weekCard = $('#healthWeekCard'); if (balances.current <= -5000) { weekCard.classList.remove('hidden'); $('#healthWeekText').textContent = `${formatMoney(Math.abs(balances.current))} à rééquilibrer.`; } else weekCard.classList.add('hidden');
}
function renderReserves() {
  const reserves = state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt), list = $('#reserveList');
  list.innerHTML = reserves.length ? reserves.map(reserve => `<article class="reserve-item"><div><span class="reserve-name">${escapeHtml(reserve.name)}</span><span class="reserve-kind">${reserve.kind === 'goal' ? 'Projet temporaire' : 'Réserve récurrente'} · ${formatMoney(reserve.monthlyContributionMinor || 0)} / mois</span></div><span class="reserve-balance">${formatMoney(reserveBalance(reserve))}</span><div class="row-actions"><button class="text-button" data-edit-reserve="${reserve.id}">Modifier</button>${reserve.kind === 'goal' ? `<button class="text-button danger" data-close-reserve="${reserve.id}">Terminer</button>` : ''}</div></article>`).join('') : '<div class="empty-state"><h3>Aucune autre réserve</h3><p>Utilisez une suggestion ou créez la vôtre.</p></div>';
  list.querySelectorAll('[data-edit-reserve]').forEach(button => button.onclick = () => openReserveDialog(state.reserves.find(reserve => reserve.id === button.dataset.editReserve))); list.querySelectorAll('[data-close-reserve]').forEach(button => button.onclick = () => closeReserve(button.dataset.closeReserve));
}

function manualEntryActive(entry) { return !entry.endsOn || entry.endsOn >= dateKey(new Date()); }
function calculatorTotals() {
  if (!calculatorState) return { income: 0, monthlyCharges: 0, annualCharges: 0, annualNet: 0, weekly: 0 };
  let income = 0, monthlyCharges = 0, annualCharges = 0;
  for (const group of calculatorState.groups || []) { if (group.endsOn && group.endsOn < dateKey(new Date())) continue; const amount = Number(group.acceptedAmount) || 0; if (['salary', 'income_monthly'].includes(group.category)) income += amount * 12; if (group.category === 'income_annual') income += amount; if (['charge_monthly', 'reserve_monthly'].includes(group.category)) monthlyCharges += amount * 12; if (group.category === 'charge_annual') annualCharges += amount; }
  for (const entry of calculatorState.manualMonthly || []) { if (!manualEntryActive(entry)) continue; const amount = Number(entry.amount) || 0; if (entry.type === 'income') income += amount * 12; else monthlyCharges += amount * 12; }
  const annualNet = (calculatorState.annual || []).reduce((sum, entry) => sum + Math.max(0, (Number(entry.amount) || 0) - (Number(entry.aid) || 0) - (Number(entry.covered) || 0)), 0);
  return { income, monthlyCharges, annualCharges, annualNet, weekly: (income - monthlyCharges - annualCharges - annualNet) / 52 };
}
function renderCharges() {
  const totals = calculatorTotals(); $('#recommendedWeekly').textContent = calculatorState ? `${formatMoney(Math.floor(totals.weekly * 100))} / sem.` : '—'; $('#monthlyChargesTotal').textContent = calculatorState ? formatMoney(Math.round(totals.monthlyCharges / 12 * 100)) : '—'; $('#monthlyIncomeTotal').textContent = calculatorState ? formatMoney(Math.round(totals.income / 12 * 100)) : '—';
  const entries = [];
  (calculatorState?.manualMonthly || []).forEach((entry, index) => entries.push({ source: 'manual', index, name: entry.name, type: entry.type, amount: Number(entry.amount) || 0, endsOn: entry.endsOn || '', active: manualEntryActive(entry) }));
  (calculatorState?.groups || []).forEach((entry, index) => { if (['salary', 'income_monthly', 'charge_monthly', 'reserve_monthly'].includes(entry.category)) entries.push({ source: 'group', index, name: entry.latestLabel || entry.label, type: ['salary', 'income_monthly'].includes(entry.category) ? 'income' : entry.category === 'reserve_monthly' ? 'reserve' : 'charge', amount: Number(entry.acceptedAmount) || 0, endsOn: entry.endsOn || '', active: !entry.endsOn || entry.endsOn >= dateKey(new Date()) }); });
  $('#chargeList').innerHTML = entries.map(entry => `<article class="charge-row"><div><span class="charge-name">${escapeHtml(entry.name || 'Sans libellé')}</span><span class="charge-meta">${entry.type === 'income' ? 'Revenu' : entry.type === 'reserve' ? 'Réserve' : 'Charge'}${entry.endsOn ? ` · fin ${shortDate(entry.endsOn)}` : ''}${entry.active ? '' : ' · terminée'}</span></div><span class="charge-value">${formatMoney(Math.round(entry.amount * 100))} / mois</span><div class="row-actions"><button class="text-button" data-edit-charge="${entry.source}|${entry.index}">Modifier</button><button class="text-button danger" data-remove-charge="${entry.source}|${entry.index}">Supprimer</button></div></article>`).join('');
  $('#chargesEmpty').classList.toggle('hidden', Boolean(entries.length));
  $('#applyBudgetCard').classList.toggle('hidden', !calculatorState || Math.abs((state.baseWeeklyBudgetMinor || 0) - Math.floor(totals.weekly * 100)) < 1);
  $('#chargeList').querySelectorAll('[data-edit-charge]').forEach(button => button.onclick = () => openChargeDialog(button.dataset.editCharge)); $('#chargeList').querySelectorAll('[data-remove-charge]').forEach(button => button.onclick = () => removeCharge(button.dataset.removeCharge));
}
async function saveCalculator() { if (!calculatorState) calculatorState = { mode: 'manual', step: 0, manualMonthly: [], annual: [], groups: [], updatedAt: '' }; calculatorState.updatedAt = new Date().toISOString(); await RebootSecureStorage.save(CALCULATOR_DATABASE, calculatorState); calculatorRefreshReason = 'changed'; renderCharges(); renderSignal(cycleInfo()); }

function render() { renderWeek(); renderMovements(); renderReserves(); renderCharges(); updateSettingsFields(); }
function showView() { const requested = location.hash.replace('#', '') || 'week', view = ['week', 'movements', 'charges', 'reserves'].includes(requested) ? requested : 'week'; $$('[data-view-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.viewPanel !== view)); $$('[data-view]').forEach(link => link.setAttribute('aria-current', link.dataset.view === view ? 'page' : 'false')); document.title = `REBOOT — ${{ week: 'Semaine', movements: 'Mouvements', charges: 'Charges', reserves: 'Réserves' }[view]}`; if (view === 'charges') renderCharges(); if (view === 'movements') renderMovements(); window.scrollTo({ top: 0, behavior: 'instant' }); }

function openExpenseDialog(expense = null, health = false) { editingExpenseId = expense?.id || null; $('#expenseForm').reset(); populateReserveOptions(); renderRecentLabels(); const isHealth = Boolean(expense?.health || health); $('#expenseHealth').checked = isHealth; $('#fundingField').classList.toggle('hidden', isHealth); $('#expenseDialogKicker').textContent = expense ? 'Correction' : isHealth ? 'Réserve Santé' : 'Nouvelle dépense'; $('#expenseDialogTitle').textContent = expense ? 'Modifier le montant' : isHealth ? 'Ajouter une dépense Santé' : 'Ajouter un montant'; $('#saveExpenseButton').textContent = expense ? 'Enregistrer les modifications' : 'Enregistrer'; $('#expenseDate').value = expense?.date || dateKey(new Date()); if (expense) { $('#expenseAmount').value = (expense.amountMinor / 100).toFixed(2); $('#expenseLabel').value = expense.label; const funding = document.querySelector(`input[name="funding"][value="${expense.funding}"]`); if (funding) funding.checked = true; $('#expenseReserve').value = expense.reserveId || ''; const nature = document.querySelector(`input[name="nature"][value="${expense.nature || ''}"]`); if (nature) nature.checked = true; } toggleReserveChoice(); $('#expenseDialog').showModal(); $('#expenseAmount').focus(); }
function populateReserveOptions() { const reserves = state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt); $('#expenseReserve').innerHTML = reserves.map(reserve => `<option value="${reserve.id}">${escapeHtml(reserve.name)} · ${formatMoney(reserveBalance(reserve))}</option>`).join('') || '<option value="">Aucune réserve</option>'; $('#reserveFundingChoice').classList.toggle('hidden', !reserves.length); }
function toggleReserveChoice() { const health = $('#expenseHealth').checked; $('#fundingField').classList.toggle('hidden', health); $('#reserveChoice').classList.toggle('hidden', health || document.querySelector('input[name="funding"]:checked')?.value !== 'reserve'); }
function renderRecentLabels() { const labels = [...new Set(state.expenses.filter(item => !item.deletedAt).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(item => item.label).filter(Boolean))].slice(0, 4); $('#recentLabels').innerHTML = labels.map(label => `<button class="recent-label" type="button" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join(''); $('#recentLabels').querySelectorAll('[data-label]').forEach(button => button.onclick = () => { $('#expenseLabel').value = button.dataset.label; }); }
async function saveExpense(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = new FormData($('#expenseForm')), amountMinor = eurosToMinor(form.get('amount')), label = String(form.get('label') || '').trim(); if (!amountMinor || !label) return; const health = form.get('health') === 'on', funding = health ? 'health' : String(form.get('funding') || 'weekly'), reserve = state.reserves.find(item => item.id === form.get('reserve')); if (funding === 'reserve' && !reserve) return; const existing = editingExpenseId ? state.expenses.find(item => item.id === editingExpenseId) : null; const expense = { id: existing?.id || createId(), date: String(form.get('date') || dateKey(new Date())), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), amountMinor, label, funding, reserveId: reserve?.id || '', reserveName: reserve?.name || '', nature: String(form.get('nature') || ''), health }; if (existing) { const before = snapshot(existing); Object.assign(existing, expense); recordEvent('updated', 'expense', existing.id, before, existing); } else { state.expenses.push(expense); recordEvent('created', 'expense', expense.id, null, expense); } await saveState(); $('#expenseDialog').close(); render(); }
function deleteExpense(id) { const expense = state.expenses.find(item => item.id === id); if (!expense) return; const before = snapshot(expense); expense.deletedAt = new Date().toISOString(); recordEvent('deleted', 'expense', id, before, expense); saveState(); render(); }

function openRefundDialog(refund = null, health = false) { editingRefundId = refund?.id || null; $('#refundForm').reset(); $('#refundDate').value = refund?.date || dateKey(new Date()); const expenses = state.expenses.filter(item => !item.deletedAt); $('#refundExpense').innerHTML = `<option value="">Aucune dépense précise</option>${expenses.map(expense => `<option value="${expense.id}">${escapeHtml(expense.label)} · ${formatMoney(expense.amountMinor)}</option>`).join('')}`; const isHealth = Boolean(refund ? isHealthRefund(refund) : health); $('#refundHealth').checked = isHealth; $('#refundApply').checked = refund ? Boolean(refund.applyToBudget) : !isHealth; $('#refundApplyField').classList.toggle('hidden', isHealth); if (refund) { $('#refundAmount').value = (refund.amountMinor / 100).toFixed(2); $('#refundLabel').value = refund.label; $('#refundExpense').value = refund.expenseId || ''; } $('#refundDialog').showModal(); $('#refundAmount').focus(); }
async function saveRefund(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = new FormData($('#refundForm')), amountMinor = eurosToMinor(form.get('amount')), label = String(form.get('label') || '').trim(); if (!amountMinor || !label) return; const expenseId = String(form.get('expense') || ''), linked = state.expenses.find(item => item.id === expenseId), health = form.get('health') === 'on' || Boolean(linked?.health), existing = editingRefundId ? state.refunds.find(item => item.id === editingRefundId) : null; const refund = { id: existing?.id || createId(), date: String(form.get('date') || dateKey(new Date())), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), amountMinor, label, expenseId, health, applyToBudget: health ? false : form.get('apply') === 'on' }; if (existing) { const before = snapshot(existing); Object.assign(existing, refund); recordEvent('updated', 'refund', existing.id, before, existing); } else { state.refunds.push(refund); recordEvent('created', 'refund', refund.id, null, refund); } await saveState(); $('#refundDialog').close(); render(); }
function deleteRefund(id) { const refund = state.refunds.find(item => item.id === id); if (!refund) return; const before = snapshot(refund); refund.deletedAt = new Date().toISOString(); recordEvent('deleted', 'refund', id, before, refund); saveState(); render(); }

function openReserveDialog(reserve = null, suggestion = '') { editingReserveId = reserve?.id || null; $('#reserveForm').reset(); $('#reserveDialogKicker').textContent = reserve ? 'Correction' : 'Nouvelle réserve'; $('#reserveDialogTitle').textContent = reserve ? 'Modifier la réserve' : 'Créer une réserve'; $('#saveReserveButton').textContent = reserve ? 'Enregistrer' : 'Créer'; $('#reserveOpenedOn').value = reserve?.openedOn || dateKey(new Date()); $('#reserveName').value = reserve?.name || suggestion; const kind = reserve?.kind || (suggestion === 'Nouveau projet' ? 'goal' : 'recurring'); document.querySelector(`input[name="reserveKind"][value="${kind}"]`).checked = true; if (reserve) { $('#reserveBalance').value = ((reserve.initialBalanceMinor || 0) / 100).toFixed(2); $('#reserveMonthly').value = ((reserve.monthlyContributionMinor || 0) / 100).toFixed(2); $('#reserveTarget').value = ((kind === 'goal' ? reserve.targetMinor : reserve.annualTargetMinor) || 0) / 100 || ''; $('#reserveReal').checked = Boolean(reserve.real); } updateReservePreview(); $('#reserveDialog').showModal(); }
async function saveReserve(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const name = $('#reserveName').value.trim(), kind = document.querySelector('input[name="reserveKind"]:checked')?.value || 'recurring', initialBalanceMinor = eurosToMinor($('#reserveBalance').value), monthlyContributionMinor = eurosToMinor($('#reserveMonthly').value), targetMinor = eurosToMinor($('#reserveTarget').value); if (!name || (!initialBalanceMinor && !monthlyContributionMinor && !targetMinor)) return; const annualTargetMinor = monthlyContributionMinor ? monthlyContributionMinor * 12 : kind === 'recurring' ? targetMinor : 0, existing = editingReserveId ? state.reserves.find(item => item.id === editingReserveId) : null; const reserve = { id: existing?.id || createId(), name, kind, initialBalanceMinor, monthlyContributionMinor: monthlyContributionMinor || (kind === 'recurring' && annualTargetMinor ? Math.floor(annualTargetMinor / 12) : 0), annualTargetMinor, targetMinor: kind === 'goal' ? targetMinor : 0, openedOn: $('#reserveOpenedOn').value || dateKey(new Date()), real: $('#reserveReal').checked, includedInCalculatorBudget: false, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }; if (existing) { const before = snapshot(existing); Object.assign(existing, reserve); recordEvent('updated', 'reserve', existing.id, before, existing); } else { state.reserves.push(reserve); recordEvent('created', 'reserve', reserve.id, null, reserve); } await saveState(); $('#reserveDialog').close(); render(); }
function updateReservePreview() { const kind = document.querySelector('input[name="reserveKind"]:checked')?.value || 'recurring', monthly = eurosToMinor($('#reserveMonthly').value), target = eurosToMinor($('#reserveTarget').value), annual = monthly ? monthly * 12 : kind === 'recurring' ? target : 0; $('#reserveTargetLabel').textContent = kind === 'goal' ? 'Objectif total du projet' : 'Ou objectif sur un an'; $('#reserveTargetHelp').textContent = kind === 'goal' ? 'Le projet reste ouvert jusqu’à ce que vous le terminiez.' : 'Le versement mensuel est prioritaire si les deux champs sont remplis.'; $('#reserveOpenedHelp').textContent = 'Cette date sert de point de départ au solde.'; $('#reserveImpact').innerHTML = annual ? `Impact estimé<strong>− ${formatMoney(Math.ceil(annual / 52))} par semaine</strong>` : 'Renseignez un solde, un versement ou un objectif.'; $('#reserveBankWarning').classList.toggle('hidden', !$('#reserveReal').checked || !monthly); $('#reserveBankWarning').textContent = monthly ? `Prévoir un virement de ${formatMoney(monthly)} par mois vers ce compte.` : ''; }
function closeReserve(id) { const reserve = state.reserves.find(item => item.id === id); if (!reserve || !confirm(`Terminer « ${reserve.name} » ?`)) return; const before = snapshot(reserve); reserve.closedAt = new Date().toISOString(); recordEvent('closed', 'reserve', id, before, reserve); saveState(); render(); }

function openRebalanceDialog() { const health = healthBalances(); $('#rebalanceAmount').value = health.current < 0 ? (Math.abs(health.current) / 100).toFixed(2) : ''; const reserves = state.reserves.filter(item => item.kind !== 'health' && !item.closedAt && reserveBalance(item) > 0); $('#rebalanceSource').innerHTML = '<option value="weekly">Budget de la semaine</option>' + reserves.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${formatMoney(reserveBalance(item))}</option>`).join(''); $('#rebalanceDialog').showModal(); }
async function saveRebalance(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const amountMinor = eurosToMinor($('#rebalanceAmount').value), source = $('#rebalanceSource').value, health = state.reserves.find(item => item.kind === 'health'); if (!amountMinor || !health) return; if (source !== 'weekly') { const reserve = state.reserves.find(item => item.id === source); if (!reserve || reserveBalance(reserve) < amountMinor) return; } const transfer = { id: createId(), date: dateKey(new Date()), createdAt: new Date().toISOString(), amountMinor, sourceType: source === 'weekly' ? 'weekly' : 'reserve', sourceReserveId: source === 'weekly' ? '' : source, toReserveId: health.id }; state.reserveTransfers.push(transfer); recordEvent('created', 'transfer', transfer.id, null, transfer); await saveState(); $('#rebalanceDialog').close(); render(); }

function openChargeDialog(reference = '') { editingCharge = reference || null; $('#chargeForm').reset(); $('#chargeDialogKicker').textContent = reference ? 'Modification' : 'Nouvelle charge'; $('#chargeDialogTitle').textContent = reference ? 'Modifier la ligne' : 'Ajouter une charge'; if (reference) { const [source, rawIndex] = reference.split('|'), index = Number(rawIndex), entry = source === 'manual' ? calculatorState.manualMonthly[index] : calculatorState.groups[index]; $('#chargeName').value = source === 'manual' ? entry.name : entry.latestLabel || entry.label; $('#chargeType').value = source === 'manual' ? entry.type : ['salary', 'income_monthly'].includes(entry.category) ? 'income' : entry.category === 'reserve_monthly' ? 'reserve' : 'charge'; $('#chargeAmount').value = source === 'manual' ? entry.amount : entry.acceptedAmount; $('#chargeEndsOn').value = entry.endsOn || ''; } $('#chargeDialog').showModal(); }
async function saveCharge(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const name = $('#chargeName').value.trim(), type = $('#chargeType').value, amount = Number($('#chargeAmount').value), endsOn = $('#chargeEndsOn').value; if (!name || !amount) return; if (!calculatorState) calculatorState = { mode: 'manual', step: 0, manualMonthly: [], annual: [], groups: [] }; if (editingCharge) { const [source, rawIndex] = editingCharge.split('|'), entry = source === 'manual' ? calculatorState.manualMonthly[Number(rawIndex)] : calculatorState.groups[Number(rawIndex)]; if (source === 'manual') Object.assign(entry, { name, type, amount, endsOn }); else Object.assign(entry, { latestLabel: name, acceptedAmount: amount, endsOn, category: type === 'income' ? 'income_monthly' : type === 'reserve' ? 'reserve_monthly' : 'charge_monthly' }); } else calculatorState.manualMonthly.push({ name, type, amount, endsOn, nature: 'fixed', frequency: 'monthly', templateKey: '', note: 'Ajouté depuis l’APP.', search: '', searchSelected: {} }); await saveCalculator(); $('#chargeDialog').close(); render(); }
async function removeCharge(reference) { if (!confirm('Supprimer cette ligne du budget conseillé ?')) return; const [source, rawIndex] = reference.split('|'), index = Number(rawIndex); if (source === 'manual') calculatorState.manualMonthly.splice(index, 1); else calculatorState.groups[index].category = 'ignore'; await saveCalculator(); render(); }
async function applyRecommendedBudget() { const totals = calculatorTotals(), weeklyBudgetMinor = Math.floor(totals.weekly * 100); if (weeklyBudgetMinor <= 0) return; state.baseWeeklyBudgetMinor = weeklyBudgetMinor; state.weeklyBudgetMinor = weeklyBudgetMinor; state.configured = state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== ''; state.budgetSource = 'calculator'; state.calculatorBudget = { version: 1, updatedAt: new Date().toISOString(), sourceUpdatedAt: calculatorState.updatedAt, weeklyBudgetMinor, incomeAnnualMinor: Math.round(totals.income * 100), monthlyChargesAnnualMinor: Math.round(totals.monthlyCharges * 100), annualChargesMinor: Math.round((totals.annualCharges + totals.annualNet) * 100), permanentReserveLines: (calculatorState.manualMonthly || []).filter(item => item.type === 'reserve' && manualEntryActive(item)).map(item => ({ name: item.name, monthlyContributionMinor: Math.round(Number(item.amount) * 100) })) }; calculatorRefreshReason = ''; await saveState(); render(); location.hash = '#week'; }

function updateSettingsFields() { $('#householdName').value = state.householdName || 'Notre foyer'; $('#weeklyBudget').value = state.baseWeeklyBudgetMinor ? (state.baseWeeklyBudgetMinor / 100).toFixed(2) : ''; $('#weeklyBudget').disabled = state.budgetSource === 'calculator'; $('#weeklyBudgetHelp').textContent = state.budgetSource === 'calculator' ? 'Ce montant est géré depuis l’écran Charges.' : 'Budget provisoire modifiable ici.'; $('#rebootDay').value = state.rebootDay ?? ''; }
function openSettings() { updateSettingsFields(); $('#settingsDialog').showModal(); }
async function saveSettings(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); state.householdName = $('#householdName').value.trim() || 'Notre foyer'; if (state.budgetSource !== 'calculator') { const budget = eurosToMinor($('#weeklyBudget').value); if (budget) state.baseWeeklyBudgetMinor = state.weeklyBudgetMinor = budget; } if ($('#rebootDay').value !== '') state.rebootDay = Number($('#rebootDay').value); state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined); await saveState(); $('#settingsDialog').close(); render(); }
async function refreshCalculatorStatus() { calculatorRefreshReason = ''; try { calculatorState = await RebootSecureStorage.read(CALCULATOR_DATABASE, CALCULATOR_STORE); if (!calculatorState || state.budgetSource !== 'calculator' || !state.calculatorBudget) return; if (calculatorState.updatedAt && calculatorState.updatedAt > (state.calculatorBudget.sourceUpdatedAt || '')) calculatorRefreshReason = 'changed'; const today = dateKey(new Date()); if ((calculatorState.manualMonthly || []).some(item => item.endsOn && item.endsOn < today && item.endsOn >= String(state.calculatorBudget.sourceUpdatedAt || '').slice(0, 10))) calculatorRefreshReason = 'expired'; } catch { calculatorState = null; } }
function showSyncCompleteNotice() { let notice; try { notice = JSON.parse(sessionStorage.getItem('reboot-sync-complete') || 'null'); sessionStorage.removeItem('reboot-sync-complete'); } catch { return false; } if (!notice) return false; $('#syncCompleteMessage').textContent = notice.restored ? 'Votre budget Google a été récupéré sur cet appareil.' : notice.merged ? 'Les changements trouvés sur vos autres appareils ont été réunis.' : 'Votre copie Google est à jour.'; $('#syncCompleteDialog').showModal(); return true; }
async function beginOnboarding(storage) { state.onboarding = { storage, startedAt: new Date().toISOString() }; await saveState(); $('#welcomeDialog').close(); location.assign('calculateur.html?onboarding=1'); }

$('#addExpenseButton').onclick = () => openExpenseDialog(); $('#emptyAddButton').onclick = () => openExpenseDialog(); $('#movementAddButton').onclick = () => openExpenseDialog(); $('#addHealthExpenseButton').onclick = () => openExpenseDialog(null, true); $('#addRefundButton').onclick = () => openRefundDialog(); $('#addHealthRefundButton').onclick = () => openRefundDialog(null, true); $('#settingsButton').onclick = openSettings; $('#addReserveButton').onclick = () => openReserveDialog(); $('#addChargeButton').onclick = () => openChargeDialog(); $('#rebalanceHealthButton').onclick = openRebalanceDialog; $('#applyRecommendedBudget').onclick = applyRecommendedBudget;
$('#expenseForm').onsubmit = saveExpense; $('#refundForm').onsubmit = saveRefund; $('#reserveForm').onsubmit = saveReserve; $('#chargeForm').onsubmit = saveCharge; $('#rebalanceForm').onsubmit = saveRebalance; $('#settingsForm').onsubmit = saveSettings;
$$('input[name="funding"]').forEach(input => input.onchange = toggleReserveChoice); $('#expenseHealth').onchange = toggleReserveChoice; $('#refundHealth').onchange = () => { const health = $('#refundHealth').checked; $('#refundApplyField').classList.toggle('hidden', health); if (health) $('#refundApply').checked = false; }; $('#refundExpense').onchange = () => { const expense = state.expenses.find(item => item.id === $('#refundExpense').value); if (expense?.health) { $('#refundHealth').checked = true; $('#refundHealth').dispatchEvent(new Event('change')); } };
['reserveMonthly', 'reserveTarget', 'reserveReal'].forEach(id => $(`#${id}`).oninput = updateReservePreview); $$('input[name="reserveKind"]').forEach(input => input.onchange = updateReservePreview);
$('#movementSearch').oninput = renderMovements; $$('[data-movement-filter]').forEach(button => button.onclick = () => { movementFilter = button.dataset.movementFilter; $$('[data-movement-filter]').forEach(item => item.setAttribute('aria-pressed', item === button ? 'true' : 'false')); renderMovements(); });
$$('[data-reserve-suggestion]').forEach(button => button.onclick = () => openReserveDialog(null, button.dataset.reserveSuggestion));
$('#startLocalButton').onclick = () => beginOnboarding('local'); $('#startDriveButton').onclick = () => beginOnboarding('drive'); window.addEventListener('hashchange', showView);
window.addEventListener('reboot:drive-status', (event) => { driveStatus = event.detail; renderFreshness(); });
window.addEventListener('reboot:drive-merged', async () => { state = await loadState(); state.baseWeeklyBudgetMinor ||= state.weeklyBudgetMinor || 0; ensureHealthReserve(); await refreshCalculatorStatus(); render(); });
$('#syncNow').onclick = () => driveStatus?.state === 'reauth_required' ? window.RebootDrive?.connect('/app.html') : window.RebootDrive?.syncNow();

(async function init() {
  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=42', { updateViaCache: 'none' }).catch(() => {});
    state = await loadState(); state.baseWeeklyBudgetMinor ||= state.weeklyBudgetMinor || 0; state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== ''); const migrated = ensureHealthReserve(); if (migrated) await saveState(); await refreshCalculatorStatus(); render(); showView(); const syncShown = showSyncCompleteNotice(); if (!state.configured && !state.onboarding?.storage && !syncShown) $('#welcomeDialog').showModal();
  } catch (error) { state = defaultState(); ensureHealthReserve(); storageError = error?.message || 'Coffre local indisponible'; render(); showView(); $('#welcomeDialog').showModal(); }
})();
