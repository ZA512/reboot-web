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
let trackingWeeks = 52;
let driveStatus = null;

const defaultState = () => ({ householdName: 'Notre foyer', configured: false, baseWeeklyBudgetMinor: 0, weeklyBudgetMinor: 0, rebootDay: null, expenses: [], refunds: [], reserves: [], reserveTransfers: [], importedBankOperations: [], bankReconciliations: [], bankChargeProfiles: [], shortcuts: [], weeklyCycles: [], allocations: [], auditEvents: [], backupStatus: {}, onboarding: null });
const createId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const snapshot = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shortDate = value => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
const formatMoney = minor => currency.format((Number(minor) || 0) / 100);
const eurosToMinor = value => { const normalized = String(value ?? '').trim().replace(',', '.'); if (!normalized || !/^\d+(\.\d{1,2})?$/.test(normalized)) return 0; const [euros, cents = ''] = normalized.split('.'); return Number(euros) * 100 + Number((cents + '00').slice(0, 2)); };

function ensureHealthReserve() {
  state.expenses ||= []; state.refunds ||= []; state.reserves ||= []; state.reserveTransfers ||= []; state.importedBankOperations ||= []; state.bankReconciliations ||= []; state.bankChargeProfiles ||= []; state.shortcuts ||= []; state.weeklyCycles ||= []; state.allocations ||= []; state.auditEvents ||= []; state.backupStatus ||= {};
  let health = state.reserves.find(reserve => reserve.kind === 'health');
  if (!health) {
    health = { id: createId(), name: 'Santé', kind: 'health', initialBalanceMinor: 0, openedOn: dateKey(new Date()), real: false, includedInCalculatorBudget: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.reserves.unshift(health);
    return true;
  }
  return false;
}

async function loadState() { const stored = await RebootSecureStorage.read(DATABASE_NAME, LEGACY_STORAGE_KEY); return { ...defaultState(), ...(stored || {}) }; }
function saveState() { synchronizeWeeklyModel(); state.updatedAt = new Date().toISOString(); saveQueue = saveQueue.then(() => RebootSecureStorage.save(DATABASE_NAME, state)).catch(error => { storageError = error?.message || 'Stockage indisponible'; renderFreshness(); }); return saveQueue; }
function recordEvent(type, entity, entityId, before = null, after = null) { state.auditEvents.push({ id: createId(), type, entity, entityId, at: new Date().toISOString(), before: before ? snapshot(before) : null, after: after ? snapshot(after) : null }); }

function createWeeklyCycle(startDate, budgetMinor = null, status = 'planned') {
  const now = new Date().toISOString();
  return { id: RebootBudgetEngine.cycleIdForStart(startDate), startDate, endDate: RebootBudgetEngine.addDays(startDate, 6), budgetMinor, status, isExceptional: false, createdAt: now, updatedAt: now, ...(status === 'closed' ? { closedAt: now } : status === 'open' ? { openedAt: now } : {}) };
}
function allocationCycleStart(date) { return RebootBudgetEngine.cycleStartForDate(date, state.rebootDay); }
function ensureCycle(startDate, budgetMinor = null, status = 'planned') {
  let cycle = state.weeklyCycles.find(item => item.id === RebootBudgetEngine.cycleIdForStart(startDate) && !item.deletedAt);
  if (!cycle) { cycle = createWeeklyCycle(startDate, budgetMinor, status); state.weeklyCycles.push(cycle); }
  else if ((cycle.budgetMinor === null || cycle.budgetMinor === undefined || !Number.isFinite(Number(cycle.budgetMinor))) && budgetMinor !== null && budgetMinor !== undefined && Number.isFinite(Number(budgetMinor))) { cycle.budgetMinor = Number(budgetMinor); cycle.updatedAt = new Date().toISOString(); }
  return cycle;
}
function cycleStatusForStart(startDate, currentStart) { return startDate < currentStart ? 'closed' : startDate === currentStart ? 'open' : 'planned'; }
function cycleBudgetForStart(startDate, currentStart, currentBudget) {
  if (startDate >= currentStart) return currentBudget;
  const known = state.weeklyCycles.filter(item => !item.deletedAt && item.budgetMinor !== null && item.budgetMinor !== undefined && Number.isFinite(Number(item.budgetMinor))).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const previous = known.filter(item => item.startDate <= startDate).at(-1);
  const next = known.find(item => item.startDate > startDate);
  return Number(previous?.budgetMinor ?? next?.budgetMinor ?? currentBudget);
}
function synchronizeWeeklyModel() {
  state.weeklyCycles ||= []; state.allocations ||= [];
  if (!state.configured || state.rebootDay === null || state.rebootDay === undefined) return;
  const now = new Date().toISOString(), currentStart = allocationCycleStart(dateKey(new Date())), currentBudget = effectiveWeeklyBudgetMinor();
  for (const cycle of state.weeklyCycles.filter(item => !item.deletedAt)) {
    if (cycle.startDate < currentStart && cycle.status !== 'closed') { cycle.status = 'closed'; cycle.closedAt = now; cycle.updatedAt = now; }
    if (cycle.startDate > currentStart && cycle.status !== 'planned') { cycle.status = 'planned'; cycle.updatedAt = now; }
  }
  const current = ensureCycle(currentStart, currentBudget, 'open');
  if (current.status !== 'open' || current.budgetMinor !== currentBudget) Object.assign(current, { status: 'open', budgetMinor: currentBudget, openedAt: current.openedAt || now, updatedAt: now });
  const historicalAnchor = state.weeklyCycles.filter(item => !item.deletedAt && item.startDate < currentStart && item.budgetMinor !== null && item.budgetMinor !== undefined && Number.isFinite(Number(item.budgetMinor))).sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  if (historicalAnchor) { for (let start = RebootBudgetEngine.addDays(historicalAnchor.startDate, 7); start < currentStart; start = RebootBudgetEngine.addDays(start, 7)) { const cycle = ensureCycle(start, historicalAnchor.budgetMinor, 'closed'); if (!cycle.closedAt) Object.assign(cycle, { status: 'closed', closedAt: now, updatedAt: now }); } }
  for (const expense of state.expenses.filter(item => item.funding === 'weekly' && !item.deletedAt)) {
    const allocations = state.allocations.filter(item => item.transactionId === expense.id && !item.deletedAt);
    const cycleStart = allocationCycleStart(expense.date), status = cycleStatusForStart(cycleStart, currentStart), budget = cycleBudgetForStart(cycleStart, currentStart, currentBudget), cycle = ensureCycle(cycleStart, budget, status);
    if (allocations.length === 1 && Number(allocations[0].sequenceCount || 1) === 1 && (allocations[0].cycleStart !== cycleStart || Number(allocations[0].amountMinor) !== Number(expense.amountMinor))) Object.assign(allocations[0], { cycleId: cycle.id, cycleStart, amountMinor: expense.amountMinor, updatedAt: now });
    if (allocations.length) continue;
    state.allocations.push({ id: createId(), transactionId: expense.id, cycleId: cycle.id, cycleStart, amountMinor: expense.amountMinor, sequence: 1, sequenceCount: 1, createdAt: expense.createdAt || now, updatedAt: now });
  }
  const datedBudgetEntries = [
    ...state.refunds.filter(item => item.applyToBudget && !item.health && !item.deletedAt),
    ...state.reserveTransfers.filter(item => item.sourceType === 'weekly' && !item.deletedAt)
  ];
  for (const entry of datedBudgetEntries) { const cycleStart = allocationCycleStart(entry.date); ensureCycle(cycleStart, cycleBudgetForStart(cycleStart, currentStart, currentBudget), cycleStatusForStart(cycleStart, currentStart)); }
  for (const allocation of state.allocations.filter(item => !item.deletedAt)) {
    const status = cycleStatusForStart(allocation.cycleStart, currentStart);
    ensureCycle(allocation.cycleStart, cycleBudgetForStart(allocation.cycleStart, currentStart, currentBudget), status);
  }
}
function activeAllocations(transactionId = '') { return state.allocations.filter(item => !item.deletedAt && (!transactionId || item.transactionId === transactionId)); }
function createAllocations(expense, weeks = 1, startMode = 'current') {
  const currentStart = allocationCycleStart(dateKey(new Date())), currentBudget = effectiveWeeklyBudgetMinor();
  const firstStart = Number(weeks) > 1 ? startMode === 'next' ? RebootBudgetEngine.addDays(currentStart, 7) : currentStart : allocationCycleStart(expense.date);
  const amounts = RebootBudgetEngine.splitAmountMinor(expense.amountMinor, weeks), now = new Date().toISOString();
  return amounts.map((amountMinor, index) => { const cycleStart = RebootBudgetEngine.addDays(firstStart, index * 7), cycle = ensureCycle(cycleStart, cycleBudgetForStart(cycleStart, currentStart, currentBudget), cycleStatusForStart(cycleStart, currentStart)); return { id: createId(), transactionId: expense.id, cycleId: cycle.id, cycleStart, amountMinor, sequence: index + 1, sequenceCount: weeks, createdAt: now, updatedAt: now }; });
}

function startOfCycle(today = new Date()) { if (state.rebootDay === null || state.rebootDay === undefined || !state.configured) return null; const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()); start.setDate(start.getDate() - (start.getDay() - Number(state.rebootDay) + 7) % 7); return start; }
function reserveDeductionMinor() { return state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt && !reserve.includedInCalculatorBudget).reduce((sum, reserve) => sum + Math.ceil((reserve.annualTargetMinor || 0) / 52), 0); }
function effectiveWeeklyBudgetMinor() { return Math.max(0, (state.baseWeeklyBudgetMinor || state.weeklyBudgetMinor || 0) - reserveDeductionMinor()); }
function cycleInfo() {
  const start = startOfCycle();
  if (!start) return { configured: false, start: null, end: null, daysLeft: null, spentMinor: 0, refundMinor: 0, budgetMinor: 0, remainingMinor: null };
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const startKey = dateKey(start), endKey = dateKey(end), today = new Date();
  const currentCycle = state.weeklyCycles.find(item => item.startDate === startKey && !item.deletedAt);
  const weeklyAllocations = activeAllocations().filter(allocation => allocation.cycleStart === startKey && !state.expenses.find(expense => expense.id === allocation.transactionId)?.deletedAt);
  const weeklyTransfers = state.reserveTransfers.filter(transfer => transfer.sourceType === 'weekly' && !transfer.deletedAt && transfer.date >= startKey && transfer.date <= endKey);
  const spentMinor = weeklyAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0) + weeklyTransfers.reduce((sum, transfer) => sum + transfer.amountMinor, 0);
  const refundMinor = state.refunds.filter(refund => refund.applyToBudget && !refund.health && !refund.deletedAt && refund.date >= startKey && refund.date <= endKey).reduce((sum, refund) => sum + refund.amountMinor, 0);
  const daysLeft = Math.max(1, Math.ceil((new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000));
  const budgetMinor = currentCycle?.budgetMinor ?? effectiveWeeklyBudgetMinor();
  return { configured: true, entity: currentCycle, start, end, daysLeft, spentMinor, refundMinor, budgetMinor, remainingMinor: budgetMinor - spentMinor + refundMinor };
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
    const label = syncState === 'syncing' ? 'Synchronisation…' : syncState === 'reauth_required' ? 'Drive à reconnecter' : syncState === 'sync_delayed' ? 'Sync retardée' : syncState === 'sync_error' ? 'Sync en attente' : drive.syncPendingSetup ? 'Drive prêt à configurer' : `Drive synchronisé${at ? ` · ${at}` : ''}`;
    const color = syncState === 'reauth_required' ? '#d58a22' : ['sync_error', 'sync_delayed'].includes(syncState) ? '#7b8a86' : '#0e6f67';
    target.innerHTML = `<span class="status-dot" style="background:${color}"></span><span class="sync-label">${label}</span>`;
    return;
  }
  const backups = Object.entries(state?.backupStatus || {}).filter(([, at]) => at).sort(([, a], [, b]) => new Date(b) - new Date(a));
  if (!backups.length) { target.innerHTML = '<span class="status-dot"></span><span class="sync-label">Local uniquement</span>'; return; }
  const [kind, at] = backups[0]; const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  target.innerHTML = `<span class="status-dot"></span><span class="sync-label">${kind === 'drive' ? 'Drive' : 'Sauvegardé'} · ${date}</span>`;
}

