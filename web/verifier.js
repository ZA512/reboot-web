(() => {
  'use strict';

  const DAILY_DATABASE = 'reboot-local-v1';
  const DAILY_LEGACY = 'reboot-local-v1';
  const CALCULATOR_DATABASE = 'reboot-calculator-v1';
  const CALCULATOR_LEGACY = 'reboot-site-v02';
  const DAY_MS = 86400000;
  const currency = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  const dateFormatter = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const createId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
  const money = minor => currency.format((Number(minor) || 0) / 100);
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parseDate = value => new Date(`${value}T12:00:00`);
  const formatDate = value => value ? dateFormatter.format(parseDate(value)) : '—';
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const active = items => (items || []).filter(item => item && !item.deletedAt);

  let household = null;
  let calculator = null;
  let headers = [];
  let allRows = [];
  let rawRows = [];
  let headerRowIndex = 0;
  let fileEncoding = '';
  let mapping = null;
  let mappingProfileReused = false;
  let reviewFilter = 'pending';
  let spreadOperationId = '';
  const drafts = new Map();

  function ensureState() {
    household ||= {};
    for (const name of ['expenses', 'refunds', 'reserves', 'reserveTransfers', 'importedBankOperations', 'weeklyCycles', 'allocations', 'auditEvents', 'bankReconciliations', 'bankChargeProfiles', 'shortcuts']) household[name] ||= [];
    household.backupStatus ||= {};
  }

  async function save() {
    household.updatedAt = new Date().toISOString();
    await RebootSecureStorage.save(DAILY_DATABASE, household);
  }

  function recordEvent(type, entity, entityId, before = null, after = null) {
    household.auditEvents.push({ id: createId(), type, entity, entityId, at: new Date().toISOString(), before, after });
  }

  function daysBetween(first, second) { return Math.round((parseDate(second) - parseDate(first)) / DAY_MS); }

  function purchaseDateFromLabel(label, bankDate) {
    if (!bankDate) return '';
    const candidates = [];
    const expression = /(?:^|\D)([0-3]?\d)[\/.\-]([01]?\d)(?:[\/.\-](\d{2,4}))?(?=\D|$)/g;
    let match;
    while ((match = expression.exec(String(label || '')))) {
      const day = Number(match[1]), month = Number(match[2]);
      if (!day || day > 31 || !month || month > 12) continue;
      const bank = parseDate(bankDate);
      let year = match[3] ? Number(match[3]) : bank.getFullYear();
      if (year < 100) year += 2000;
      let candidate = new Date(year, month - 1, day, 12);
      if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) continue;
      if (!match[3] && candidate > bank) candidate = new Date(year - 1, month - 1, day, 12);
      const key = dateKey(candidate), distance = daysBetween(key, bankDate);
      if (distance >= 0 && distance <= 10) candidates.push({ key, distance });
    }
    return candidates.sort((first, second) => first.distance - second.distance)[0]?.key || '';
  }

  function words(value) { return new Set(normalize(value).split(' ').filter(word => word.length > 2)); }
  function labelScore(first, second) {
    const a = normalize(first), b = normalize(second);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return .85;
    const left = words(a), right = words(b), common = [...left].filter(word => right.has(word)).length;
    return common / Math.max(1, Math.max(left.size, right.size));
  }

  function activeReconciliation(operationId) {
    return household.bankReconciliations.find(item => item.bankOperationId === operationId && !item.deletedAt);
  }

  function linkedTargetIds() {
    return new Set(active(household.bankReconciliations).map(item => item.targetId).filter(Boolean));
  }

  function existingMovementCandidates(operation) {
    const positive = operation.amountMinor > 0;
    const entries = positive ? active(household.refunds) : active(household.expenses);
    const targetIds = linkedTargetIds();
    return entries.filter(item => !targetIds.has(item.id)).map(item => {
      const dateDistance = daysBetween(item.date, operation.bankDate);
      const dateCompatible = operation.purchaseDate ? Math.abs(daysBetween(item.date, operation.purchaseDate)) <= 1 : dateDistance >= 0 && dateDistance <= 5;
      if (!dateCompatible) return null;
      const similarity = labelScore(operation.label, item.label), amountExact = Number(item.amountMinor) === Math.abs(Number(operation.amountMinor));
      const effectiveDistance = Math.abs(operation.purchaseDate ? daysBetween(item.date, operation.purchaseDate) : dateDistance);
      return { item, amountExact, similarity, effectiveDistance, score: (amountExact ? 1000 : 0) - effectiveDistance * 100 + Math.round(similarity * 10) };
    }).filter(Boolean).sort((first, second) => second.score - first.score);
  }

  function chargeEntries() {
    const entries = [];
    for (const [index, item] of (calculator?.manualMonthly || []).entries()) {
      if (!item || item.type === 'income' || (item.endsOn && item.endsOn < dateKey(new Date()))) continue;
      entries.push({ reference: `manual|${index}`, name: item.name || 'Charge sans nom', amountMinor: Math.round((Number(item.amount) || 0) * 100), frequency: item.frequency === 'annual' ? 'annual' : 'monthly' });
    }
    for (const [index, item] of (calculator?.groups || []).entries()) {
      if (!item || !['charge_monthly', 'charge_annual', 'reserve_monthly'].includes(item.category) || (item.endsOn && item.endsOn < dateKey(new Date()))) continue;
      entries.push({ reference: `group|${index}`, name: item.latestLabel || item.label || 'Charge sans nom', amountMinor: Math.round((Number(item.acceptedAmount) || 0) * 100), frequency: item.category === 'charge_annual' ? 'annual' : 'monthly' });
    }
    return entries;
  }

  function chargeProfile(reference) { return household.bankChargeProfiles.find(item => item.chargeReference === reference && !item.deletedAt); }
  function chargeSuggestions(operation) {
    const amount = Math.abs(Number(operation.amountMinor));
    return chargeEntries().map(charge => {
      const profile = chargeProfile(charge.reference), aliases = profile?.aliases || [];
      const aliasScore = aliases.reduce((score, alias) => Math.max(score, labelScore(operation.label, alias)), 0);
      const nameScore = labelScore(operation.label, charge.name);
      const expected = charge.frequency === 'annual' ? Math.round(charge.amountMinor / 12) : charge.amountMinor;
      const difference = expected ? Math.abs(amount - expected) / expected : 1;
      const amountScore = difference === 0 ? 35 : difference <= .2 ? 20 : profile?.mode === 'variable' ? 8 : 0;
      const score = Math.round(Math.max(aliasScore, nameScore) * 60) + amountScore + (aliasScore >= .8 ? 25 : 0);
      return { ...charge, profile, score, expected };
    }).filter(item => item.amountMinor >= amount * .5 || item.profile?.mode === 'variable').sort((first, second) => second.score - first.score);
  }

  function suggestionFor(operation) {
    const existing = existingMovementCandidates(operation)[0];
    if (existing?.amountExact) return { action: operation.amountMinor > 0 ? 'existing_refund' : 'existing', target: existing.item.id, note: 'Même montant et date compatible : probablement déjà saisi. Le libellé manuel n’est pas comparé.', strong: true };
    if (operation.amountMinor < 0) {
      const charge = chargeSuggestions(operation)[0];
      if (charge?.score >= 52) return { action: 'charge', target: charge.reference, variable: charge.profile?.mode === 'variable', note: `Charge probable : ${charge.name}. À confirmer.`, strong: charge.score >= 75 };
      return { action: 'weekly', target: '', note: 'Aucune correspondance sûre : dépense de semaine proposée.', strong: false };
    }
    return { action: 'ignore', target: '', note: 'Entrée positive : choisissez son rôle avant de la pointer.', strong: false };
  }

  function draftFor(operation) {
    if (!drafts.has(operation.id)) drafts.set(operation.id, suggestionFor(operation));
    return drafts.get(operation.id);
  }

  function parseCsv(text, delimiter) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index], next = text[index + 1];
      if (character === '"') { if (quoted && next === '"') { cell += '"'; index += 1; } else quoted = !quoted; }
      else if (character === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
      else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && next === '\n') index += 1;
        row.push(cell.trim()); cell = ''; if (row.some(value => String(value).trim())) rows.push(row); row = [];
      } else cell += character;
    }
    row.push(cell.trim()); if (row.some(value => String(value).trim())) rows.push(row); return rows;
  }

  function headerScore(row = []) {
    const content = normalize(row.join(' ')), filled = row.filter(value => String(value).trim()).length;
    const hasDate = /(^| )date( |$)/.test(content), hasLabel = /libelle|description|intitule|operation/.test(content), hasAmount = /montant|amount|debit|credit/.test(content);
    const keywords = (content.match(/date|libelle|description|intitule|operation|montant|amount|debit|credit/g) || []).length;
    return filled + keywords * 5 + (hasDate && hasLabel && hasAmount ? 35 : 0);
  }

  function autoHeader(rows) {
    let bestIndex = 0, bestScore = -1;
    for (let index = 0; index < Math.min(rows.length, 50); index += 1) {
      const width = rows[index].length, following = rows.slice(index + 1, index + 6).filter(row => row.length === width && row.some(value => String(value).trim())).length;
      const score = headerScore(rows[index]) + following * 2;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    return bestIndex;
  }

  function delimiterFor(text) {
    return [';', ',', '\t', '|'].map(delimiter => {
      const rows = parseCsv(text, delimiter), header = autoHeader(rows), width = rows[header]?.length || 1;
      return { delimiter, score: headerScore(rows[header]) + Math.min(width, 12) * 2 + rows.slice(header + 1, header + 8).filter(row => row.length === width).length * 2 };
    }).sort((first, second) => second.score - first.score)[0].delimiter;
  }

  function decodeFile(file) {
    return file.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer); let text = '', encoding = 'UTF-8';
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('windows-1252').decode(bytes); encoding = 'Windows-1252'; }
      if (text.includes('\uFFFD')) { const fallback = new TextDecoder('windows-1252').decode(bytes); if ((fallback.match(/\uFFFD/g) || []).length < (text.match(/\uFFFD/g) || []).length) { text = fallback; encoding = 'Windows-1252'; } }
      return { text, encoding };
    });
  }

  function findHeader(patterns) {
    return headers.findIndex(header => patterns.some(pattern => normalize(header).includes(pattern)));
  }

  function guessedMapping() {
    const guessed = {
      date: findHeader(['date operation', 'date valeur', 'date']),
      label: findHeader(['libelle', 'description', 'intitule', 'operation']),
      amount: findHeader(['montant', 'amount']),
      debit: findHeader(['debit']),
      credit: findHeader(['credit'])
    };
    guessed.amountMode = guessed.amount >= 0 ? 'signed' : 'split'; return guessed;
  }

  function mappingOption(index, optional = false) { return `<option value="${index}">${index < 0 ? optional ? '— Non utilisé —' : '— Choisir une colonne —' : escapeHtml(headers[index])}</option>`; }
  function mappingSelect(id, label, selected, optional = false) {
    return `<label>${label}<select id="${id}">${mappingOption(-1, optional)}${headers.map((_, index) => mappingOption(index)).join('')}</select></label>`;
  }

  function renderMapping(preferredMapping = null) {
    const stored = household.bankImportMapping;
    mappingProfileReused = Boolean(!preferredMapping && stored && stored.signature === headers.map(normalize).join('|'));
    mapping = preferredMapping ? { ...preferredMapping } : mappingProfileReused ? { ...stored.columns } : guessedMapping();
    mapping.amountMode ||= mapping.amount >= 0 ? 'signed' : 'split';
    const headerControl = `<label>Ligne d’en-tête<input id="mapHeaderRow" type="number" min="1" max="${allRows.length}" value="${headerRowIndex + 1}"></label>`;
    const modeControl = `<label>Format du montant<select id="mapAmountMode"><option value="signed" ${mapping.amountMode === 'signed' ? 'selected' : ''}>Une colonne signée</option><option value="split" ${mapping.amountMode === 'split' ? 'selected' : ''}>Deux colonnes débit / crédit</option></select></label>`;
    $('#mapping').innerHTML = `<div class="mapping-detection"><strong>En-tête détectée ligne ${headerRowIndex + 1}</strong><span>${rawRows.length} ligne${rawRows.length > 1 ? 's' : ''} après l’en-tête · ${fileEncoding || 'encodage automatique'}. Modifiez la ligne si nécessaire.</span></div>` + headerControl + mappingSelect('mapDate', 'Date banque', mapping.date) + mappingSelect('mapLabel', 'Description', mapping.label) + modeControl + (mapping.amountMode === 'signed' ? mappingSelect('mapAmount', 'Montant signé', mapping.amount) : mappingSelect('mapDebit', 'Débit', mapping.debit, true) + mappingSelect('mapCredit', 'Crédit', mapping.credit, true));
    $('#mapping').classList.remove('hidden');
    $('#mapHeaderRow').onchange = event => { const next = Math.max(0, Math.min(allRows.length - 1, Number(event.target.value || 1) - 1)); if (next === headerRowIndex) return; headerRowIndex = next; headers = allRows[headerRowIndex] || []; rawRows = allRows.slice(headerRowIndex + 1); renderMapping(); };
    $('#mapAmountMode').onchange = event => renderMapping({ ...mapping, amountMode: event.target.value });
    for (const [id, key] of [['mapDate', 'date'], ['mapLabel', 'label'], ['mapAmount', 'amount'], ['mapDebit', 'debit'], ['mapCredit', 'credit']]) {
      const select = $(`#${id}`); if (!select) continue; select.value = String(mapping[key] ?? -1); select.onchange = () => { mapping[key] = Number(select.value); renderPreview(); };
    }
    renderPreview();
  }

  function parseFrenchDate(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const match = text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (!match) return '';
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]), 12);
    return date.getDate() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 ? dateKey(date) : '';
  }

  function parseAmount(value) {
    let text = String(value || '').replace(/[€\s\u00a0]/g, '');
    if (!text) return 0;
    if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
    else text = text.replace(',', '.');
    return Math.round((Number(text) || 0) * 100);
  }

  function rowsFromMapping() {
    if (!mapping || mapping.date < 0 || mapping.label < 0) return [];
    return rawRows.map(row => {
      const bankDate = parseFrenchDate(row[mapping.date]), label = String(row[mapping.label] || '').trim();
      const amountMinor = mapping.amountMode === 'signed' ? parseAmount(row[mapping.amount]) : parseAmount(row[mapping.credit]) - Math.abs(parseAmount(row[mapping.debit]));
      const purchaseDate = purchaseDateFromLabel(label, bankDate);
      return { bankDate, purchaseDate, effectiveDate: purchaseDate || bankDate, label, amountMinor };
    }).filter(item => item.bankDate && item.label && item.amountMinor);
  }

  function renderPreview() {
    const rows = rowsFromMapping();
    if (!rows.length) { $('#preview').innerHTML = '<p class="muted">Choisissez les bonnes colonnes pour afficher un aperçu.</p>'; $('#importButton').classList.add('hidden'); return; }
    $('#preview').innerHTML = `<div class="preview-wrap"><table class="preview"><thead><tr><th>Date banque</th><th>Date achat</th><th>Description</th><th>Montant</th></tr></thead><tbody>${rows.slice(0, 5).map(row => `<tr><td>${formatDate(row.bankDate)}</td><td>${row.purchaseDate ? `${formatDate(row.purchaseDate)} <span class="amount-in">détectée</span>` : 'Date banque'}</td><td>${escapeHtml(row.label)}</td><td class="${row.amountMinor < 0 ? 'amount-out' : 'amount-in'}">${money(row.amountMinor)}</td></tr>`).join('')}</tbody></table></div>`;
    $('#importButton').classList.remove('hidden');
    $('#importNotice').classList.toggle('hidden', !mappingProfileReused);
    if (mappingProfileReused) $('#importNotice').textContent = 'Colonnes reconnues grâce à votre import précédent. Vérifiez l’aperçu avant de continuer.';
  }

  function fingerprintBase(row) { return `${row.bankDate}|${row.amountMinor}|${normalize(row.label)}`; }
  async function importRows() {
    const occurrences = new Map(), existing = new Set(household.importedBankOperations.map(item => item.fingerprint)); let added = 0;
    for (const row of rowsFromMapping()) {
      const base = fingerprintBase(row), occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
      const fingerprint = `${base}|${occurrence}`;
      if (existing.has(fingerprint)) continue;
      const now = new Date().toISOString();
      household.importedBankOperations.push({ id: createId(), fingerprint, ...row, date: row.bankDate, importedAt: now, createdAt: now, updatedAt: now });
      existing.add(fingerprint); added += 1;
    }
    household.bankImportMapping = { signature: headers.map(normalize).join('|'), columns: mapping, updatedAt: new Date().toISOString() };
    await save(); drafts.clear();
    $('#importNotice').className = 'notice'; $('#importNotice').textContent = added ? `${added} opération${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''}. Elles restent sans effet tant que vous ne les pointez pas.` : 'Aucune nouvelle opération : ce fichier avait déjà été importé.'; $('#importNotice').classList.remove('hidden');
    renderReview();
  }

  function actionOptions(operation, selected) {
    const values = operation.amountMinor < 0 ? [
      ['existing', 'Transaction déjà saisie'], ['weekly', 'Nouvelle dépense semaine'], ['health', 'Nouvelle dépense remboursable'], ['charge', 'Charge déjà prévue'], ['reserve', 'Une réserve'], ['spread', 'Répartir sur plusieurs semaines'], ['transfer', 'Transfert interne'], ['ignore', 'Ne pas tenir compte']
    ] : [
      ['existing_refund', 'Remboursement déjà saisi'], ['refund_weekly', 'Remboursement de semaine'], ['health_refund', 'Remboursement Santé'], ['planned_income', 'Revenu déjà prévu'], ['transfer', 'Transfert interne'], ['ignore', 'Ne pas tenir compte']
    ];
    return values.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  }

  function monthlyChargeStatus(reference, operation) {
    const month = (operation.effectiveDate || operation.bankDate).slice(0, 7);
    const items = active(household.bankReconciliations).filter(item => item.chargeReference === reference && String(item.effectiveDate).startsWith(month));
    const total = items.reduce((sum, item) => sum + Math.abs(Number(household.importedBankOperations.find(operationItem => operationItem.id === item.bankOperationId)?.amountMinor || 0)), 0);
    return { count: items.length, total };
  }

  function targetOptions(operation, draft) {
    if (['existing', 'existing_refund'].includes(draft.action)) {
      const entries = existingMovementCandidates(operation);
      return `<select data-target><option value="">Choisir une transaction…</option>${entries.map(({ item, amountExact }) => `<option value="${item.id}" ${draft.target === item.id ? 'selected' : ''}>${amountExact ? '✓ ' : ''}${escapeHtml(item.label)} · ${formatDate(item.date)} · ${money(item.amountMinor)}</option>`).join('')}</select><span class="target-note">Le rapprochement utilise la date et le montant, pas le libellé saisi à la main ; ✓ indique le même montant.</span>`;
    }
    if (draft.action === 'charge') {
      const entries = chargeSuggestions(operation), selected = draft.target || entries[0]?.reference || ''; if (!draft.target && selected) draft.target = selected;
      const chosen = entries.find(item => item.reference === selected) || chargeEntries().find(item => item.reference === selected), status = selected ? monthlyChargeStatus(selected, operation) : { count: 0, total: 0 };
      return `<select data-target><option value="">Choisir une charge…</option>${entries.map(item => `<option value="${item.reference}" ${selected === item.reference ? 'selected' : ''}>${escapeHtml(item.name)} · ${money(item.expected || item.amountMinor)}</option>`).join('')}</select><label class="variable-toggle"><input type="checkbox" data-variable ${draft.variable || chosen?.profile?.mode === 'variable' ? 'checked' : ''}>Montant variable / plusieurs achats possibles</label>${status.count ? `<span class="target-note">Déjà pointée ${status.count} fois ce mois-ci · ${money(status.total)}. Vérifiez avant de confirmer.</span>` : ''}`;
    }
    if (draft.action === 'reserve') {
      const reserves = active(household.reserves).filter(item => item.kind !== 'health' && !item.closedAt); if (!draft.target && reserves[0]) draft.target = reserves[0].id;
      return `<select data-target><option value="">Choisir une réserve…</option>${reserves.map(item => `<option value="${item.id}" ${draft.target === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>`;
    }
    if (draft.action === 'planned_income') {
      const incomes = [...(calculator?.manualMonthly || []).map((item, index) => ({ ...item, reference: `manual|${index}` })).filter(item => item.type === 'income'), ...(calculator?.groups || []).map((item, index) => ({ ...item, name: item.latestLabel || item.label, reference: `group|${index}` })).filter(item => ['salary', 'income_monthly', 'income_annual'].includes(item.category))];
      return `<select data-target><option value="">Choisir un revenu…</option>${incomes.map(item => `<option value="${item.reference}" ${draft.target === item.reference ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>`;
    }
    return `<span class="target-note">${({ weekly: 'Créera une dépense à la date d’achat.', health: 'Créera une dépense dans la réserve Santé.', spread: 'Vous choisirez les semaines après confirmation.', refund_weekly: 'Rétablira le budget de la semaine concernée.', health_refund: 'Créditera la réserve Santé.', transfer: 'Conservée comme transfert, sans effet sur le budget.', ignore: 'Conservée comme vérifiée, sans effet sur le budget.' }[draft.action] || 'Aucune cible nécessaire.')}</span>`;
  }

  function reconciliationLabel(item) {
    const labels = { existing: 'Liée à une dépense déjà saisie', existing_refund: 'Liée à un remboursement déjà saisi', weekly: 'Ajoutée au budget semaine', health: 'Ajoutée à la réserve Santé', charge: 'Liée à une charge prévue', reserve: 'Payée avec une réserve', spread: 'Répartie sur plusieurs semaines', refund_weekly: 'Remboursement de semaine', health_refund: 'Remboursement Santé', planned_income: 'Liée à un revenu prévu', transfer: 'Transfert interne', ignore: 'Ignorée volontairement' };
    return labels[item.action] || 'Pointée';
  }

  function operationHtml(operation) {
    const reconciliation = activeReconciliation(operation.id), dateSource = operation.purchaseDate ? 'Trouvée dans le libellé' : 'Date banque utilisée';
    if (reconciliation) return `<article class="operation-row pointed" data-operation-row="${operation.id}"><div class="operation-cell bank-date" data-label="Date banque"><strong>${formatDate(operation.bankDate)}</strong></div><div class="operation-cell purchase-date" data-label="Date achat"><strong>${formatDate(operation.effectiveDate)}</strong><span class="date-source ${operation.purchaseDate ? 'detected' : ''}">${dateSource}</span></div><div class="operation-cell description-cell" data-label="Description"><button type="button" class="description-button" data-description="${operation.id}">${escapeHtml(operation.label)}</button></div><div class="operation-cell operation-amount ${operation.amountMinor < 0 ? 'amount-out' : 'amount-in'}" data-label="Montant">${money(operation.amountMinor)}</div><div class="pointed-summary">${escapeHtml(reconciliationLabel(reconciliation))}${reconciliation.confirmedAt ? ` · ${formatDate(reconciliation.confirmedAt.slice(0, 10))}` : ''}</div><div class="operation-cell action-cell"><button class="row-button secondary" type="button" data-unpoint-operation="${operation.id}">Désaffecter</button></div></article>`;
    const draft = draftFor(operation);
    return `<article class="operation-row" data-operation-row="${operation.id}"><div class="operation-cell bank-date" data-label="Date banque"><strong>${formatDate(operation.bankDate)}</strong></div><div class="operation-cell purchase-date" data-label="Date achat"><strong>${formatDate(operation.effectiveDate)}</strong><span class="date-source ${operation.purchaseDate ? 'detected' : ''}">${dateSource}</span></div><div class="operation-cell description-cell" data-label="Description"><button type="button" class="description-button" data-description="${operation.id}">${escapeHtml(operation.label)}</button></div><div class="operation-cell operation-amount ${operation.amountMinor < 0 ? 'amount-out' : 'amount-in'}" data-label="Montant">${money(operation.amountMinor)}</div><div class="operation-cell affectation-cell" data-label="Affectation"><select data-affectation>${actionOptions(operation, draft.action)}</select></div><div class="operation-cell target-cell target-stack" data-label="Cible">${targetOptions(operation, draft)}</div><div class="operation-cell action-cell"><button class="row-button" type="button" data-confirm-operation="${operation.id}">Confirmer</button></div><span class="suggestion-note ${draft.strong ? 'strong' : ''}">${escapeHtml(draft.note || '')}</span></article>`;
  }

  function renderReview() {
    const operations = active(household.importedBankOperations).map(item => { const bankDate = item.bankDate || item.date, purchaseDate = item.purchaseDate || purchaseDateFromLabel(item.label, bankDate); Object.assign(item, { bankDate, purchaseDate, effectiveDate: purchaseDate || bankDate }); return item; }).sort((a, b) => b.bankDate.localeCompare(a.bankDate) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const pointed = operations.filter(item => activeReconciliation(item.id)), pending = operations.filter(item => !activeReconciliation(item.id));
    const visible = reviewFilter === 'pending' ? pending : reviewFilter === 'pointed' ? pointed : operations;
    $('#reviewLead').textContent = operations.length ? 'La proposition est préremplie, mais chaque ligne attend votre confirmation.' : 'Importez un relevé pour commencer.';
    $('#summary').classList.toggle('hidden', !operations.length);
    $('#summary').innerHTML = `<div><strong>${operations.length}</strong><span>opérations conservées</span></div><div><strong>${pending.length}</strong><span>encore à décider</span></div><div><strong>${pointed.length}</strong><span>déjà pointées</span></div>`;
    $('#operationTable').classList.toggle('hidden', !visible.length); $('#reviewEmpty').classList.toggle('hidden', Boolean(visible.length));
    $('#reviewEmpty strong').textContent = operations.length ? reviewFilter === 'pending' ? 'Tout est pointé.' : 'Aucune opération dans cette vue.' : 'Rien à pointer pour le moment.';
    $('#operationList').innerHTML = visible.map(operationHtml).join('');
    bindRows(operations);
  }

  function bindRows(operations) {
    const byId = new Map(operations.map(item => [item.id, item]));
    $$('[data-description]').forEach(button => button.onclick = () => { const operation = byId.get(button.dataset.description); $('#descriptionTitle').textContent = formatDate(operation.bankDate); $('#descriptionText').textContent = operation.label; $('#descriptionDialog').showModal(); });
    $$('[data-operation-row]').forEach(row => {
      const operation = byId.get(row.dataset.operationRow), draft = operation ? draftFor(operation) : null; if (!operation || !draft) return;
      row.querySelector('[data-affectation]')?.addEventListener('change', event => { draft.action = event.target.value; draft.target = ''; draft.variable = false; renderReview(); });
      row.querySelector('[data-target]')?.addEventListener('change', event => { draft.target = event.target.value; renderReview(); });
      row.querySelector('[data-variable]')?.addEventListener('change', event => { draft.variable = event.target.checked; });
    });
    $$('[data-confirm-operation]').forEach(button => button.onclick = () => confirmOperation(byId.get(button.dataset.confirmOperation)));
    $$('[data-unpoint-operation]').forEach(button => button.onclick = () => unpointOperation(byId.get(button.dataset.unpointOperation)));
  }

  function addAllocation(expense, weeks = 1, startMode = 'dated') {
    const rebootDay = Number(household.rebootDay ?? 1), currentStart = RebootBudgetEngine.cycleStartForDate(dateKey(new Date()), rebootDay);
    const first = startMode === 'next' ? RebootBudgetEngine.addDays(currentStart, 7) : startMode === 'current' ? currentStart : RebootBudgetEngine.cycleStartForDate(expense.date, rebootDay);
    const now = new Date().toISOString();
    RebootBudgetEngine.splitAmountMinor(expense.amountMinor, weeks).forEach((amountMinor, index) => { const cycleStart = RebootBudgetEngine.addDays(first, index * 7); household.allocations.push({ id: createId(), transactionId: expense.id, cycleId: RebootBudgetEngine.cycleIdForStart(cycleStart), cycleStart, amountMinor, sequence: index + 1, sequenceCount: weeks, createdAt: now, updatedAt: now }); });
  }

  function createExpense(operation, action, target = '') {
    const now = new Date().toISOString(), reserve = household.reserves.find(item => item.id === target);
    const funding = action === 'health' ? 'health' : action === 'charge' ? 'annualized' : action === 'reserve' ? 'reserve' : action === 'transfer' ? 'transfer' : 'weekly';
    const expense = { id: createId(), date: operation.effectiveDate, createdAt: now, updatedAt: now, amountMinor: Math.abs(operation.amountMinor), label: operation.label, funding, reserveId: reserve?.id || '', reserveName: reserve?.name || '', nature: '', health: action === 'health', bankOperationId: operation.id, importedOperationId: operation.id, ...(action === 'charge' ? { chargeReference: target } : {}) };
    household.expenses.push(expense); if (funding === 'weekly') addAllocation(expense); recordEvent('created', 'expense', expense.id, null, expense); return expense;
  }

  function createRefund(operation, health) {
    const now = new Date().toISOString(), refund = { id: createId(), date: operation.effectiveDate, createdAt: now, updatedAt: now, amountMinor: Math.abs(operation.amountMinor), label: operation.label, expenseId: '', health, applyToBudget: !health, bankOperationId: operation.id, importedOperationId: operation.id };
    household.refunds.push(refund); recordEvent('created', 'refund', refund.id, null, refund); return refund;
  }

  function updateChargeProfile(reference, label, variable) {
    if (!reference) return;
    const now = new Date().toISOString(), normalized = normalize(label); let profile = chargeProfile(reference);
    if (!profile) { profile = { id: createId(), chargeReference: reference, mode: variable ? 'variable' : 'fixed', aliases: [], createdAt: now, updatedAt: now }; household.bankChargeProfiles.push(profile); }
    profile.mode = variable ? 'variable' : 'fixed'; if (normalized && !profile.aliases.includes(normalized)) profile.aliases.push(normalized); profile.updatedAt = now;
  }

  async function finalizeOperation(operation, draft, createdEntity = null) {
    const now = new Date().toISOString(), reconciliation = { id: createId(), bankOperationId: operation.id, action: draft.action, targetType: createdEntity ? (draft.action.includes('refund') ? 'refund' : 'expense') : ['existing', 'existing_refund'].includes(draft.action) ? (draft.action === 'existing' ? 'expense' : 'refund') : draft.action === 'charge' ? 'charge' : '', targetId: createdEntity?.id || draft.target || '', chargeReference: draft.action === 'charge' ? draft.target : '', effectiveDate: operation.effectiveDate, status: 'confirmed', createdEntity: Boolean(createdEntity), confirmedAt: now, createdAt: now, updatedAt: now };
    household.bankReconciliations.push(reconciliation); operation.classification = draft.action; operation.reviewedAt = now; operation.updatedAt = now; recordEvent('created', 'reconciliation', reconciliation.id, null, reconciliation); await save(); drafts.delete(operation.id); renderReview();
  }

  async function confirmOperation(operation) {
    if (!operation || activeReconciliation(operation.id)) return;
    const draft = draftFor(operation);
    if (['existing', 'existing_refund', 'charge', 'reserve', 'planned_income'].includes(draft.action) && !draft.target) { alert('Choisissez une cible avant de confirmer.'); return; }
    if (draft.action === 'spread') { spreadOperationId = operation.id; $('#spreadImportOperation').textContent = `${operation.label} · ${money(Math.abs(operation.amountMinor))}`; updateSpreadPreview(); $('#spreadImportDialog').showModal(); return; }
    let created = null;
    if (['weekly', 'health', 'charge', 'reserve'].includes(draft.action)) created = createExpense(operation, draft.action, draft.target);
    if (['refund_weekly', 'health_refund'].includes(draft.action)) created = createRefund(operation, draft.action === 'health_refund');
    if (draft.action === 'charge') updateChargeProfile(draft.target, operation.label, Boolean(draft.variable));
    await finalizeOperation(operation, draft, created);
  }

  async function unpointOperation(operation) {
    const reconciliation = operation && activeReconciliation(operation.id); if (!reconciliation) return;
    const message = reconciliation.createdEntity ? 'Désaffecter cette opération et supprimer le mouvement créé par ce pointage ?' : 'Désaffecter cette opération ? La transaction déjà saisie sera conservée.';
    if (!confirm(message)) return;
    const now = new Date().toISOString();
    if (reconciliation.createdEntity && reconciliation.targetId) {
      const collection = reconciliation.targetType === 'refund' ? household.refunds : household.expenses, entity = collection.find(item => item.id === reconciliation.targetId);
      if (entity) { const before = JSON.parse(JSON.stringify(entity)); entity.deletedAt = now; entity.updatedAt = now; recordEvent('deleted', reconciliation.targetType, entity.id, before, entity); }
      household.allocations.filter(item => item.transactionId === reconciliation.targetId && !item.deletedAt).forEach(item => { item.deletedAt = now; item.updatedAt = now; });
    }
    const before = JSON.parse(JSON.stringify(reconciliation)); reconciliation.deletedAt = now; reconciliation.updatedAt = now; recordEvent('deleted', 'reconciliation', reconciliation.id, before, reconciliation); delete operation.classification; delete operation.reviewedAt; operation.updatedAt = now; await save(); drafts.delete(operation.id); renderReview();
  }

  function updateSpreadPreview() {
    const operation = household.importedBankOperations.find(item => item.id === spreadOperationId); if (!operation) return;
    const weeks = Number($('#spreadImportWeeks').value || 2), startMode = $('#spreadImportStart').value, currentStart = RebootBudgetEngine.cycleStartForDate(dateKey(new Date()), Number(household.rebootDay ?? 1));
    const first = startMode === 'next' ? RebootBudgetEngine.addDays(currentStart, 7) : startMode === 'current' ? currentStart : RebootBudgetEngine.cycleStartForDate(operation.effectiveDate || operation.bankDate, Number(household.rebootDay ?? 1));
    const parts = RebootBudgetEngine.splitAmountMinor(Math.abs(operation.amountMinor), weeks);
    $('#spreadImportPreview').innerHTML = `<strong>${money(parts.reduce((sum, item) => sum + item, 0))} répartis exactement</strong><ul>${parts.map((part, index) => `<li><span>Semaine du ${formatDate(RebootBudgetEngine.addDays(first, index * 7))}</span><strong>${money(part)}</strong></li>`).join('')}</ul>`;
  }

  async function saveSpread(event) {
    if (event.submitter?.value === 'cancel') { spreadOperationId = ''; return; }
    event.preventDefault(); const operation = household.importedBankOperations.find(item => item.id === spreadOperationId); if (!operation) return;
    const now = new Date().toISOString(), expense = { id: createId(), date: operation.effectiveDate || operation.bankDate, createdAt: now, updatedAt: now, amountMinor: Math.abs(operation.amountMinor), label: operation.label, funding: 'weekly', reserveId: '', reserveName: '', nature: '', health: false, bankOperationId: operation.id, importedOperationId: operation.id };
    household.expenses.push(expense); addAllocation(expense, Number($('#spreadImportWeeks').value || 2), $('#spreadImportStart').value); recordEvent('created', 'expense', expense.id, null, expense);
    await finalizeOperation(operation, { ...draftFor(operation), action: 'spread' }, expense); spreadOperationId = ''; $('#spreadImportDialog').close();
  }

  async function handleFile(file) {
    if (!file) return;
    const decoded = await decodeFile(file), delimiter = delimiterFor(decoded.text); fileEncoding = decoded.encoding; allRows = parseCsv(decoded.text, delimiter);
    if (allRows.length < 2) { $('#importNotice').className = 'notice warning'; $('#importNotice').textContent = 'Ce fichier ne contient pas assez de lignes.'; $('#importNotice').classList.remove('hidden'); return; }
    headerRowIndex = autoHeader(allRows); headers = allRows[headerRowIndex] || []; rawRows = allRows.slice(headerRowIndex + 1); renderMapping();
  }

  async function init() {
    household = await RebootSecureStorage.read(DAILY_DATABASE, DAILY_LEGACY) || {}; calculator = await RebootSecureStorage.read(CALCULATOR_DATABASE, CALCULATOR_LEGACY) || {}; ensureState();
    let migrated = false;
    for (const operation of household.importedBankOperations) {
      const bankDate = operation.bankDate || operation.date, purchaseDate = operation.purchaseDate || purchaseDateFromLabel(operation.label, bankDate), effectiveDate = purchaseDate || bankDate;
      if (operation.bankDate !== bankDate || operation.purchaseDate !== purchaseDate || operation.effectiveDate !== effectiveDate) { Object.assign(operation, { bankDate, purchaseDate, effectiveDate }); migrated = true; }
      if (operation.classification && !activeReconciliation(operation.id)) {
        const action = operation.classification === 'annualized' ? 'charge' : operation.classification;
        const createdExpense = active(household.expenses).find(item => item.importedOperationId === operation.id || item.bankOperationId === operation.id);
        const at = operation.reviewedAt || operation.updatedAt || operation.importedAt || new Date().toISOString();
        household.bankReconciliations.push({ id: createId(), bankOperationId: operation.id, action, targetType: createdExpense ? 'expense' : action === 'charge' ? 'charge' : '', targetId: createdExpense?.id || '', chargeReference: '', effectiveDate, status: 'confirmed', createdEntity: Boolean(createdExpense), confirmedAt: at, createdAt: at, updatedAt: at, migratedFromLegacy: true });
        migrated = true;
      }
    }
    if (migrated) await save();
    $('#csvFile').addEventListener('change', event => handleFile(event.target.files[0])); $('#importButton').addEventListener('click', importRows);
    $$('[data-review-filter]').forEach(button => button.onclick = () => { reviewFilter = button.dataset.reviewFilter; $$('[data-review-filter]').forEach(item => item.setAttribute('aria-selected', String(item === button))); renderReview(); });
    $('#spreadImportWeeks').addEventListener('change', updateSpreadPreview); $('#spreadImportStart').addEventListener('change', updateSpreadPreview); $('#spreadImportForm').addEventListener('submit', saveSpread);
    renderReview();
  }

  init().catch(error => { $('#reviewLead').textContent = `Impossible de charger les données locales : ${error.message}`; });
})();
