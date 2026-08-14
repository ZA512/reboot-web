import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();

async function assertContains(locator, expected) {
  await locator.filter({ hasText: expected }).waitFor({ state: 'attached' });
  const text = await locator.textContent();
  if (!text?.includes(expected)) throw new Error(`Expected "${expected}" in "${text}"`);
}

try {
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  if (await page.locator('body').evaluate(element => element.classList.contains('app-loading'))) throw new Error('The opening screen must disappear once the budget is ready');
  if (!(await page.evaluate(() => Boolean(window.crypto?.subtle)))) throw new Error('Web Crypto is unavailable in the Docker browser context');
  if ((await page.locator('.app-header').evaluate(element => getComputedStyle(element).display)) !== 'flex') throw new Error('The daily tracking stylesheet did not load');
  await page.locator('#welcomeDialog').waitFor({ state: 'visible' });
  console.log('PASS first visit offers a clear starting choice');

  await page.evaluate(() => localStorage.setItem('reboot-drive-config-v2', JSON.stringify({ brokerConnected: true, syncPendingSetup: true })));
  await page.reload({ waitUntil: 'networkidle' });
  await assertContains(page.locator('#welcomeTitle'), 'Google Drive est prêt');
  if (await page.locator('#welcomeStorageStep').isVisible()) throw new Error('A connected empty Drive must go directly to create-or-import choices');
  await assertContains(page.locator('#importBackupOption'), 'Importer une sauvegarde existante');
  await page.evaluate(async () => { localStorage.removeItem('reboot-drive-config-v2'); sessionStorage.removeItem('reboot-google-access-token-v1'); await RebootSecureStorage.clear('reboot-local-v1', 'reboot-local-v1'); await RebootSecureStorage.clear('reboot-calculator-v1', 'reboot-site-v02'); });
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await page.locator('#welcomeDialog').waitFor({ state: 'visible' });
  console.log('PASS an empty Drive is presented as ready for setup, not as a synchronized budget');

  await page.locator('#startLocalButton').click();
  await page.locator('#createBudgetButton').click();
  await page.waitForURL('**/calculateur.html?onboarding=1');
  const localStartSaved = await page.evaluate(async () => (await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'))?.onboarding?.storage === 'local');
  if (!localStartSaved) throw new Error('The selected storage location must be retained before the budget exists');
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await page.locator('#onboardingPanel').waitFor({ state: 'visible' });
  await assertContains(page.locator('#onboardingPanel'), 'Construisez d’abord votre budget');
  await page.evaluate(() => RebootSecureStorage.save('reboot-local-v1', {
    householdName: 'Notre foyer', configured: true, baseWeeklyBudgetMinor: 60000, weeklyBudgetMinor: 60000, rebootDay: 6,
    expenses: [], refunds: [], reserves: [], importedBankOperations: [], auditEvents: [], backupStatus: {}, onboarding: null
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await assertContains(page.locator('#budgetTotal'), '600,00');
  console.log('PASS a start in preparation survives refresh and daily tracking waits for a budget');

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page.waitForURL('**/app.html');
  await assertContains(page.locator('#budgetTotal'), '600,00');
  console.log('PASS configured local tracker opens from root');

  await page.evaluate(() => sessionStorage.setItem('reboot-sync-complete', JSON.stringify({ merged: true, mode: 'protected' })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#syncCompleteDialog').waitFor({ state: 'visible' });
  await assertContains(page.locator('#syncCompleteMessage'), 'autres appareils');
  await page.locator('#syncCompleteDialog button[value="close"]').last().click();
  await page.locator('#syncCompleteDialog').waitFor({ state: 'hidden' });
  console.log('PASS Drive synchronization returns to tracking with a dismissible confirmation');

  await page.goto(`${baseUrl}/app.html#reserves`, { waitUntil: 'networkidle' });
  await page.locator('#addReserveButton').click();
  await page.locator('#reserveName').fill('Noël & anniversaires');
  await page.locator('#reserveBalance').fill('0');
  await page.locator('#reserveMonthly').fill('125');
  await page.locator('#reserveReal').check();
  await assertContains(page.locator('#reserveImpact'), '28,85');
  await assertContains(page.locator('#reserveBankWarning'), '125,00');
  await page.locator('#reserveForm button[value="default"]').click();
  await page.locator('#reserveDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#budgetTotal'), '571,15');
  console.log('PASS reserve reduces available weekly budget');

  await page.goto(`${baseUrl}/app.html#week`, { waitUntil: 'networkidle' });
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseDialog').locator('.close-button').click();
  await page.locator('#expenseDialog').waitFor({ state: 'hidden' });
  console.log('PASS empty expense dialog closes');
  await page.reload({ waitUntil: 'networkidle' });
  await assertContains(page.locator('#budgetTotal'), '571,15');
  await assertContains(page.locator('#reserveList'), 'Noël & anniversaires');
  console.log('PASS encrypted local state survives reload');

  await page.locator('#addExpenseButton').click();
  if ((await page.locator('input[name="nature"]').count()) !== 5 || (await page.locator('#expenseNature').count())) throw new Error('Expense nature must use five quick radio choices instead of a select');
  const natureFollowsDate = await page.evaluate(() => Boolean(document.querySelector('#expenseDate')?.closest('.field')?.nextElementSibling?.classList.contains('nature-field')));
  if (!natureFollowsDate) throw new Error('Expense nature must be placed immediately below the date');
  await page.locator('#expenseAmount').fill('25');
  await page.locator('#expenseLabel').fill('Test correction');
  await page.locator('#saveExpenseButton').click();
  await page.locator('#expenseList [data-edit-expense]').click();
  await page.locator('#expenseAmount').fill('60');
  await page.locator('.nature-choice', { hasText: 'Nécessaire' }).click();
  await page.locator('#expenseHealth').check();
  await page.locator('#saveExpenseButton').click();
  await page.locator('#expenseDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#remaining'), '571,15');
  await assertContains(page.locator('#expenseList'), 'Nécessaire');
  await assertContains(page.locator('#expenseList'), 'Santé');
  await page.goto(`${baseUrl}/app.html#reserves`, { waitUntil: 'networkidle' });
  await assertContains(page.locator('#healthCurrentBalance'), '-60,00');
  await assertContains(page.locator('.health-help .tooltip'), 'solde estimé');
  if (await page.locator('#healthAlert').isHidden()) throw new Error('Health reserve must propose rebalancing once its deficit reaches 50 euros');
  await page.locator('#rebalanceHealthButton').click();
  if (await page.locator('#rebalanceAmount').inputValue() !== '60.00') throw new Error('Health rebalancing must prefill the current deficit');
  await page.locator('#rebalanceDialog .close-button').click();
  await page.goto(`${baseUrl}/app.html#week`, { waitUntil: 'networkidle' });
  await page.locator('#expenseList [data-delete]').click();
  await assertContains(page.locator('#remaining'), '571,15');
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseAmount').fill('50');
  await page.locator('#expenseLabel').fill('Assurance réglée');
  await page.locator('input[name="funding"][value="annualized"]').check();
  await page.locator('#saveExpenseButton').click();
  await assertContains(page.locator('#remaining'), '571,15');
  await page.locator('#expenseList [data-delete]').click();
  await page.locator('#addRefundButton').click();
  await page.locator('#refundAmount').fill('15');
  await page.locator('#refundLabel').fill('Remboursement mutuelle');
  await page.locator('#refundForm button[value="default"]').click();
  await assertContains(page.locator('#remaining'), '586,15');
  await page.locator('#expenseList [data-delete-refund]').click();
  await assertContains(page.locator('#remaining'), '571,15');
  const auditEvents = await page.evaluate(async () => (await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'))?.auditEvents?.filter(event => event.entity === 'expense').length || 0);
  if (auditEvents < 4) throw new Error('Expense corrections must retain an audit trail');
  const olderDate = await page.evaluate(() => { const date = new Date(); date.setDate(date.getDate() - 14); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; });
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseAmount').fill('10');
  await page.locator('#expenseLabel').fill('Test historique');
  await page.locator('#expenseDate').fill(olderDate);
  await page.locator('#saveExpenseButton').click();
  await assertContains(page.locator('#historyList'), 'Test historique');
  await page.locator('#historySection summary').click();
  await page.locator('#historyList [data-edit-expense]').click();
  await page.locator('#expenseLabel').fill('Historique corrigé');
  await page.locator('#saveExpenseButton').click();
  await assertContains(page.locator('#historyList'), 'Historique corrigé');
  await page.locator('#historyList [data-delete]').click();
  await page.goto(`${baseUrl}/app.html#reserves`, { waitUntil: 'networkidle' });
  await page.locator('[data-edit-reserve]').click();
  await page.locator('#reserveMonthly').fill('130');
  await page.locator('#saveReserveButton').click();
  await page.locator('#reserveDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#budgetTotal'), '570,00');
  await page.locator('[data-edit-reserve]').click();
  await page.locator('#reserveMonthly').fill('125');
  await page.locator('#saveReserveButton').click();
  await page.locator('#reserveDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#budgetTotal'), '571,15');
  await page.goto(`${baseUrl}/app.html#reserves`, { waitUntil: 'networkidle' });
  await page.locator('#addReserveButton').click();
  await page.locator('#reserveName').fill('Nouveau canapé');
  await page.locator('input[name="reserveKind"][value="goal"]').check();
  await page.locator('#reserveBalance').fill('200');
  await page.locator('#reserveMonthly').fill('100');
  await page.locator('#reserveTarget').fill('1000');
  await page.locator('#saveReserveButton').click();
  await page.locator('#reserveDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#reserveList'), 'Projet ou plaisir');
  await assertContains(page.locator('#budgetTotal'), '548,07');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-close-reserve]').click();
  await assertContains(page.locator('#budgetTotal'), '571,15');
  await page.locator('#addReserveButton').click();
  await page.locator('#reserveName').fill('Prime annuelle');
  await page.locator('#reserveForm button[value="default"]').click();
  await page.locator('#reserveDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#reserveList'), 'Sans versement programmé');
  await page.goto(`${baseUrl}/app.html#week`, { waitUntil: 'networkidle' });
  await assertContains(page.locator('#weekReservesList'), 'Prime annuelle');
  await assertContains(page.locator('#weekReservesList'), 'Santé');
  console.log('PASS expenses and reserves can be corrected without re-entry');

  await page.goto(`${baseUrl}/historique.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#list')?.textContent?.includes('Test correction'));
  await assertContains(page.locator('#list'), 'Test correction');
  await assertContains(page.locator('#list'), 'Modifié');
  console.log('PASS correction history remains readable locally');

  await page.goto(`${baseUrl}/sauvegarder.html`, { waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="protected"]').check();
  await page.locator('#backupCode').fill('REBOOT-test-code-2026');
  await page.locator('#backupCodeConfirm').fill('REBOOT-test-code-2026');
  await page.locator('#backupAcknowledgement').check();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#createBackup').click();
  const backup = await downloadPromise;
  const backupPath = await backup.path();
  if (!backupPath) throw new Error('Encrypted backup was not downloaded');
  const localBackupRecorded = await page.evaluate(async () => Boolean((await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'))?.backupStatus?.local));
  if (!localBackupRecorded) throw new Error('Local backup timestamp was not recorded');
  await page.evaluate(() => RebootSecureStorage.clear('reboot-local-v1', 'reboot-local-v1'));
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await page.locator('#welcomeDialog').waitFor({ state: 'visible' });
  if (await page.locator('#welcomeStorageStep .welcome-option').count() !== 2) throw new Error('New users need a clear local-versus-Drive choice first');
  await assertContains(page.locator('#welcomeDialog'), 'Synchroniser avec Google Drive');
  await page.locator('#startLocalButton').click();
  await assertContains(page.locator('#welcomeSetupStep'), 'Importer une sauvegarde existante');
  await page.goto(`${baseUrl}/restaurer.html?return=app`, { waitUntil: 'networkidle' });
  await page.locator('#archiveFile').setInputFiles(backupPath);
  await page.locator('#codeField').waitFor({ state: 'visible' });
  await page.locator('#restoreCode').fill('REBOOT-test-code-2026');
  await page.locator('#checkArchive').click();
  await page.locator('#archiveSummary').waitFor({ state: 'visible' });
  await assertContains(page.locator('#archiveSummary'), '4 réserve');
  await page.locator('#restoreAcknowledgement').check();
  await page.locator('#restoreArchive').click();
  await page.locator('#returnToApp').waitFor({ state: 'visible' });
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await assertContains(page.locator('#budgetTotal'), '571,15');
  console.log('PASS encrypted archive restores daily data only after confirmation');

  await page.route('**/api/oauth/google/status', route => route.fulfill({ json: { connected: false, provider: null, scopes: [], csrf_token: null } }));
  await page.goto(`${baseUrl}/drive.html`, { waitUntil: 'domcontentloaded' });
  await assertContains(page.locator('#driveTitle'), 'Vos données sont sur cet appareil');
  if (!(await page.locator('#connectDrive').isVisible())) throw new Error('A disconnected broker must offer a single Google Drive connection action');
  await page.unroute('**/api/oauth/google/status');
  let tokenRequests = 0, appDataRequests = 0, appDataUpload = '';
  await page.route('**/api/oauth/google/status', route => route.fulfill({ json: { connected: true, provider: 'google', scopes: ['https://www.googleapis.com/auth/drive.appdata'], csrf_token: 'browser-csrf', dataset_id: '11111111-1111-4111-8111-111111111111', tombstone_retention_days: 90 } }));
  await page.route('**/api/oauth/google/token', route => { tokenRequests += 1; return route.fulfill({ json: { access_token: `short-token-${tokenRequests}`, expires_in: 3600, expires_at: Date.now() + 3600000 } }); });
  await page.route('**/api/sync/lease**', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 204 }) : route.fulfill({ json: { status: 'acquired', leaseId: 'browser-test-lease', expiresAt: new Date(Date.now() + 15000).toISOString() } }));
  await page.route('https://www.googleapis.com/drive/v3/files**', route => { appDataRequests += 1; return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { files: [] } }); });
  await page.route('https://www.googleapis.com/upload/drive/v3/files**', async route => { appDataUpload = route.request().postData() || ''; return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { id: 'appdata-file-1', name: 'reboot-data.json', version: '1' } }); });
  await page.goto(`${baseUrl}/drive.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem('reboot-drive-config-v2') || '{}').lastSyncAt));
  await assertContains(page.locator('#driveTitle'), 'Votre budget est synchronisé');
  if (tokenRequests !== 1 || appDataRequests < 1 || !appDataUpload.includes('appDataFolder') || !appDataUpload.includes('datasetId')) throw new Error('Broker token, dataset metadata and Drive appDataFolder must be used without proxying the budget through REBOOT');
  await page.evaluate(() => { sessionStorage.setItem('reboot-google-access-token-v1', JSON.stringify({ access_token: 'expired', expires_at: Date.now() - 1 })); const config = JSON.parse(localStorage.getItem('reboot-drive-config-v2') || '{}'); config.driveFileId = ''; localStorage.setItem('reboot-drive-config-v2', JSON.stringify(config)); });
  await page.locator('#connectedState details summary').click();
  await page.locator('#syncDrive').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('reboot-google-access-token-v1') || '{}').access_token === 'short-token-2');
  if (tokenRequests !== 2) throw new Error('An expired browser token must be renewed through the broker');
  const plainArchive = await page.evaluate(async () => {
    const text = await RebootArchive.create('', { encrypted: false });
    return { archive: JSON.parse(text), payload: await RebootArchive.open(text, '') };
  });
  if (plainArchive.archive.format !== 'reboot-plain-archive' || !plainArchive.payload.states) throw new Error('Simple Drive mode must create a readable archive');
  const mergedStates = await page.evaluate(() => RebootDrive.mergeStates(
    { daily: { updatedAt: '2026-08-01T10:00:00.000Z', expenses: [{ id: 'shared', amountMinor: 100, updatedAt: '2026-08-01T10:00:00.000Z' }], reserves: [{ id: 'local', name: 'Canapé', updatedAt: '2026-08-01T10:00:00.000Z' }], allocations: [{ id: 'allocation-local', transactionId: 'shared', amountMinor: 100, updatedAt: '2026-08-01T10:00:00.000Z' }] }, calculator: { updatedAt: '2026-08-01T10:00:00.000Z', manualMonthly: [{ name: 'Local' }] } },
    { daily: { updatedAt: '2026-08-02T10:00:00.000Z', expenses: [{ id: 'shared', amountMinor: 200, updatedAt: '2026-08-02T10:00:00.000Z' }, { id: 'remote', amountMinor: 300, updatedAt: '2026-08-02T10:00:00.000Z' }], refunds: [{ id: 'refund', amountMinor: 50, createdAt: '2026-08-02T10:00:00.000Z' }], weeklyCycles: [{ id: 'cycle-2026-08-01', startDate: '2026-08-01', budgetMinor: 60000, updatedAt: '2026-08-02T10:00:00.000Z' }] }, calculator: { updatedAt: '2026-08-02T10:00:00.000Z', manualMonthly: [{ name: 'Distant' }] } }
  ));
  if (mergedStates.daily.expenses.length !== 2 || mergedStates.daily.expenses.find(expense => expense.id === 'shared')?.amountMinor !== 200 || mergedStates.daily.reserves.length !== 1 || mergedStates.daily.refunds.length !== 1 || mergedStates.daily.allocations.length !== 1 || mergedStates.daily.weeklyCycles.length !== 1 || mergedStates.calculator.manualMonthly[0].name !== 'Distant') throw new Error('Multi-device state merge must preserve independent entries, allocations, cycles and newest edits');
  const protectedStates = await page.evaluate(() => RebootDrive.mergeStates(
    { daily: { updatedAt: '2026-08-01T10:00:00.000Z', configured: true, householdName: 'Notre foyer', baseWeeklyBudgetMinor: 50000, weeklyBudgetMinor: 50000, rebootDay: 1 }, calculator: { updatedAt: '2026-08-01T10:00:00.000Z', manualMonthly: [{ name: 'Internet', amount: 30 }] } },
    { daily: { updatedAt: '2026-08-13T10:00:00.000Z', configured: false, householdName: 'Notre foyer', reserves: [{ kind: 'health', name: 'Santé', initialBalanceMinor: 0 }] }, calculator: { updatedAt: '2026-08-13T10:00:00.000Z', manualMonthly: [] } }
  ));
  if (!protectedStates.daily.configured || protectedStates.daily.baseWeeklyBudgetMinor !== 50000 || protectedStates.calculator.manualMonthly[0]?.name !== 'Internet') throw new Error('A newer empty device must not erase a configured budget');
  const tombstoneStates = await page.evaluate(() => RebootDrive.mergeStates(
    { daily: { expenses: [{ id: 'deleted-expense', amountMinor: 100, updatedAt: '2026-08-01T10:00:00.000Z', modifiedAt: '2026-08-01T10:00:00.000Z', modifiedBy: 'device-a' }] } },
    { daily: { expenses: [{ id: 'deleted-expense', deletedAt: '2026-08-02T10:00:00.000Z', modifiedAt: '2026-08-02T10:00:00.000Z', modifiedBy: 'device-b' }] } }
  ));
  if (!tombstoneStates.daily.expenses.find(expense => expense.id === 'deleted-expense')?.deletedAt) throw new Error('A newer tombstone must prevent an old device from resurrecting a deleted expense');
  await page.unroute('**/api/oauth/google/status');
  await page.unroute('**/api/oauth/google/token');
  await page.unroute('**/api/sync/lease**');
  await page.unroute('https://www.googleapis.com/drive/v3/files**');
  await page.unroute('https://www.googleapis.com/upload/drive/v3/files**');
  await page.route('**/api/oauth/google/status', route => route.fulfill({ status: 503, json: { error: 'broker_unavailable', category: 'temporary' } }));
  await page.goto(`${baseUrl}/drive.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('#errorState').waitFor({ state: 'visible' });
  if (!(await page.locator('#retryDrive').isVisible()) || await page.locator('#reconnectDrive').isVisible()) throw new Error('A temporary broker outage must offer retry without claiming authorization was lost');
  await page.unroute('**/api/oauth/google/status');
  await page.route('**/api/oauth/google/status', route => route.fulfill({ json: { connected: true, provider: 'google', scopes: ['https://www.googleapis.com/auth/drive.appdata'], csrf_token: 'browser-csrf', dataset_id: '11111111-1111-4111-8111-111111111111' } }));
  await page.route('**/api/oauth/google/token', route => route.fulfill({ status: 401, json: { error: 'invalid_grant', category: 'reauth_required', message: 'Google Drive doit être reconnecté.' } }));
  await page.evaluate(() => sessionStorage.removeItem('reboot-google-access-token-v1'));
  await page.goto(`${baseUrl}/drive.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('#reconnectDrive').waitFor({ state: 'visible' });
  await page.unroute('**/api/oauth/google/status');
  await page.unroute('**/api/oauth/google/token');
  await page.evaluate(() => { localStorage.removeItem('reboot-drive-config-v2'); sessionStorage.removeItem('reboot-google-access-token-v1'); });
  console.log('PASS OAuth broker renews short tokens and Drive data stays browser-to-appDataFolder');

  await page.goto(`${baseUrl}/calculateur.html`, { waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="manual"]').check();
  await page.locator('#next').click();
  if ((await page.locator('[data-template-check]').count()) < 40 || (await page.locator('[data-annual-template-check]').count()) < 20) throw new Error('The memory aid must cover monthly and annual themed checklists');
  if (!(await page.locator('.memory-note').count())) throw new Error('Checklist entries must include a useful reminder');
  if (await page.locator('[data-manual]').count()) throw new Error('The manual form must appear after the memory-aid screen');
  await page.locator('[data-template-name="Salaire"]').check();
  await page.locator('[data-annual-template-check="Entretien annuel de chaudière"]').check();
  await page.locator('#next').click();
  if ((await page.locator('[data-manual="0|name"]').inputValue()) !== 'Salaire 1') throw new Error('Checking Salary must prepare its numbered form row');
  await page.locator('.recurring-item-wrap').first().hover();
  await page.locator('[data-duplicate-manual="0"]').click();
  if ((await page.locator('[data-manual="1|name"]').inputValue()) !== 'Salaire 2') throw new Error('Duplicating Salary must insert Salary 2 immediately below the source');
  await page.locator('.recurring-item-wrap').nth(1).hover();
  await page.locator('[data-remove-manual="1"]').click();
  await page.locator('[data-manual="0|name"]').fill('Salaire de ZA152');
  await page.locator('[data-manual="0|type"]').selectOption('income');
  await page.locator('[data-manual="0|amount"]').fill('3000');
  await page.locator('#addManual').click();
  await page.locator('[data-manual="1|name"]').fill('Loyer');
  await page.locator('[data-manual="1|type"]').selectOption('charge');
  await page.locator('[data-manual="1|amount"]').fill('1000');
  await page.locator('#addManual').click();
  await page.locator('[data-manual="2|name"]').fill('Ramonage');
  await page.locator('[data-manual="2|type"]').selectOption('reserve');
  await page.locator('[data-manual="2|amount"]').fill('100');
  await page.locator('#addManual').click();
  await page.locator('[data-manual="3|name"]').fill('Crédit terminé');
  await page.locator('[data-manual="3|type"]').selectOption('charge');
  await page.locator('[data-manual="3|amount"]').fill('100');
  await page.locator('[data-manual="3|endsOn"]').fill('2025-01-01');
  await page.locator('#next').click();
  if ((await page.locator('[data-annual="0|name"]').inputValue()) !== 'Entretien annuel de chaudière') throw new Error('Annual checklist items must be prepared in the annual-expense step');
  for (let step = 0; step < 2; step += 1) await page.locator('#next').click();
  await assertContains(page.locator('#main'), 'Crédit terminé');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-remove-expired]').click();
  await page.waitForFunction(async () => (await RebootSecureStorage.read('reboot-calculator-v1', 'reboot-site-v02'))?.manualMonthly?.length === 3);
  const retainedRows = await page.evaluate(async () => (await RebootSecureStorage.read('reboot-calculator-v1', 'reboot-site-v02'))?.manualMonthly?.length || 0);
  if (retainedRows !== 3) throw new Error('Expired credit must be removable after confirmation');
  await page.locator('#trackerRebootDay').selectOption('6');
  await page.locator('#useForTracking').click();
  await page.waitForURL('**/app.html');
  await assertContains(page.locator('#budgetTotal'), '409,61');
  await assertContains(page.locator('#reserveList'), 'Ramonage');
  await page.locator('#settingsButton').click();
  if (!(await page.locator('#weeklyBudget').isDisabled())) throw new Error('Calculator budget must not be editable in daily settings');
  await page.evaluate(async () => {
    const calculator = await RebootSecureStorage.read('reboot-calculator-v1', 'reboot-site-v02');
    calculator.updatedAt = new Date(Date.now() + 1000).toISOString();
    await RebootSecureStorage.save('reboot-calculator-v1', calculator);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await assertContains(page.locator('#signalText'), 'calculateur a été modifié');
  console.log('PASS calculator budget drives tracking without double-counting its own reserves');

  await page.goto(`${baseUrl}/sauvegarder.html`, { waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="protected"]').check();
  await page.locator('#backupCode').fill('REBOOT-calculator-code-2026');
  await page.locator('#backupCodeConfirm').fill('REBOOT-calculator-code-2026');
  await page.locator('#backupAcknowledgement').check();
  const calculatorBackupPromise = page.waitForEvent('download');
  await page.locator('#createBackup').click();
  const calculatorBackup = await calculatorBackupPromise;
  const calculatorBackupPath = await calculatorBackup.path();
  if (!calculatorBackupPath) throw new Error('Calculator backup was not downloaded');
  await page.evaluate(() => RebootSecureStorage.clear('reboot-calculator-v1', 'reboot-site-v02'));
  await page.goto(`${baseUrl}/restaurer.html`, { waitUntil: 'networkidle' });
  await page.locator('#archiveFile').setInputFiles(calculatorBackupPath);
  await page.locator('#codeField').waitFor({ state: 'visible' });
  await page.locator('#restoreCode').fill('REBOOT-calculator-code-2026');
  await page.locator('#checkArchive').click();
  await page.locator('#archiveSummary').waitFor({ state: 'visible' });
  await page.locator('#restoreAcknowledgement').check();
  await page.locator('#restoreArchive').click();
  const restoredCalculatorRows = await page.evaluate(async () => (await RebootSecureStorage.read('reboot-calculator-v1', 'reboot-site-v02'))?.manualMonthly?.length || 0);
  if (restoredCalculatorRows !== 3) throw new Error('Encrypted archive did not restore calculator data');
  console.log('PASS encrypted archive also restores calculator data');

  await page.goto(`${baseUrl}/calculateur.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => RebootSecureStorage.clear('reboot-calculator-v1', 'reboot-site-v02'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="csv"]').check();
  await page.locator('#next').click();
  await page.locator('#csvFile').setInputFiles({
    name: 'releve-initial.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date;Libellé;Montant\n05/06/2026;Salaire 2026-06;3000\n05/07/2026;Salaire 2026-07;3000\n03/06/2026;Loyer contrat 350;-1000\n03/07/2026;Loyer contrat 378;-1000\n')
  });
  await page.locator('#next').click();
  await page.locator('#next').click();
  await page.locator('[data-template-name="Salaire"]').check();
  await page.locator('#next').click();
  await page.locator('#groupSearch').fill('');
  await page.getByRole('tab', { name: 'Récurrences détectées' }).click();
  if ((await page.locator('[data-discovery-filter]').count()) !== 3) throw new Error('Recurrence detection must expose its three result views as visible toggles');
  await page.locator('[data-discovery-filter="review"]').click();
  if ((await page.locator('[data-discovery-filter="review"]').getAttribute('aria-checked')) !== 'true') throw new Error('The review recurrence toggle must be selectable');
  await page.locator('[data-discovery-filter="suggested"]').click();
  const loyerRow = page.locator('.discovery-table tbody tr', { hasText: 'Loyer contrat' });
  await loyerRow.locator('[data-open-group]').click();
  await page.locator('#transactionsDialog').waitFor({ state: 'visible' });
  await assertContains(page.locator('#transactionsBody'), 'Loyer contrat 350');
  await page.locator('#transactionsDialog button[value="close"]').first().click();
  const salaryRow = page.locator('.discovery-table tbody tr', { hasText: 'Salaire' });
  await salaryRow.locator('[data-open-group]').click();
  await page.locator('#applySelectedTransactions').click();
  if ((await page.locator('input[data-manual="0|amount"]').inputValue()) !== '3000') throw new Error('The detected average must fill the selected recurring amount');
  if ((await page.locator('[data-duplicate-manual="0"]').count()) !== 1 || (await page.locator('[data-remove-manual="0"]').count()) !== 1) throw new Error('Recurring rows must expose duplicate and remove controls');
  console.log('PASS detected recurrences open raw transactions and can fill the selected recurring');

  await page.evaluate(() => RebootSecureStorage.clear('reboot-calculator-v1', 'reboot-site-v02'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="csv"]').check();
  await page.locator('#next').click();
  await page.locator('#csvFile').setInputFiles({
    name: 'releve-treize-mois.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date;Libellé;Montant\n01/08/2025;Salaire 2025-08;1000\n01/09/2025;Salaire 2025-09;1000\n01/10/2025;Salaire 2025-10;1000\n01/11/2025;Salaire 2025-11;1000\n01/12/2025;Salaire 2025-12;1000\n01/01/2026;Salaire 2026-01;1000\n01/02/2026;Salaire 2026-02;1000\n01/03/2026;Salaire 2026-03;1000\n01/04/2026;Salaire 2026-04;1000\n01/05/2026;Salaire 2026-05;1000\n01/06/2026;Salaire 2026-06;1000\n01/07/2026;Salaire 2026-07;1000\n01/08/2026;Salaire 2026-08;1000\n')
  });
  await page.locator('#next').click();
  await page.locator('#next').click();
  await page.locator('[data-template-name="Salaire"]').check();
  await page.locator('#next').click();
  await assertContains(page.locator('#main'), 'Analyse limitée aux 12 derniers mois');
  await page.getByRole('tab', { name: 'Récurrences détectées' }).click();
  await page.locator('.discovery-table tbody tr', { hasText: 'Salaire' }).locator('[data-open-group]').click();
  await assertContains(page.locator('#transactionsBody'), 'Salaire 2026-08');
  if ((await page.locator('#transactionsBody').innerText()).includes('Salaire 2025-08')) throw new Error('The thirteenth, older month must not be used for recurrence analysis');
  await page.locator('#transactionsDialog button[value="close"]').first().click();
  await page.getByRole('tab', { name: 'Recherche par libellé' }).click();
  await page.locator('#groupSearch').fill('Salaire');
  await page.locator('#searchMonths').selectOption('1');
  if ((await page.locator('#groupSearchResults tbody tr').count()) !== 1) throw new Error('The search period selector must restrict results to the latest month');
  await page.locator('#searchMin').fill('1001');
  if ((await page.locator('#groupSearchResults tbody tr').count()) !== 0) throw new Error('A minimum amount alone must filter matching transactions');
  await page.locator('#searchMin').fill('');
  await page.locator('#searchMax').fill('999');
  if ((await page.locator('#groupSearchResults tbody tr').count()) !== 0) throw new Error('A maximum amount alone must filter matching transactions');
  await page.locator('#searchMax').fill('1000');
  if ((await page.locator('#groupSearchResults tbody tr').count()) !== 1) throw new Error('Amount filters must restore transactions at their boundary');
  console.log('PASS CSV longer than twelve months keeps the latest twelve without blocking');

  await page.evaluate(() => RebootSecureStorage.clear('reboot-calculator-v1', 'reboot-site-v02'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="csv"]').check();
  await page.locator('#next').click();
  await page.locator('#csvFile').setInputFiles({
    name: 'releve-un-mois.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date;Libellé;Montant\n05/07/2026;PRET CONTRAT 12345;-764\n06/07/2026;PRET CONTRAT 67890;-253\n07/07/2026;PRET CONTRAT 54321;-147\n05/07/2026;SALAIRE DE ZA152;3000\n06/07/2026;REMBOURSEMENT EXCEPTIONNEL;250\n')
  });
  await page.locator('#next').click();
  await page.locator('#next').click();
  await page.locator('[data-template-name="Salaire"]').check();
  await page.locator('#next').click();
  await page.locator('#groupSearch').fill('');
  await page.getByRole('tab', { name: 'Récurrences détectées' }).click();
  const loanGroup = page.locator('.discovery-table tbody tr', { hasText: 'PRET' });
  await loanGroup.locator('[data-open-group]').click();
  if ((await page.locator('#transactionsDialog input[type="checkbox"]:checked').count()) !== 3) throw new Error('All matched transaction lines must be selectable');
  await page.locator('#transactionsDialog input[type="checkbox"]').first().uncheck();
  await assertContains(page.locator('#selectedTransactionTotal'), '400');
  await page.locator('#applySelectedTransactions').click();
  if ((await page.locator('input[data-manual="0|amount"]').inputValue()) !== '400') throw new Error('The checked transaction subset must update the selected recurring amount');
  await page.getByRole('tab', { name: 'Recherche par libellé' }).click();
  await page.locator('#groupSearch').fill('ZA152');
  if (!(await page.locator('#groupSearch').evaluate(input => document.activeElement === input))) throw new Error('Typing in the label search must keep focus in the input');
  const searchRows = page.locator('#groupSearchResults tbody tr');
  if ((await searchRows.count()) !== 1 || !(await searchRows.first().isVisible())) throw new Error('A label search must display matching raw transaction rows');
  if ((await searchRows.first().locator('input[data-search-transaction]:checked').count()) !== 1) throw new Error('Raw transaction rows must be selected by default');
  await searchRows.first().locator('input[data-search-transaction]').uncheck();
  await assertContains(page.locator('#searchAverage'), '0');
  await searchRows.first().locator('input[data-search-transaction]').check();
  if (!/Moyenne retenue : 3\s*000/.test((await page.locator('#searchAverage').innerText()).replace(/\u202f/g, ' '))) throw new Error('Rechecking a raw transaction must recalculate the monthly average');
  await page.locator('#applySearchAverage').click();
  await assertContains(page.locator('#rebootToast'), 'affectés à');
  await page.locator('#groupSearch').fill('');
  await page.getByRole('tab', { name: 'Récurrences détectées' }).click();
  if ((await page.getByRole('tab', { name: 'Récurrences détectées' }).getAttribute('aria-selected')) !== 'true') throw new Error('The recurrence-detection mode must be available');
  console.log('PASS guided checklist, numbered duplication, one-month totals, selectable lines and raw label search');

  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseAmount').fill('42');
  await page.locator('#expenseLabel').fill('Courses');
  await page.locator('#saveExpenseButton').click();
  await page.locator('#expenseDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#expenseList'), 'Courses');
  const today = new Date();
  const todayText = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
  await page.goto(`${baseUrl}/verifier.html`, { waitUntil: 'networkidle' });
  await page.locator('#csvFile').setInputFiles({
    name: 'controle.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Date;Libellé;Montant\n${todayText};Courses;-42\n${todayText};Pharmacie;-65\n`)
  });
  await page.locator('#importButton').click();
  await page.waitForFunction(() => document.querySelector('#summary')?.textContent?.includes('2 opérations du cycle'));
  await assertContains(page.locator('#summary'), '2');
  await assertContains(page.locator('#operationList'), 'Rapprochée avec une dépense saisie');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#csvFile').setInputFiles({
    name: 'controle-suivant.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Date;Libellé;Montant\n${todayText};Courses;-42\n${todayText};Pharmacie;-65\n`)
  });
  await assertContains(page.locator('#preview'), 'Modèle de colonnes réutilisé');
  await page.locator('[data-action="weekly"]').click();
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await assertContains(page.locator('#remaining'), '302,61');
  console.log('PASS local CSV verification reconciles and adds a confirmed forgotten expense');

  const engineSplits = await page.evaluate(() => ({ exact: RebootBudgetEngine.splitAmountMinor(30000, 3), remainder: RebootBudgetEngine.splitAmountMinor(2800, 3) }));
  if (engineSplits.exact.join(',') !== '10000,10000,10000' || engineSplits.remainder.join(',') !== '933,933,934') throw new Error(`Weekly split must preserve every cent: ${JSON.stringify(engineSplits)}`);
  console.log('PASS weekly allocation engine preserves exact totals and assigns the remainder to the final week');

  await page.evaluate(async () => {
    const now = new Date(), currentDay = now.getDay();
    await RebootSecureStorage.save('reboot-local-v1', { householdName: 'Notre foyer', configured: true, baseWeeklyBudgetMinor: 10000, weeklyBudgetMinor: 10000, rebootDay: currentDay, expenses: [], refunds: [], reserves: [], reserveTransfers: [], importedBankOperations: [], weeklyCycles: [], allocations: [], auditEvents: [], backupStatus: {}, onboarding: null });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseAmount').fill('28'); await page.locator('#expenseLabel').fill('Achat étalé'); await page.locator('input[name="spreadMode"][value="spread"]').check(); await page.locator('#spreadWeeks').selectOption('3');
  await assertContains(page.locator('#spreadPreview'), '9,33'); await assertContains(page.locator('#spreadPreview'), '9,34');
  await page.locator('#saveExpenseButton').click(); await page.locator('#expenseDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#remaining'), '90,67'); await assertContains(page.locator('#futureCommitmentList'), '9,34');
  const storedSpread = await page.evaluate(async () => { const saved = await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'); return { expenses: saved.expenses.filter(item => !item.deletedAt && item.label === 'Achat étalé'), allocations: saved.allocations.filter(item => !item.deletedAt && saved.expenses.find(expense => expense.id === item.transactionId)?.label === 'Achat étalé') }; });
  if (storedSpread.expenses.length !== 1 || storedSpread.expenses[0].amountMinor !== 2800 || storedSpread.allocations.map(item => item.amountMinor).join(',') !== '933,933,934') throw new Error('A spread expense must remain one real transaction with exact weekly allocations');
  await page.locator('#expenseList article', { hasText: 'Achat étalé' }).locator('[data-edit-expense]').click();
  if (await page.locator('#expenseAmount').isEnabled() || await page.locator('#expenseDate').isEnabled()) throw new Error('An existing spread must require delete-and-recreate for structural changes');
  await assertContains(page.locator('#spreadLock'), 'supprimez la dépense puis recréez-la'); await page.locator('#expenseDialog .close-button').click();
  await page.locator('#addExpenseButton').click(); await page.locator('#expenseAmount').fill('180'); await page.locator('#expenseLabel').fill('Engagement dangereux'); await page.locator('input[name="spreadMode"][value="spread"]').check(); await page.locator('#spreadWeeks').selectOption('2');
  await assertContains(page.locator('#spreadPreview'), 'réservera'); await assertContains(page.locator('#saveExpenseButton'), 'Confirmer quand même'); await page.locator('#expenseDialog .close-button').click();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#expenseList article', { hasText: 'Achat étalé' }).locator('[data-delete]').click();
  const deletedSpread = await page.evaluate(async () => { const saved = await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'), expense = saved.expenses.find(item => item.label === 'Achat étalé'); return { expenseDeleted: Boolean(expense.deletedAt), allocationsDeleted: saved.allocations.filter(item => item.transactionId === expense.id).every(item => item.deletedAt) }; });
  if (!deletedSpread.expenseDeleted || !deletedSpread.allocationsDeleted) throw new Error('Deleting a spread must tombstone its transaction and every allocation');
  console.log('PASS manual spread previews cents, affects only the current allocation, warns, locks structural edits and deletes atomically');

  await page.goto(`${baseUrl}/verifier.html`, { waitUntil: 'networkidle' });
  const spreadImportDate = new Date(), spreadImportDateText = `${String(spreadImportDate.getDate()).padStart(2, '0')}/${String(spreadImportDate.getMonth() + 1).padStart(2, '0')}/${spreadImportDate.getFullYear()}`;
  await page.locator('#csvFile').setInputFiles({ name: 'etalement.csv', mimeType: 'text/csv', buffer: Buffer.from(`Date;Libellé;Montant\n${spreadImportDateText};Achat bancaire étalé;-28\n`) });
  await page.locator('#importButton').click(); const importRow = page.locator('.operation', { hasText: 'Achat bancaire étalé' }); await importRow.locator('[data-action="spread"]').click(); await page.locator('#spreadImportWeeks').selectOption('3'); await page.locator('#spreadImportSave').click();
  const importedSpread = await page.evaluate(async () => { const saved = await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'), operation = saved.importedBankOperations.find(item => item.label === 'Achat bancaire étalé'), expense = saved.expenses.find(item => item.importedOperationId === operation.id); return { operationAmount: operation.amountMinor, operationDate: operation.date, expenseAmount: expense.amountMinor, allocations: saved.allocations.filter(item => item.transactionId === expense.id && !item.deletedAt).map(item => item.amountMinor) }; });
  if (importedSpread.operationAmount !== -2800 || importedSpread.operationDate !== `${spreadImportDate.getFullYear()}-${String(spreadImportDate.getMonth() + 1).padStart(2, '0')}-${String(spreadImportDate.getDate()).padStart(2, '0')}` || importedSpread.expenseAmount !== 2800 || importedSpread.allocations.join(',') !== '933,933,934') throw new Error('Imported spread must not alter the original bank operation');
  console.log('PASS an imported bank operation can be spread without changing its original date or amount');

  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const saved = await RebootSecureStorage.read('reboot-local-v1', 'reboot-local-v1'), engine = RebootBudgetEngine, current = engine.cycleStartForDate(engine.dateKey(new Date()), saved.rebootDay), starts = [-21, -14, -7, 0].map(days => engine.addDays(current, days)), budgets = [18000, 22000, 10000, 99900], now = new Date().toISOString();
    saved.expenses = [{ id: 'tracking-spread', date: starts[0], amountMinor: 30000, label: 'Dépense suivie étalée', funding: 'weekly', createdAt: now }, { id: 'tracking-extra-1', date: starts[0], amountMinor: 6000, label: 'Complément 1', funding: 'weekly', createdAt: now }, { id: 'tracking-extra-2', date: starts[1], amountMinor: 16000, label: 'Complément 2', funding: 'weekly', createdAt: now }, { id: 'tracking-current', date: starts[3], amountMinor: 99900, label: 'Cycle courant exclu', funding: 'weekly', createdAt: now }];
    saved.refunds = [{ id: 'tracking-refund', date: starts[2], amountMinor: 1500, label: 'Correction', applyToBudget: true, health: false, createdAt: now }];
    saved.weeklyCycles = starts.map((startDate, index) => ({ id: engine.cycleIdForStart(startDate), startDate, endDate: engine.addDays(startDate, 6), budgetMinor: budgets[index], status: index === 3 ? 'open' : 'closed', isExceptional: false, createdAt: now, closedAt: index === 3 ? '' : now }));
    saved.allocations = starts.slice(0, 3).map((cycleStart, index) => ({ id: `tracking-spread-${index}`, transactionId: 'tracking-spread', cycleId: engine.cycleIdForStart(cycleStart), cycleStart, amountMinor: 10000, sequence: index + 1, sequenceCount: 3, createdAt: now }));
    [['tracking-extra-1', starts[0], 6000], ['tracking-extra-2', starts[1], 16000], ['tracking-current', starts[3], 99900]].forEach(([transactionId, cycleStart, amountMinor], index) => saved.allocations.push({ id: `tracking-extra-allocation-${index}`, transactionId, cycleId: engine.cycleIdForStart(cycleStart), cycleStart, amountMinor, sequence: 1, sequenceCount: 1, createdAt: now }));
    await RebootSecureStorage.save('reboot-local-v1', saved);
  });
  await page.reload({ waitUntil: 'networkidle' }); await page.goto(`${baseUrl}/app.html#tracking`, { waitUntil: 'networkidle' });
  const trackingText = (await page.locator('#trackingView').innerText()).replace(/\s/g, ' ');
  for (const expected of ['180,00', '220,00', '+ 20,00', '− 40,00', '+ 15,00', '− 5,00']) if (!trackingText.includes(expected)) throw new Error(`Tracking must retain historical budgets and signed totals: missing ${expected}`);
  if (trackingText.includes('999,00')) throw new Error('The current open cycle must be excluded from tracking');
  if ((await page.locator('[data-tracking-weeks]').count()) !== 5) throw new Error('Tracking must expose 4, 8, 16, 32 and 52 week filters');
  console.log('PASS tracking excludes the current week, preserves historical budgets and totals signed gains and overages');

  await page.evaluate(async () => {
    localStorage.removeItem('reboot-drive-config-v2');
    localStorage.removeItem('reboot-drive-config-v1');
    await RebootSecureStorage.save('reboot-local-v1', { householdName: 'Notre foyer', configured: true, baseWeeklyBudgetMinor: 60000, weeklyBudgetMinor: 60000, rebootDay: 6, expenses: [], refunds: [], reserves: [], reserveTransfers: [], importedBankOperations: [], auditEvents: [], backupStatus: {}, onboarding: null });
    await RebootSecureStorage.save('reboot-calculator-v1', {
      mode: 'manual', step: 2, groups: [], annual: [], updatedAt: new Date().toISOString(), manualMonthly: [
        { name: 'Amazon Prime', type: 'charge', amount: 70, frequency: 'annual', endsOn: '', templateKey: 'charge|ABONNEMENT NUMERIQUE' },
        { name: 'Spotify', type: 'charge', amount: 21, frequency: 'monthly', endsOn: '', templateKey: 'charge|ABONNEMENT NUMERIQUE' },
        { name: 'Assurance annuelle', type: 'charge', amount: 120, frequency: 'annual', endsOn: '', templateKey: 'charge|ASSURANCE' },
        { name: 'Prime annuelle', type: 'income', amount: 1200, frequency: 'annual', endsOn: '', templateKey: 'income|PRIME' }
      ]
    });
  });
  await page.goto(`${baseUrl}/app.html?test=annual-frequency#charges`, { waitUntil: 'networkidle' });
  const recurringLines = (await page.locator('#chargeList').innerText()).replace(/\s/g, ' ');
  await assertContains(page.locator('#chargeList'), 'Abonnement Numerique');
  await assertContains(page.locator('#chargeList'), 'Assurance');
  for (const value of ['5,83 € / mois', '70,00 € / an', '21,00 € / mois', '252,00 € / an']) if (!recurringLines.includes(value)) throw new Error(`Unexpected recurring amount display: ${value}; actual: ${recurringLines}`);
  await assertContains(page.locator('#monthlyChargesTotal'), '36,83');
  await assertContains(page.locator('#monthlyIncomeTotal'), '100,00');
  await page.locator('[data-edit-charge="manual|0"]').click();
  await page.locator('#chargeFrequency').selectOption('monthly');
  await assertContains(page.locator('#chargeFrequencyEquivalent'), '840,00');
  await page.locator('#chargeForm button[value="default"]').click();
  await page.locator('[data-edit-charge="manual|1"]').click();
  await page.locator('#chargeFrequency').selectOption('annual');
  await assertContains(page.locator('#chargeFrequencyEquivalent'), '1,75');
  await page.locator('#chargeForm button[value="default"]').click();
  await page.reload({ waitUntil: 'networkidle' });
  const storedFrequencies = await page.evaluate(async () => (await RebootSecureStorage.read('reboot-calculator-v1', 'reboot-site-v02')).manualMonthly.map(entry => entry.frequency));
  if (storedFrequencies[0] !== 'monthly' || storedFrequencies[1] !== 'annual') throw new Error('Editing a recurring line must retain its original amount and selected frequency');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-remove-charge="manual|2"]').click();
  await page.waitForFunction(() => !document.querySelector('#chargeList')?.textContent?.includes('Assurance annuelle'));
  console.log('PASS annual and monthly recurring lines retain their frequency, show their conversion and update the monthly average');
} finally {
  await browser.close();
}