function renderWeekMascot(cycle) {
  const mascot = $('#weekMascot');
  if (!mascot) return;
  let mood = { file: 'happy-face.png', alt: 'Petit cochon souriant, prêt à commencer' };
  if (cycle.configured) {
    const ratio = cycle.budgetMinor > 0 ? cycle.remainingMinor / cycle.budgetMinor : 0;
    if (ratio >= .55) mood = { file: 'zen.png', alt: 'Petit cochon zen : la semaine est confortable' };
    else if (ratio >= .2) mood = { file: 'smily.png', alt: 'Petit cochon souriant : le budget tient bon' };
    else if (ratio >= 0) mood = { file: 'thinking.png', alt: 'Petit cochon pensif : le budget devient serré' };
    else if (ratio > -.25) mood = { file: 'very%20sad.png', alt: 'Petit cochon très triste : le budget est dépassé' };
    else mood = { file: 'dead.png', alt: 'Petit cochon assommé : le budget est largement dépassé' };
  }
  const nextSource = `pictures/${mood.file}`;
  if (!mascot.src.endsWith(nextSource)) mascot.src = nextSource;
  mascot.alt = mood.alt;
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
  renderWeekMascot(cycle); renderSignal(cycle); renderCurrentExpenses(cycle); renderHealth(); renderWeekReserves(); renderFutureCommitments(); renderFreshness();
}

function cycleCommittedMinor(cycleStart, extras = [], excludeTransactionId = '') {
  const allocations = [...activeAllocations(), ...extras].filter(item => item.cycleStart === cycleStart && item.transactionId !== excludeTransactionId && !state.expenses.find(expense => expense.id === item.transactionId)?.deletedAt);
  return allocations.reduce((sum, item) => sum + Number(item.amountMinor || 0), 0);
}
function renderFutureCommitments() {
  const card = $('#futureCommitments'); if (!card || !state.configured) { card?.classList.add('hidden'); return; }
  const currentStart = allocationCycleStart(dateKey(new Date())), grouped = new Map();
  activeAllocations().filter(item => item.cycleStart > currentStart && !state.expenses.find(expense => expense.id === item.transactionId)?.deletedAt).forEach(item => grouped.set(item.cycleStart, (grouped.get(item.cycleStart) || 0) + item.amountMinor));
  const rows = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 6);
  card.classList.toggle('hidden', !rows.length);
  $('#futureCommitmentList').innerHTML = rows.map(([start, amount]) => { const cycle = state.weeklyCycles.find(item => item.startDate === start && !item.deletedAt), projected = Number(cycle?.budgetMinor ?? effectiveWeeklyBudgetMinor()) - amount; return `<div class="future-row"><span>Semaine du ${shortDate(start)}</span><span class="future-values"><strong>${formatMoney(amount)} engagés</strong><small>reste ${formatMoney(projected)}</small></span></div>`; }).join('');
}

function closedCycleResult(cycle) {
  const allocated = cycleCommittedMinor(cycle.startDate);
  const transfers = state.reserveTransfers.filter(item => item.sourceType === 'weekly' && !item.deletedAt && item.date >= cycle.startDate && item.date <= cycle.endDate).reduce((sum, item) => sum + item.amountMinor, 0);
  const refunds = state.refunds.filter(item => item.applyToBudget && !item.health && !item.deletedAt && item.date >= cycle.startDate && item.date <= cycle.endDate).reduce((sum, item) => sum + item.amountMinor, 0);
  const spentMinor = allocated + transfers - refunds;
  return { ...cycle, spentMinor, resultMinor: Number(cycle.budgetMinor) - spentMinor };
}
function renderTracking() {
  const currentStart = state.configured ? allocationCycleStart(dateKey(new Date())) : '';
  const rows = state.weeklyCycles.filter(cycle => !cycle.deletedAt && cycle.status === 'closed' && cycle.startDate < currentStart && cycle.budgetMinor !== null && cycle.budgetMinor !== undefined && Number.isFinite(Number(cycle.budgetMinor))).sort((a, b) => b.startDate.localeCompare(a.startDate)).slice(0, trackingWeeks).map(closedCycleResult);
  const gains = rows.filter(row => row.resultMinor >= 0).reduce((sum, row) => sum + row.resultMinor, 0), overages = rows.filter(row => row.resultMinor < 0).reduce((sum, row) => sum + Math.abs(row.resultMinor), 0), net = gains - overages;
  $('#trackingNet').textContent = `${net >= 0 ? '+' : '−'} ${formatMoney(Math.abs(net))}`; $('#trackingNet').classList.toggle('negative', net < 0);
  $('#trackingGains').textContent = `+ ${formatMoney(gains)}`; $('#trackingOverages').textContent = `− ${formatMoney(overages)}`;
  $('#trackingAvailable').textContent = rows.length < trackingWeeks ? `${rows.length} semaine${rows.length > 1 ? 's' : ''} disponible${rows.length > 1 ? 's' : ''}` : '';
  $('#trackingList').innerHTML = rows.length ? `<div class="tracking-head"><span>Semaine</span><span>Budget</span><span>Dépensé</span><span>Écart</span></div>${rows.map(row => `<article class="tracking-row"><span>${shortDate(row.startDate)} → ${shortDate(row.endDate)}</span><span>${formatMoney(row.budgetMinor)}</span><span>${formatMoney(row.spentMinor)}</span><strong class="${row.resultMinor < 0 ? 'negative' : 'positive'}">${row.resultMinor >= 0 ? 'Gain +' : 'Dépassement −'} ${formatMoney(Math.abs(row.resultMinor))}</strong></article>`).join('')}` : '';
  $('#trackingEmpty').classList.toggle('hidden', Boolean(rows.length));
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
  const allocationCount = activeAllocations(entry.id).length, spreadLabel = allocationCount > 1 ? ` · étalée sur ${allocationCount} semaines` : '';
  return `<article class="expense-item ${entry.health ? 'health' : entry.funding}"><div class="expense-symbol">−</div><div><div class="expense-label">${escapeHtml(entry.label)}</div><div class="expense-meta">${shortDate(entry.date)} · ${fundingLabel}${spreadLabel}${nature ? ` · ${nature}` : ''}</div></div><div class="expense-amount">− ${formatMoney(entry.amountMinor)}</div><div class="expense-actions"><button class="delete-expense" data-edit-expense="${entry.id}">Modifier</button><button class="delete-expense" data-delete="${entry.id}">Supprimer</button></div></article>`;
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
function reserveScheduleLabel(reserve) { return reserve.monthlyContributionMinor ? `+ ${formatMoney(reserve.monthlyContributionMinor)} / mois` : 'Sans versement programmé'; }
function renderWeekReserves() {
  const health = state.reserves.find(reserve => reserve.kind === 'health'), balances = healthBalances();
  const others = state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt), visible = others.slice(0, 4);
  const healthRow = health ? `<div class="week-reserve-row"><div><span class="week-reserve-name">Santé</span><span class="week-reserve-meta">Actuel ${formatMoney(balances.current)} · estimé ${formatMoney(balances.settled)}</span></div><strong class="week-reserve-balance${balances.settled < 0 ? ' negative' : ''}">${formatMoney(balances.settled)}</strong></div>` : '';
  const reserveRows = visible.map(reserve => { const balance = reserveBalance(reserve); return `<div class="week-reserve-row"><div><span class="week-reserve-name">${escapeHtml(reserve.name)}</span><span class="week-reserve-meta">${reserve.kind === 'goal' ? 'Projet ou plaisir' : 'Dépense à prévoir'} · ${reserveScheduleLabel(reserve)}</span></div><strong class="week-reserve-balance${balance < 0 ? ' negative' : ''}">${formatMoney(balance)}</strong></div>`; }).join('');
  const more = others.length > visible.length ? `<div class="week-reserve-row"><span class="week-reserve-meta">+ ${others.length - visible.length} autre${others.length - visible.length > 1 ? 's' : ''} réserve${others.length - visible.length > 1 ? 's' : ''}</span></div>` : '';
  $('#weekReservesList').innerHTML = healthRow + reserveRows + more || '<p class="week-reserve-meta">Aucune réserve à afficher.</p>';
}
function renderReserves() {
  const reserves = state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt), list = $('#reserveList');
  list.innerHTML = reserves.length ? reserves.map(reserve => `<article class="reserve-item"><div><span class="reserve-name">${escapeHtml(reserve.name)}</span><span class="reserve-kind">${reserve.kind === 'goal' ? 'Projet ou plaisir' : 'Dépense à prévoir'} · ${reserveScheduleLabel(reserve)}</span></div><span class="reserve-balance">${formatMoney(reserveBalance(reserve))}</span><div class="row-actions"><button class="text-button" data-edit-reserve="${reserve.id}">Modifier</button>${reserve.kind === 'goal' ? `<button class="text-button danger" data-close-reserve="${reserve.id}">Terminer</button>` : ''}</div></article>`).join('') : '<div class="empty-state"><h3>Aucune autre réserve</h3><p>Utilisez une suggestion ou créez la vôtre.</p></div>';
  list.querySelectorAll('[data-edit-reserve]').forEach(button => button.onclick = () => openReserveDialog(state.reserves.find(reserve => reserve.id === button.dataset.editReserve))); list.querySelectorAll('[data-close-reserve]').forEach(button => button.onclick = () => closeReserve(button.dataset.closeReserve));
}

function manualEntryActive(entry) { return !entry.endsOn || entry.endsOn >= dateKey(new Date()); }
function recurringFrequency(entry) { return entry?.frequency === 'annual' ? 'annual' : 'monthly'; }
function annualAmount(amount, frequency = 'monthly') { return (Number(amount) || 0) * (frequency === 'annual' ? 1 : 12); }
function typeLabel(type) { return type === 'income' ? 'Revenu' : type === 'reserve' ? 'Réserve' : 'Charge'; }
function recurringAmounts(entry) {
  const amountMinor = Math.round((Number(entry.amount) || 0) * 100), frequency = recurringFrequency(entry);
  const monthlyMinor = frequency === 'annual' ? Math.round(amountMinor / 12) : amountMinor, annualMinor = frequency === 'annual' ? amountMinor : amountMinor * 12;
  return { primary: `${formatMoney(monthlyMinor)} / mois`, secondary: `${formatMoney(annualMinor)} / an` };
}
function entryFamily(entry) {
  const fromTemplate = String(entry.templateKey || '').split('|')[0];
  const type = ['income', 'charge', 'reserve'].includes(fromTemplate) ? fromTemplate : entry.type;
  return type === 'income' ? 'Revenus' : type === 'reserve' ? 'Réserves' : type === 'charge' ? 'Charges' : 'Autres';
}
function readableTemplateGroup(value) { return String(value || '').toLocaleLowerCase('fr-FR').replace(/(^|\s)(\S)/g, (_, prefix, character) => `${prefix}${character.toLocaleUpperCase('fr-FR')}`); }
function entryTemplateGroup(entry) {
  const [, rawGroup = ''] = String(entry.templateKey || '').split('|');
  if (rawGroup) return readableTemplateGroup(rawGroup);
  return entry.source === 'manual' ? `Autres ${entryFamily(entry).toLocaleLowerCase('fr-FR')}` : 'À classer';
}
function calculatorTotals() {
  if (!calculatorState) return { income: 0, monthlyCharges: 0, annualCharges: 0, annualNet: 0, weekly: 0 };
  let income = 0, monthlyCharges = 0, annualCharges = 0;
  for (const group of calculatorState.groups || []) { if (group.endsOn && group.endsOn < dateKey(new Date())) continue; const amount = Number(group.acceptedAmount) || 0; if (['salary', 'income_monthly'].includes(group.category)) income += amount * 12; if (group.category === 'income_annual') income += amount; if (['charge_monthly', 'reserve_monthly'].includes(group.category)) monthlyCharges += amount * 12; if (group.category === 'charge_annual') annualCharges += amount; }
  for (const entry of calculatorState.manualMonthly || []) { if (!manualEntryActive(entry)) continue; const amount = annualAmount(entry.amount, recurringFrequency(entry)); if (entry.type === 'income') income += amount; else if (recurringFrequency(entry) === 'annual') annualCharges += amount; else monthlyCharges += amount; }
  const annualNet = (calculatorState.annual || []).reduce((sum, entry) => sum + Math.max(0, (Number(entry.amount) || 0) - (Number(entry.aid) || 0) - (Number(entry.covered) || 0)), 0);
  return { income, monthlyCharges, annualCharges, annualNet, monthlyAverageCharges: (monthlyCharges + annualCharges + annualNet) / 12, weekly: (income - monthlyCharges - annualCharges - annualNet) / 52 };
}
function renderCharges() {
  const totals = calculatorTotals(); $('#recommendedWeekly').textContent = calculatorState ? `${formatMoney(Math.floor(totals.weekly * 100))} / sem.` : '—'; $('#monthlyChargesTotal').textContent = calculatorState ? formatMoney(Math.round(totals.monthlyAverageCharges * 100)) : '—'; $('#monthlyIncomeTotal').textContent = calculatorState ? formatMoney(Math.round(totals.income / 12 * 100)) : '—';
  const entries = [];
  (calculatorState?.manualMonthly || []).forEach((entry, index) => entries.push({ source: 'manual', index, name: entry.name, type: entry.type, amount: Number(entry.amount) || 0, frequency: recurringFrequency(entry), templateKey: entry.templateKey || '', endsOn: entry.endsOn || '', active: manualEntryActive(entry) }));
  (calculatorState?.groups || []).forEach((entry, index) => { if (['salary', 'income_monthly', 'income_annual', 'charge_monthly', 'charge_annual', 'reserve_monthly'].includes(entry.category)) entries.push({ source: 'group', index, name: entry.latestLabel || entry.label, type: ['salary', 'income_monthly', 'income_annual'].includes(entry.category) ? 'income' : entry.category === 'reserve_monthly' ? 'reserve' : 'charge', amount: Number(entry.acceptedAmount) || 0, frequency: ['income_annual', 'charge_annual'].includes(entry.category) ? 'annual' : 'monthly', templateKey: '', endsOn: entry.endsOn || '', active: !entry.endsOn || entry.endsOn >= dateKey(new Date()) }); });
  const byFamily = new Map(); entries.forEach(entry => { const family = entryFamily(entry); if (!byFamily.has(family)) byFamily.set(family, new Map()); const groups = byFamily.get(family), group = entryTemplateGroup(entry); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(entry); });
  $('#chargeList').innerHTML = [...byFamily.entries()].map(([family, groups]) => `<section class="charge-family"><h2>${family}</h2>${[...groups.entries()].map(([group, rows]) => `<section class="charge-template-group"><h3>${escapeHtml(group)}</h3>${rows.map(entry => { const amounts = recurringAmounts(entry); return `<article class="charge-row"><div class="charge-identity"><span class="charge-name">${escapeHtml(entry.name || 'Sans libellé')}</span><span class="charge-meta">${typeLabel(entry.type)}${entry.endsOn ? ` · fin ${shortDate(entry.endsOn)}` : ''}${entry.active ? '' : ' · terminée'}</span></div><div class="charge-amounts"><strong class="charge-value">${amounts.primary}</strong><small>${amounts.secondary}</small></div><div class="row-actions"><button class="text-button" type="button" data-edit-charge="${entry.source}|${entry.index}" aria-label="Modifier ${escapeHtml(entry.name || 'cette ligne')}" title="Modifier">✎</button><button class="text-button danger" type="button" data-remove-charge="${entry.source}|${entry.index}" aria-label="Supprimer ${escapeHtml(entry.name || 'cette ligne')}" title="Supprimer">🗑</button></div></article>`; }).join('')}</section>`).join('')}</section>`).join('');
  $('#chargesEmpty').classList.toggle('hidden', Boolean(entries.length));
  $('#applyBudgetCard').classList.toggle('hidden', !calculatorState || Math.abs((state.baseWeeklyBudgetMinor || 0) - Math.floor(totals.weekly * 100)) < 1);
  $('#chargeList').querySelectorAll('[data-edit-charge]').forEach(button => button.onclick = () => openChargeDialog(button.dataset.editCharge)); $('#chargeList').querySelectorAll('[data-remove-charge]').forEach(button => button.onclick = () => removeCharge(button.dataset.removeCharge));
}
async function saveCalculator() { if (!calculatorState) calculatorState = { mode: 'manual', step: 0, manualMonthly: [], annual: [], groups: [], updatedAt: '' }; calculatorState.updatedAt = new Date().toISOString(); await RebootSecureStorage.save(CALCULATOR_DATABASE, calculatorState); calculatorRefreshReason = 'changed'; renderCharges(); renderSignal(cycleInfo()); }

function render() { renderWeek(); renderMovements(); renderReserves(); renderCharges(); renderTracking(); updateSettingsFields(); }
function showView() { const requested = location.hash.replace('#', '') || 'week', view = ['week', 'movements', 'charges', 'reserves', 'tracking'].includes(requested) ? requested : 'week'; $$('[data-view-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.viewPanel !== view)); $$('[data-view]').forEach(link => link.setAttribute('aria-current', link.dataset.view === view ? 'page' : 'false')); document.title = `REBOOT — ${{ week: 'Semaine', movements: 'Mouvements', charges: 'Charges', reserves: 'Réserves', tracking: 'Suivi' }[view]}`; if (view === 'charges') renderCharges(); if (view === 'movements') renderMovements(); if (view === 'tracking') renderTracking(); window.scrollTo({ top: 0, behavior: 'instant' }); }

function ensureShortcutField() {
  if ($('#shortcutSaveField')) return;
  const field = document.createElement('div'); field.className = 'field'; field.id = 'shortcutSaveField'; field.innerHTML = '<label class="toggle"><input id="saveAsShortcut" name="saveAsShortcut" type="checkbox"><span class="toggle-track"></span><span>Mémoriser comme raccourci</span></label><small class="field-help">Le libellé, la nature, le financement, la réserve et l’étalement seront repris au prochain clic.</small>';
  $('#expenseForm .dialog-actions').before(field);
}

function openExpenseDialog(expense = null, health = false) {
  ensureShortcutField(); editingExpenseId = expense?.id || null; $('#expenseForm').reset(); populateReserveOptions(); renderRecentLabels();
  const allocations = expense ? activeAllocations(expense.id).sort((a, b) => a.sequence - b.sequence) : [], lockedSpread = allocations.length > 1, isHealth = Boolean(expense?.health || health);
  $('#expenseHealth').checked = isHealth; $('#fundingField').classList.toggle('hidden', isHealth); $('#expenseDialogKicker').textContent = expense ? 'Correction' : isHealth ? 'Réserve Santé' : 'Nouvelle dépense'; $('#expenseDialogTitle').textContent = expense ? 'Modifier le montant' : isHealth ? 'Ajouter une dépense Santé' : 'Ajouter un montant'; $('#saveExpenseButton').textContent = expense ? 'Enregistrer les modifications' : 'Enregistrer'; $('#expenseDate').value = expense?.date || dateKey(new Date());
  if (expense) { $('#expenseAmount').value = (expense.amountMinor / 100).toFixed(2); $('#expenseLabel').value = expense.label; const funding = document.querySelector(`input[name="funding"][value="${expense.funding}"]`); if (funding) funding.checked = true; $('#expenseReserve').value = expense.reserveId || ''; const nature = document.querySelector(`input[name="nature"][value="${expense.nature || ''}"]`); if (nature) nature.checked = true; }
  document.querySelector(`input[name="spreadMode"][value="${lockedSpread ? 'spread' : 'once'}"]`).checked = true;
  if (lockedSpread) { $('#spreadWeeks').value = String(allocations.length); const currentStart = allocationCycleStart(dateKey(new Date())); $('#spreadStart').value = allocations[0].cycleStart > currentStart ? 'next' : 'current'; }
  $('#shortcutSaveField').classList.toggle('hidden', Boolean(expense)); $('#saveAsShortcut').checked = false;
  ['expenseAmount', 'expenseDate', 'expenseHealth'].forEach(id => { $(`#${id}`).disabled = lockedSpread; }); $$('input[name="funding"], input[name="spreadMode"]').forEach(input => { input.disabled = lockedSpread; }); $('#spreadWeeks').disabled = lockedSpread; $('#spreadStart').disabled = lockedSpread; $('#spreadLock').classList.toggle('hidden', !lockedSpread);
  toggleReserveChoice(); updateSpreadControls(); $('#expenseDialog').showModal(); (lockedSpread ? $('#expenseLabel') : $('#expenseAmount')).focus();
}
function populateReserveOptions() { const reserves = state.reserves.filter(reserve => reserve.kind !== 'health' && !reserve.closedAt); $('#expenseReserve').innerHTML = reserves.map(reserve => `<option value="${reserve.id}">${escapeHtml(reserve.name)} · ${formatMoney(reserveBalance(reserve))}</option>`).join('') || '<option value="">Aucune réserve</option>'; $('#reserveFundingChoice').classList.toggle('hidden', !reserves.length); }
function toggleReserveChoice() { const health = $('#expenseHealth').checked; $('#fundingField').classList.toggle('hidden', health); $('#reserveChoice').classList.toggle('hidden', health || document.querySelector('input[name="funding"]:checked')?.value !== 'reserve'); updateSpreadControls(); }
function normalizeShortcutLabel(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function applyShortcut(shortcut) {
  $('#expenseLabel').value = shortcut.label || '';
  const nature = document.querySelector(`input[name="nature"][value="${shortcut.nature || ''}"]`); if (nature) nature.checked = true;
  $('#expenseHealth').checked = Boolean(shortcut.health);
  const funding = document.querySelector(`input[name="funding"][value="${shortcut.funding || 'weekly'}"]`); if (funding) funding.checked = true;
  if (shortcut.reserveId && [...$('#expenseReserve').options].some(option => option.value === shortcut.reserveId)) $('#expenseReserve').value = shortcut.reserveId;
  const spreadMode = shortcut.spreadMode === 'spread' ? 'spread' : 'once', spread = document.querySelector(`input[name="spreadMode"][value="${spreadMode}"]`); if (spread) spread.checked = true;
  if (shortcut.spreadWeeks) $('#spreadWeeks').value = String(shortcut.spreadWeeks); if (shortcut.spreadStart) $('#spreadStart').value = shortcut.spreadStart;
  toggleReserveChoice(); updateSpreadControls(); $('#expenseAmount').focus();
}
async function deleteShortcut(id) {
  const shortcut = state.shortcuts.find(item => item.id === id && !item.deletedAt); if (!shortcut || !confirm(`Supprimer le raccourci « ${shortcut.label} » ?`)) return;
  const before = snapshot(shortcut), now = new Date().toISOString(); shortcut.deletedAt = now; shortcut.updatedAt = now; recordEvent('deleted', 'shortcut', shortcut.id, before, shortcut); await saveState(); renderRecentLabels();
}
function renderRecentLabels() {
  const shortcuts = state.shortcuts.filter(item => !item.deletedAt).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const shortcutNames = new Set(shortcuts.map(item => normalizeShortcutLabel(item.label)));
  const labels = [...new Set(state.expenses.filter(item => !item.deletedAt && !shortcutNames.has(normalizeShortcutLabel(item.label))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(item => item.label).filter(Boolean))].slice(0, Math.max(0, 4 - shortcuts.length));
  $('#recentLabels').innerHTML = shortcuts.map(item => `<span class="shortcut-chip"><button type="button" data-shortcut="${item.id}" title="Appliquer tous les choix mémorisés">★ ${escapeHtml(item.label)}</button><button type="button" class="shortcut-delete" data-delete-shortcut="${item.id}" aria-label="Supprimer le raccourci ${escapeHtml(item.label)}">×</button></span>`).join('') + labels.map(label => `<button class="recent-label" type="button" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join('');
  $('#recentLabels').querySelectorAll('[data-shortcut]').forEach(button => button.onclick = () => { const shortcut = state.shortcuts.find(item => item.id === button.dataset.shortcut && !item.deletedAt); if (shortcut) applyShortcut(shortcut); });
  $('#recentLabels').querySelectorAll('[data-delete-shortcut]').forEach(button => button.onclick = () => deleteShortcut(button.dataset.deleteShortcut));
  $('#recentLabels').querySelectorAll('[data-label]').forEach(button => button.onclick = () => { $('#expenseLabel').value = button.dataset.label; });
}
function rememberShortcut(expense, form) {
  if (form.get('saveAsShortcut') !== 'on') return;
  const normalizedLabel = normalizeShortcutLabel(expense.label), now = new Date().toISOString(); let shortcut = state.shortcuts.find(item => !item.deletedAt && item.normalizedLabel === normalizedLabel);
  const value = { label: expense.label, normalizedLabel, health: Boolean(expense.health), funding: expense.funding, reserveId: expense.reserveId || '', reserveName: expense.reserveName || '', nature: expense.nature || '', spreadMode: form.get('spreadMode') === 'spread' ? 'spread' : 'once', spreadWeeks: Number(form.get('spreadWeeks') || 1), spreadStart: String(form.get('spreadStart') || 'current'), updatedAt: now };
  if (shortcut) { const before = snapshot(shortcut); Object.assign(shortcut, value); recordEvent('updated', 'shortcut', shortcut.id, before, shortcut); }
  else { shortcut = { id: createId(), ...value, createdAt: now }; state.shortcuts.push(shortcut); recordEvent('created', 'shortcut', shortcut.id, null, shortcut); }
}
function spreadDraft() {
  const amountMinor = eurosToMinor($('#expenseAmount').value), weeks = Number($('#spreadWeeks').value || 2), startMode = $('#spreadStart').value, currentStart = allocationCycleStart(dateKey(new Date())), firstStart = startMode === 'next' ? RebootBudgetEngine.addDays(currentStart, 7) : currentStart;
  return RebootBudgetEngine.splitAmountMinor(amountMinor, weeks).map((part, index) => ({ transactionId: 'draft', cycleStart: RebootBudgetEngine.addDays(firstStart, index * 7), amountMinor: part }));
}
function updateSpreadControls() {
  if (!state) return; const health = $('#expenseHealth').checked, weekly = document.querySelector('input[name="funding"]:checked')?.value === 'weekly', spread = document.querySelector('input[name="spreadMode"]:checked')?.value === 'spread', locked = Boolean(editingExpenseId && activeAllocations(editingExpenseId).length > 1);
  $('#spreadField').classList.toggle('hidden', health || !weekly); $('#spreadControls').classList.toggle('hidden', !spread); $('#spreadPreview').classList.toggle('hidden', !spread);
  if (health || !weekly || !spread) { if (!locked) $('#saveExpenseButton').textContent = editingExpenseId ? 'Enregistrer les modifications' : 'Enregistrer'; return; }
  const draft = spreadDraft(), currentStart = allocationCycleStart(dateKey(new Date())), budget = effectiveWeeklyBudgetMinor(); let warning = null;
  const rows = draft.map(item => { const total = cycleCommittedMinor(item.cycleStart, draft, editingExpenseId || ''), projected = budget - total; if (!warning && item.cycleStart > currentStart && (total > budget * .5 || projected < 0)) warning = { start: item.cycleStart, total, projected }; return `<li><span>Semaine du ${shortDate(item.cycleStart)}</span><strong>${formatMoney(item.amountMinor)}</strong></li>`; }).join(''), dangerous = Boolean(warning);
  $('#spreadPreview').innerHTML = `<strong>${formatMoney(draft.reduce((sum, item) => sum + item.amountMinor, 0))} répartis exactement</strong><ul>${rows}</ul>${warning ? `<div class="spread-warning"><p>Cette dépense réservera ${formatMoney(warning.total)} sur le budget de ${formatMoney(budget)} de la semaine du ${shortDate(warning.start)}. Il restera ${formatMoney(warning.projected)} avant les autres dépenses.</p><button type="button" data-edit-spread>Modifier l’étalement</button></div>` : ''}`;
  $('#spreadPreview').querySelector('[data-edit-spread]')?.addEventListener('click', () => $('#spreadWeeks').focus());
  if (!locked) $('#saveExpenseButton').textContent = dangerous ? 'Confirmer quand même' : editingExpenseId ? 'Enregistrer les modifications' : 'Enregistrer';
}
async function saveExpense(event) {
  if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = new FormData($('#expenseForm')), label = String(form.get('label') || '').trim(), existing = editingExpenseId ? state.expenses.find(item => item.id === editingExpenseId) : null, existingAllocations = existing ? activeAllocations(existing.id) : [], lockedSpread = existingAllocations.length > 1, amountMinor = lockedSpread ? existing.amountMinor : eurosToMinor(form.get('amount')); if (!amountMinor || !label) return;
  const health = lockedSpread ? existing.health : form.get('health') === 'on', funding = lockedSpread ? existing.funding : health ? 'health' : String(form.get('funding') || 'weekly'), reserve = state.reserves.find(item => item.id === form.get('reserve')); if (funding === 'reserve' && !reserve && !lockedSpread) return;
  const expense = lockedSpread ? { ...existing, label, nature: String(form.get('nature') || ''), updatedAt: new Date().toISOString() } : { id: existing?.id || createId(), date: String(form.get('date') || dateKey(new Date())), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), amountMinor, label, funding, reserveId: reserve?.id || '', reserveName: reserve?.name || '', nature: String(form.get('nature') || ''), health };
  if (existing) { const before = snapshot(existing); Object.assign(existing, expense); if (!lockedSpread) { const deletedAt = new Date().toISOString(), spread = form.get('spreadMode') === 'spread'; existingAllocations.forEach(item => { item.deletedAt = deletedAt; item.updatedAt = deletedAt; }); if (expense.funding === 'weekly') state.allocations.push(...createAllocations(expense, spread ? Number(form.get('spreadWeeks')) : 1, spread ? String(form.get('spreadStart')) : 'current')); } recordEvent('updated', 'expense', existing.id, before, existing); }
  else { state.expenses.push(expense); if (expense.funding === 'weekly') { const spread = form.get('spreadMode') === 'spread'; state.allocations.push(...createAllocations(expense, spread ? Number(form.get('spreadWeeks')) : 1, spread ? String(form.get('spreadStart')) : 'current')); } recordEvent('created', 'expense', expense.id, null, expense); rememberShortcut(expense, form); }
  await saveState(); $('#expenseDialog').close(); render();
}
function deleteExpense(id) { const expense = state.expenses.find(item => item.id === id); if (!expense) return; const allocations = activeAllocations(id), label = expense.label || 'cette dépense'; const message = allocations.length > 1 ? `Supprimer « ${label} » et ses ${allocations.length} affectations hebdomadaires ?` : `Supprimer « ${label} » ?`; if (!confirm(message)) return; const before = snapshot(expense), deletedAt = new Date().toISOString(); expense.deletedAt = deletedAt; expense.updatedAt = deletedAt; allocations.forEach(item => { item.deletedAt = deletedAt; item.updatedAt = deletedAt; }); recordEvent('deleted', 'expense', id, before, expense); saveState(); render(); }

function openRefundDialog(refund = null, health = false) { editingRefundId = refund?.id || null; $('#refundForm').reset(); $('#refundDate').value = refund?.date || dateKey(new Date()); const expenses = state.expenses.filter(item => !item.deletedAt); $('#refundExpense').innerHTML = `<option value="">Aucune dépense précise</option>${expenses.map(expense => `<option value="${expense.id}">${escapeHtml(expense.label)} · ${formatMoney(expense.amountMinor)}</option>`).join('')}`; const isHealth = Boolean(refund ? isHealthRefund(refund) : health); $('#refundHealth').checked = isHealth; $('#refundApply').checked = refund ? Boolean(refund.applyToBudget) : !isHealth; $('#refundApplyField').classList.toggle('hidden', isHealth); if (refund) { $('#refundAmount').value = (refund.amountMinor / 100).toFixed(2); $('#refundLabel').value = refund.label; $('#refundExpense').value = refund.expenseId || ''; } $('#refundDialog').showModal(); $('#refundAmount').focus(); }
async function saveRefund(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = new FormData($('#refundForm')), amountMinor = eurosToMinor(form.get('amount')), label = String(form.get('label') || '').trim(); if (!amountMinor || !label) return; const expenseId = String(form.get('expense') || ''), linked = state.expenses.find(item => item.id === expenseId), health = form.get('health') === 'on' || Boolean(linked?.health), existing = editingRefundId ? state.refunds.find(item => item.id === editingRefundId) : null; const refund = { id: existing?.id || createId(), date: String(form.get('date') || dateKey(new Date())), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), amountMinor, label, expenseId, health, applyToBudget: health ? false : form.get('apply') === 'on' }; if (existing) { const before = snapshot(existing); Object.assign(existing, refund); recordEvent('updated', 'refund', existing.id, before, existing); } else { state.refunds.push(refund); recordEvent('created', 'refund', refund.id, null, refund); } await saveState(); $('#refundDialog').close(); render(); }
function deleteRefund(id) { const refund = state.refunds.find(item => item.id === id); if (!refund || !confirm(`Supprimer le remboursement « ${refund.label || 'sans libellé'} » ?`)) return; const before = snapshot(refund); refund.deletedAt = new Date().toISOString(); recordEvent('deleted', 'refund', id, before, refund); saveState(); render(); }

function openReserveDialog(reserve = null, suggestion = '') { editingReserveId = reserve?.id || null; $('#reserveForm').reset(); $('#reserveDialogKicker').textContent = reserve ? 'Correction' : 'Nouvelle réserve'; $('#reserveDialogTitle').textContent = reserve ? 'Modifier la réserve' : 'Créer une réserve'; $('#saveReserveButton').textContent = reserve ? 'Enregistrer' : 'Créer'; $('#reserveOpenedOn').value = reserve?.openedOn || dateKey(new Date()); $('#reserveName').value = reserve?.name || suggestion; const kind = reserve?.kind || (suggestion === 'Nouveau projet' ? 'goal' : 'recurring'); document.querySelector(`input[name="reserveKind"][value="${kind}"]`).checked = true; if (reserve) { $('#reserveBalance').value = ((reserve.initialBalanceMinor || 0) / 100).toFixed(2); $('#reserveMonthly').value = ((reserve.monthlyContributionMinor || 0) / 100).toFixed(2); $('#reserveTarget').value = ((kind === 'goal' ? reserve.targetMinor : reserve.annualTargetMinor) || 0) / 100 || ''; $('#reserveReal').checked = Boolean(reserve.real); } updateReservePreview(); $('#reserveDialog').showModal(); }
async function saveReserve(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const name = $('#reserveName').value.trim(), kind = document.querySelector('input[name="reserveKind"]:checked')?.value || 'recurring', initialBalanceMinor = eurosToMinor($('#reserveBalance').value), monthlyContributionMinor = eurosToMinor($('#reserveMonthly').value), targetMinor = eurosToMinor($('#reserveTarget').value); if (!name) return; const annualTargetMinor = monthlyContributionMinor ? monthlyContributionMinor * 12 : kind === 'recurring' ? targetMinor : 0, existing = editingReserveId ? state.reserves.find(item => item.id === editingReserveId) : null; const reserve = { id: existing?.id || createId(), name, kind, initialBalanceMinor, monthlyContributionMinor: monthlyContributionMinor || (kind === 'recurring' && annualTargetMinor ? Math.floor(annualTargetMinor / 12) : 0), annualTargetMinor, targetMinor: kind === 'goal' ? targetMinor : 0, openedOn: $('#reserveOpenedOn').value || dateKey(new Date()), real: $('#reserveReal').checked, includedInCalculatorBudget: false, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }; if (existing) { const before = snapshot(existing); Object.assign(existing, reserve); recordEvent('updated', 'reserve', existing.id, before, existing); } else { state.reserves.push(reserve); recordEvent('created', 'reserve', reserve.id, null, reserve); } await saveState(); $('#reserveDialog').close(); render(); }
function updateReservePreview() { const kind = document.querySelector('input[name="reserveKind"]:checked')?.value || 'recurring', monthly = eurosToMinor($('#reserveMonthly').value), target = eurosToMinor($('#reserveTarget').value), annual = monthly ? monthly * 12 : kind === 'recurring' ? target : 0; $('#reserveTargetLabel').textContent = kind === 'goal' ? 'Objectif total du projet' : 'Ou objectif sur un an'; $('#reserveTargetHelp').textContent = kind === 'goal' ? 'Le projet reste ouvert jusqu’à ce que vous le terminiez.' : 'Le versement mensuel est prioritaire si les deux champs sont remplis.'; $('#reserveOpenedHelp').textContent = 'Cette date sert de point de départ au solde.'; $('#reserveImpact').innerHTML = annual ? `Impact estimé<strong>− ${formatMoney(Math.ceil(annual / 52))} par semaine</strong>` : 'Aucun versement programmé. Vous pourrez l’alimenter ponctuellement, par exemple avec une prime.'; $('#reserveBankWarning').classList.toggle('hidden', !$('#reserveReal').checked || !monthly); $('#reserveBankWarning').textContent = monthly ? `Prévoir un virement de ${formatMoney(monthly)} par mois vers ce compte.` : ''; }
function closeReserve(id) { const reserve = state.reserves.find(item => item.id === id); if (!reserve || !confirm(`Terminer « ${reserve.name} » ?`)) return; const before = snapshot(reserve); reserve.closedAt = new Date().toISOString(); recordEvent('closed', 'reserve', id, before, reserve); saveState(); render(); }

function openRebalanceDialog() { const health = healthBalances(); $('#rebalanceAmount').value = health.current < 0 ? (Math.abs(health.current) / 100).toFixed(2) : ''; const reserves = state.reserves.filter(item => item.kind !== 'health' && !item.closedAt && reserveBalance(item) > 0); $('#rebalanceSource').innerHTML = '<option value="weekly">Budget de la semaine</option>' + reserves.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${formatMoney(reserveBalance(item))}</option>`).join(''); $('#rebalanceDialog').showModal(); }
async function saveRebalance(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const amountMinor = eurosToMinor($('#rebalanceAmount').value), source = $('#rebalanceSource').value, health = state.reserves.find(item => item.kind === 'health'); if (!amountMinor || !health) return; if (source !== 'weekly') { const reserve = state.reserves.find(item => item.id === source); if (!reserve || reserveBalance(reserve) < amountMinor) return; } const transfer = { id: createId(), date: dateKey(new Date()), createdAt: new Date().toISOString(), amountMinor, sourceType: source === 'weekly' ? 'weekly' : 'reserve', sourceReserveId: source === 'weekly' ? '' : source, toReserveId: health.id }; state.reserveTransfers.push(transfer); recordEvent('created', 'transfer', transfer.id, null, transfer); await saveState(); $('#rebalanceDialog').close(); render(); }

function updateChargeFrequencyControls() {
  const frequency = $('#chargeFrequency'), isGroupReserve = String(editingCharge || '').startsWith('group|') && $('#chargeType').value === 'reserve';
  if (isGroupReserve) frequency.value = 'monthly';
  frequency.disabled = isGroupReserve;
  frequency.title = isGroupReserve ? 'Les regroupements existants ne prennent en charge que les versements mensuels vers une réserve.' : '';
  const amountMinor = eurosToMinor($('#chargeAmount').value), selected = frequency.value === 'annual' ? 'annual' : 'monthly';
  $('#chargeFrequencyEquivalent').textContent = amountMinor ? (selected === 'annual' ? `Équivalent : ≈ ${formatMoney(Math.round(amountMinor / 12))} / mois` : `Équivalent : ≈ ${formatMoney(amountMinor * 12)} / an`) : '';
}
function groupCategory(type, frequency) {
  if (type === 'income') return frequency === 'annual' ? 'income_annual' : 'income_monthly';
  if (type === 'reserve') return 'reserve_monthly';
  return frequency === 'annual' ? 'charge_annual' : 'charge_monthly';
}
function openChargeDialog(reference = '') {
  editingCharge = reference || null; $('#chargeForm').reset(); $('#chargeDialogKicker').textContent = reference ? 'Modification' : 'Nouvelle charge'; $('#chargeDialogTitle').textContent = reference ? 'Modifier la ligne' : 'Ajouter une charge';
  if (reference) {
    const [source, rawIndex] = reference.split('|'), index = Number(rawIndex), entry = source === 'manual' ? calculatorState.manualMonthly[index] : calculatorState.groups[index];
    $('#chargeName').value = source === 'manual' ? entry.name : entry.latestLabel || entry.label;
    $('#chargeType').value = source === 'manual' ? entry.type : ['salary', 'income_monthly', 'income_annual'].includes(entry.category) ? 'income' : entry.category === 'reserve_monthly' ? 'reserve' : 'charge';
    $('#chargeAmount').value = source === 'manual' ? entry.amount : entry.acceptedAmount;
    $('#chargeFrequency').value = source === 'manual' ? recurringFrequency(entry) : ['income_annual', 'charge_annual'].includes(entry.category) ? 'annual' : 'monthly';
    $('#chargeEndsOn').value = entry.endsOn || '';
  }
  updateChargeFrequencyControls(); $('#chargeDialog').showModal();
}
async function saveCharge(event) {
  if (event.submitter?.value === 'cancel') return; event.preventDefault();
  const name = $('#chargeName').value.trim(), type = $('#chargeType').value, amount = Number($('#chargeAmount').value), frequency = $('#chargeFrequency').value === 'annual' ? 'annual' : 'monthly', endsOn = $('#chargeEndsOn').value;
  if (!name || !amount) return;
  if (!calculatorState) calculatorState = { mode: 'manual', step: 0, manualMonthly: [], annual: [], groups: [] };
  if (editingCharge) {
    const [source, rawIndex] = editingCharge.split('|'), entry = source === 'manual' ? calculatorState.manualMonthly[Number(rawIndex)] : calculatorState.groups[Number(rawIndex)];
    if (source === 'manual') Object.assign(entry, { name, type, amount, frequency, endsOn });
    else Object.assign(entry, { latestLabel: name, acceptedAmount: amount, endsOn, category: groupCategory(type, frequency) });
  } else calculatorState.manualMonthly.push({ name, type, amount, endsOn, nature: 'fixed', frequency, templateKey: '', note: 'Ajouté depuis l’APP.', search: '', searchSelected: {} });
  await saveCalculator(); $('#chargeDialog').close(); render();
}
async function removeCharge(reference) { const [source, rawIndex] = reference.split('|'), index = Number(rawIndex), entry = source === 'manual' ? calculatorState?.manualMonthly?.[index] : calculatorState?.groups?.[index], label = source === 'manual' ? entry?.name : entry?.latestLabel || entry?.label; if (!entry || !confirm(`Supprimer « ${label || 'cette ligne'} » du budget conseillé ?`)) return; if (source === 'manual') calculatorState.manualMonthly.splice(index, 1); else calculatorState.groups[index].category = 'ignore'; await saveCalculator(); render(); }
async function applyRecommendedBudget() { const totals = calculatorTotals(), weeklyBudgetMinor = Math.floor(totals.weekly * 100); if (weeklyBudgetMinor <= 0) return; state.baseWeeklyBudgetMinor = weeklyBudgetMinor; state.weeklyBudgetMinor = weeklyBudgetMinor; state.configured = state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== ''; state.budgetSource = 'calculator'; state.calculatorBudget = { version: 1, updatedAt: new Date().toISOString(), sourceUpdatedAt: calculatorState.updatedAt, weeklyBudgetMinor, incomeAnnualMinor: Math.round(totals.income * 100), monthlyChargesAnnualMinor: Math.round(totals.monthlyCharges * 100), annualChargesMinor: Math.round((totals.annualCharges + totals.annualNet) * 100), permanentReserveLines: (calculatorState.manualMonthly || []).filter(item => item.type === 'reserve' && manualEntryActive(item)).map(item => ({ name: item.name, monthlyContributionMinor: Math.round(annualAmount(item.amount, recurringFrequency(item)) * 100 / 12) })) }; calculatorRefreshReason = ''; await saveState(); render(); location.hash = '#week'; }

function updateSettingsFields() { $('#householdName').value = state.householdName || 'Notre foyer'; $('#weeklyBudget').value = state.baseWeeklyBudgetMinor ? (state.baseWeeklyBudgetMinor / 100).toFixed(2) : ''; $('#weeklyBudget').disabled = state.budgetSource === 'calculator'; $('#weeklyBudgetHelp').textContent = state.budgetSource === 'calculator' ? 'Ce montant est géré depuis l’écran Charges.' : 'Budget provisoire modifiable ici.'; $('#rebootDay').value = state.rebootDay ?? ''; }
function openSettings() { updateSettingsFields(); $('#settingsDialog').showModal(); }
async function saveSettings(event) { if (event.submitter?.value === 'cancel') return; event.preventDefault(); state.householdName = $('#householdName').value.trim() || 'Notre foyer'; if (state.budgetSource !== 'calculator') { const budget = eurosToMinor($('#weeklyBudget').value); if (budget) state.baseWeeklyBudgetMinor = state.weeklyBudgetMinor = budget; } if ($('#rebootDay').value !== '') state.rebootDay = Number($('#rebootDay').value); state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined); await saveState(); $('#settingsDialog').close(); render(); }
async function refreshCalculatorStatus() { calculatorRefreshReason = ''; try { calculatorState = await RebootSecureStorage.read(CALCULATOR_DATABASE, CALCULATOR_STORE); if (!calculatorState || state.budgetSource !== 'calculator' || !state.calculatorBudget) return; if (calculatorState.updatedAt && calculatorState.updatedAt > (state.calculatorBudget.sourceUpdatedAt || '')) calculatorRefreshReason = 'changed'; const today = dateKey(new Date()); if ((calculatorState.manualMonthly || []).some(item => item.endsOn && item.endsOn < today && item.endsOn >= String(state.calculatorBudget.sourceUpdatedAt || '').slice(0, 10))) calculatorRefreshReason = 'expired'; } catch { calculatorState = null; } }
function showSyncCompleteNotice() { let notice; try { notice = JSON.parse(sessionStorage.getItem('reboot-sync-complete') || 'null'); sessionStorage.removeItem('reboot-sync-complete'); } catch { return false; } if (!notice) return false; $('#syncCompleteMessage').textContent = notice.restored ? 'Votre budget Google a été récupéré sur cet appareil.' : notice.merged ? 'Les changements trouvés sur vos autres appareils ont été réunis.' : 'Votre copie Google est à jour.'; $('#syncCompleteDialog').showModal(); return true; }
function finishInitialLoad() { document.body.classList.remove('app-loading'); $('#appLoading').setAttribute('aria-hidden', 'true'); }
let welcomeStorage = '';
function driveDate(value) { try { return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return 'date inconnue'; } }
function renderDriveDatasetChoices() {
  const candidates = window.RebootDrive?.config?.().remoteCandidates || [];
  $('#welcomeDatasetStep').innerHTML = candidates.map((candidate, index) => `<button class="welcome-option" type="button" data-use-drive-dataset="${escapeHtml(candidate.datasetId)}"><span class="welcome-option-mark">☁</span><span class="welcome-option-copy"><strong>Budget ${candidates.length > 1 ? index + 1 : 'REBOOT'} trouvé</strong><small>Modifié le ${escapeHtml(driveDate(candidate.modifiedTime))} · Dataset …${escapeHtml(String(candidate.datasetId).slice(-4).toUpperCase())}</small></span></button>`).join('');
}
function showDatasetConflict(datasetId) {
  const candidate = (window.RebootDrive?.config?.().remoteCandidates || []).find(item => item.datasetId === datasetId);
  if (!candidate) return showWelcomeChoice('datasets');
  welcomeStorage = '';
  $('#welcomeStorageStep').classList.add('hidden');
  $('#welcomeSetupStep').classList.add('hidden');
  $('#welcomeDatasetStep').classList.remove('hidden');
  $('#welcomeTitle').textContent = 'Confirmer le budget à utiliser';
  $('#welcomeStep').textContent = 'Un ancien lien doit être remplacé';
  $('#welcomeLead').textContent = 'REBOOT a trouvé ce budget dans Google Drive, mais le serveur possède encore une ancienne association. Aucun fichier ni montant n’a été modifié.';
  $('#welcomeDatasetStep').innerHTML = `<div class="welcome-note"><strong>Que se passe-t-il si je continue ?</strong><p>Seul le lien technique du serveur sera mis à jour vers ce budget Google Drive. Le budget Drive ne sera pas supprimé et les autres appareils pourront toujours l’utiliser.</p><p>Si un autre appareil a des changements en attente, ouvrez-le ensuite : il retrouvera ce budget et pourra les synchroniser.</p></div><button class="welcome-option" type="button" data-replace-drive-dataset="${escapeHtml(datasetId)}"><span class="welcome-option-mark">☁</span><span class="welcome-option-copy"><strong>Utiliser ce budget Google Drive</strong><small>Modifié le ${escapeHtml(driveDate(candidate.modifiedTime))} · aucune donnée n’est supprimée.</small></span></button><button class="welcome-back" type="button" data-keep-current-dataset>Conserver l’association actuelle</button>`;
}
function showWelcomeChoice(choice = 'storage') {
  const setup = choice === 'local' || choice === 'drive', datasets = choice === 'datasets';
  welcomeStorage = setup ? choice : '';
  $('#welcomeStorageStep').classList.toggle('hidden', setup || datasets);
  $('#welcomeSetupStep').classList.toggle('hidden', !setup);
  $('#welcomeDatasetStep').classList.toggle('hidden', !datasets);
  if (datasets) {
    renderDriveDatasetChoices();
    $('#welcomeTitle').textContent = 'Un budget Google Drive a été trouvé';
    $('#welcomeStep').textContent = (window.RebootDrive?.config?.().remoteCandidates || []).length > 1 ? 'Choisissez le budget à utiliser' : 'Votre budget est prêt à être récupéré';
    $('#welcomeLead').textContent = 'REBOOT a uniquement lu les fichiers valides de votre espace privé Google Drive. Aucun nouveau budget ne sera créé avant votre choix.';
    return;
  }
  $('#welcomeBackButton').classList.toggle('hidden', choice === 'drive' && Boolean(window.RebootDrive?.config?.().syncPendingSetup));
  if (!setup) {
    $('#welcomeTitle').textContent = 'Où garder votre budget ?';
    $('#welcomeStep').textContent = 'Étape 1 sur 2 · choisissez le stockage';
    $('#welcomeLead').textContent = 'Ce choix détermine comment retrouver vos données plus tard.';
    return;
  }
  $('#welcomeTitle').textContent = choice === 'drive' ? 'Google Drive est prêt' : 'Utiliser cet appareil';
  $('#welcomeStep').textContent = choice === 'drive' ? 'Étape 2 sur 2 · votre Drive ne contient pas encore de budget' : 'Étape 2 sur 2 · créer ou importer';
  $('#welcomeLead').textContent = choice === 'drive'
    ? 'La connexion fonctionne. Créez un budget ou importez votre sauvegarde : il sera ensuite synchronisé automatiquement.'
    : 'Démarrez un budget vierge ou chargez une sauvegarde REBOOT que vous possédez déjà.';
  $('#createBudgetButton').querySelector('strong').textContent = 'Créer un nouveau budget';
  $('#createBudgetButton').querySelector('small').textContent = choice === 'drive' ? 'Il sera synchronisé automatiquement avec Google Drive.' : 'Nous vous guidons pour préparer votre budget semaine.';
}
function prepareWelcomeDialog() { const config = window.RebootDrive?.config?.() || {}; showWelcomeChoice(config.remoteCandidates?.length ? 'datasets' : config.syncPendingSetup ? 'drive' : 'storage'); }
async function beginOnboarding(storage) { state.onboarding = { storage, startedAt: new Date().toISOString() }; await saveState(); $('#welcomeDialog').close(); location.assign('calculateur.html?onboarding=1'); }

$('#addExpenseButton').onclick = () => openExpenseDialog(); $('#emptyAddButton').onclick = () => openExpenseDialog(); $('#movementAddButton').onclick = () => openExpenseDialog(); $('#addHealthExpenseButton').onclick = () => openExpenseDialog(null, true); $('#addRefundButton').onclick = () => openRefundDialog(); $('#addHealthRefundButton').onclick = () => openRefundDialog(null, true); $('#settingsButton').onclick = openSettings; $('#addReserveButton').onclick = () => openReserveDialog(); $('#addChargeButton').onclick = () => openChargeDialog(); $('#rebalanceHealthButton').onclick = openRebalanceDialog; $('#applyRecommendedBudget').onclick = applyRecommendedBudget;
$('#expenseForm').onsubmit = saveExpense; $('#refundForm').onsubmit = saveRefund; $('#reserveForm').onsubmit = saveReserve; $('#chargeForm').onsubmit = saveCharge; $('#rebalanceForm').onsubmit = saveRebalance; $('#settingsForm').onsubmit = saveSettings;
$('#chargeAmount').oninput = updateChargeFrequencyControls; $('#chargeFrequency').onchange = updateChargeFrequencyControls; $('#chargeType').onchange = updateChargeFrequencyControls;
$$('input[name="funding"]').forEach(input => input.onchange = toggleReserveChoice); $('#expenseHealth').onchange = toggleReserveChoice; $('#refundHealth').onchange = () => { const health = $('#refundHealth').checked; $('#refundApplyField').classList.toggle('hidden', health); if (health) $('#refundApply').checked = false; }; $('#refundExpense').onchange = () => { const expense = state.expenses.find(item => item.id === $('#refundExpense').value); if (expense?.health) { $('#refundHealth').checked = true; $('#refundHealth').dispatchEvent(new Event('change')); } };
$$('input[name="spreadMode"]').forEach(input => input.onchange = updateSpreadControls); $('#spreadWeeks').onchange = updateSpreadControls; $('#spreadStart').onchange = updateSpreadControls; $('#expenseAmount').oninput = updateSpreadControls;
['reserveMonthly', 'reserveTarget', 'reserveReal'].forEach(id => $(`#${id}`).oninput = updateReservePreview); $$('input[name="reserveKind"]').forEach(input => input.onchange = updateReservePreview);
$('#movementSearch').oninput = renderMovements; $$('[data-movement-filter]').forEach(button => button.onclick = () => { movementFilter = button.dataset.movementFilter; $$('[data-movement-filter]').forEach(item => item.setAttribute('aria-pressed', item === button ? 'true' : 'false')); renderMovements(); });
$$('[data-tracking-weeks]').forEach(button => button.onclick = () => { trackingWeeks = Number(button.dataset.trackingWeeks); $$('[data-tracking-weeks]').forEach(item => item.setAttribute('aria-pressed', item === button ? 'true' : 'false')); renderTracking(); });
$$('[data-reserve-suggestion]').forEach(button => button.onclick = () => openReserveDialog(null, button.dataset.reserveSuggestion));
$('#startLocalButton').onclick = () => showWelcomeChoice('local');
$('#startDriveButton').onclick = () => window.RebootDrive?.connect('/app.html');
$('#welcomeBackButton').onclick = () => showWelcomeChoice('storage');
$('#createBudgetButton').onclick = () => beginOnboarding(welcomeStorage || 'local');
$('#welcomeDatasetStep').onclick = async event => {
  if (event.target.closest('[data-keep-current-dataset]')) { $('#welcomeDialog').close(); return; }
  const button = event.target.closest('[data-use-drive-dataset], [data-replace-drive-dataset]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.replaceDriveDataset) await window.RebootDrive?.replaceDataset(button.dataset.replaceDriveDataset);
    else await window.RebootDrive?.useDataset(button.dataset.useDriveDataset);
  } catch (error) {
    button.disabled = false;
    if (error?.code === 'dataset_conflict') showDatasetConflict(button.dataset.useDriveDataset);
    else {
      $('#welcomeLead').textContent = error?.message || 'Impossible d’ouvrir ce budget Google Drive.';
      $('#welcomeLead').classList.add('welcome-error');
    }
  }
};
window.addEventListener('hashchange', showView);
window.addEventListener('reboot:drive-status', (event) => { driveStatus = event.detail; if (state) { renderFreshness(); if (event.detail.state === 'dataset_selection_required' && !state.configured && !state.onboarding?.storage) { prepareWelcomeDialog(); $('#welcomeDialog').showModal(); } } });
window.addEventListener('reboot:drive-merged', async () => { state = await loadState(); state.baseWeeklyBudgetMinor ||= state.weeklyBudgetMinor || 0; ensureHealthReserve(); synchronizeWeeklyModel(); await refreshCalculatorStatus(); render(); if (state.configured || state.onboarding?.storage) $('#welcomeDialog').close(); });
$('#syncNow').onclick = () => driveStatus?.state === 'reauth_required' ? window.RebootDrive?.connect('/app.html') : window.RebootDrive?.syncNow();

(async function init() {
  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=55', { updateViaCache: 'none' }).catch(() => {});
    // Drive starts its synchronization when drive.js loads. Render the encrypted local snapshot first so network latency never hides the budget.
    state = await loadState(); state.baseWeeklyBudgetMinor ||= state.weeklyBudgetMinor || 0; state.configured = Boolean(state.baseWeeklyBudgetMinor > 0 && state.rebootDay !== null && state.rebootDay !== undefined && state.rebootDay !== ''); const beforeWeeklyModel = JSON.stringify([state.weeklyCycles || [], state.allocations || []]), migrated = ensureHealthReserve(); synchronizeWeeklyModel(); if (migrated || beforeWeeklyModel !== JSON.stringify([state.weeklyCycles, state.allocations])) await saveState(); await refreshCalculatorStatus(); render(); showView(); const syncShown = showSyncCompleteNotice(); prepareWelcomeDialog(); if (!state.configured && !state.onboarding?.storage && !syncShown) $('#welcomeDialog').showModal(); finishInitialLoad();
  } catch (error) { state = defaultState(); ensureHealthReserve(); storageError = error?.message || 'Coffre local indisponible'; render(); showView(); $('#welcomeDialog').showModal(); finishInitialLoad(); }
})();
