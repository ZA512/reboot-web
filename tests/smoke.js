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
  if (!(await page.evaluate(() => Boolean(window.crypto?.subtle)))) throw new Error('Web Crypto is unavailable in the Docker browser context');
  await page.locator('#welcomeDialog').waitFor({ state: 'visible' });
  console.log('PASS first visit offers a clear starting choice');

  await page.locator('#startLocalButton').click();
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

  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseDialog').locator('.close-button').click();
  await page.locator('#expenseDialog').waitFor({ state: 'hidden' });
  console.log('PASS empty expense dialog closes');
  await page.reload({ waitUntil: 'networkidle' });
  await assertContains(page.locator('#budgetTotal'), '571,15');
  await assertContains(page.locator('#reserveList'), 'Noël & anniversaires');
  console.log('PASS encrypted local state survives reload');

  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseAmount').fill('25');
  await page.locator('#expenseLabel').fill('Test correction');
  await page.locator('#saveExpenseButton').click();
  await page.locator('[data-edit-expense]').click();
  await page.locator('#expenseAmount').fill('30');
  await page.locator('#expenseNature').selectOption('necessary');
  await page.locator('#expenseHealth').check();
  await page.locator('#saveExpenseButton').click();
  await page.locator('#expenseDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#remaining'), '541,15');
  await assertContains(page.locator('#expenseList'), 'Nécessaire');
  await assertContains(page.locator('#expenseList'), 'Santé');
  await page.locator('[data-delete]').click();
  await assertContains(page.locator('#remaining'), '571,15');
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseAmount').fill('50');
  await page.locator('#expenseLabel').fill('Assurance réglée');
  await page.locator('input[name="funding"][value="annualized"]').check();
  await page.locator('#saveExpenseButton').click();
  await assertContains(page.locator('#remaining'), '571,15');
  await page.locator('[data-delete]').click();
  await page.locator('#addRefundButton').click();
  await page.locator('#refundAmount').fill('15');
  await page.locator('#refundLabel').fill('Remboursement mutuelle');
  await page.locator('#refundForm button[value="default"]').click();
  await assertContains(page.locator('#remaining'), '586,15');
  await page.locator('[data-delete-refund]').click();
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
  await page.locator('#addReserveButton').click();
  await page.locator('#reserveName').fill('Nouveau canapé');
  await page.locator('input[name="reserveKind"][value="goal"]').check();
  await page.locator('#reserveBalance').fill('200');
  await page.locator('#reserveMonthly').fill('100');
  await page.locator('#reserveTarget').fill('1000');
  await page.locator('#saveReserveButton').click();
  await page.locator('#reserveDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#reserveList'), 'Projet temporaire');
  await assertContains(page.locator('#budgetTotal'), '548,07');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-close-reserve]').click();
  await assertContains(page.locator('#budgetTotal'), '571,15');
  console.log('PASS expenses and reserves can be corrected without re-entry');

  await page.goto(`${baseUrl}/historique.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#list')?.textContent?.includes('Test correction'));
  await assertContains(page.locator('#list'), 'Test correction');
  await assertContains(page.locator('#list'), 'Modifié');
  console.log('PASS correction history remains readable locally');

  await page.goto(`${baseUrl}/sauvegarde.html`, { waitUntil: 'networkidle' });
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
  if (await page.locator('#welcomeDialog .welcome-option').count() !== 3) throw new Error('New users need distinct local, Drive creation, and Drive recovery choices');
  await assertContains(page.locator('#welcomeDialog'), 'J’ai déjà un budget Google Drive');
  await page.goto(`${baseUrl}/sauvegarde.html`, { waitUntil: 'networkidle' });
  await page.locator('#archiveFile').setInputFiles(backupPath);
  await page.locator('#restoreCode').fill('REBOOT-test-code-2026');
  await page.locator('#checkArchive').click();
  await page.locator('#archiveSummary').waitFor({ state: 'visible' });
  await assertContains(page.locator('#archiveSummary'), '2 réserve');
  await page.locator('#restoreAcknowledgement').check();
  await page.locator('#restoreArchive').click();
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  await assertContains(page.locator('#budgetTotal'), '571,15');
  console.log('PASS encrypted archive restores daily data only after confirmation');

  await page.goto(`${baseUrl}/drive.html?action=restore`, { waitUntil: 'networkidle' });
  await assertContains(page.locator('#driveTitle'), 'Retrouvez votre budget');
  if (await page.locator('#syncArea').isVisible()) throw new Error('Restore flow must not offer archive creation or synchronization');
  await page.locator('#securityProtected').check();
  await page.locator('#recoveryCode').waitFor({ state: 'visible' });
  if (!(await page.locator('#recoveryCode').getAttribute('placeholder'))?.includes('Collez') || await page.locator('#generateCode').isVisible()) throw new Error('Restore flow must ask for the existing code without proposing a new one');
  await page.goto(`${baseUrl}/drive.html`, { waitUntil: 'networkidle' });
  const publicClientId = await page.evaluate(() => RebootDrive.config().clientId);
  if (!publicClientId.endsWith('.apps.googleusercontent.com')) throw new Error('Google Drive must use the public site Client ID without asking each user');
  if (await page.locator('#recoveryCode').isVisible()) throw new Error('Security code should only appear after the user chooses protection');
  await page.locator('#securityProtected').check();
  await page.locator('#recoveryCode').waitFor({ state: 'visible' });
  await page.locator('#generateCode').click();
  const generatedCode = await page.locator('#recoveryCode').inputValue();
  if (generatedCode.length < 16 || await page.locator('#downloadCode').isHidden()) throw new Error('Protected Drive mode must generate a downloadable recovery code');
  if (await page.locator('#download').isVisible()) throw new Error('Full restore must remain an advanced option, not compete with normal synchronization');
  await page.locator('#restoreDetails').click();
  await page.locator('#download').waitFor({ state: 'visible' });
  const plainArchive = await page.evaluate(async () => {
    const text = await RebootArchive.create('', { encrypted: false });
    return { archive: JSON.parse(text), payload: await RebootArchive.open(text, '') };
  });
  if (plainArchive.archive.format !== 'reboot-plain-archive' || !plainArchive.payload.states) throw new Error('Simple Drive mode must create a readable archive');
  const mergedStates = await page.evaluate(() => RebootDrive.mergeStates(
    { daily: { updatedAt: '2026-08-01T10:00:00.000Z', expenses: [{ id: 'shared', amountMinor: 100, updatedAt: '2026-08-01T10:00:00.000Z' }], reserves: [{ id: 'local', name: 'Canapé', updatedAt: '2026-08-01T10:00:00.000Z' }] }, calculator: { updatedAt: '2026-08-01T10:00:00.000Z', manualMonthly: [{ name: 'Local' }] } },
    { daily: { updatedAt: '2026-08-02T10:00:00.000Z', expenses: [{ id: 'shared', amountMinor: 200, updatedAt: '2026-08-02T10:00:00.000Z' }, { id: 'remote', amountMinor: 300, updatedAt: '2026-08-02T10:00:00.000Z' }], refunds: [{ id: 'refund', amountMinor: 50, createdAt: '2026-08-02T10:00:00.000Z' }] }, calculator: { updatedAt: '2026-08-02T10:00:00.000Z', manualMonthly: [{ name: 'Distant' }] } }
  ));
  if (mergedStates.daily.expenses.length !== 2 || mergedStates.daily.expenses.find(expense => expense.id === 'shared')?.amountMinor !== 200 || mergedStates.daily.reserves.length !== 1 || mergedStates.daily.refunds.length !== 1 || mergedStates.calculator.manualMonthly[0].name !== 'Distant') throw new Error('Multi-device state merge must preserve independent entries and newest edits');
  console.log('PASS Google Drive uses the public site Client ID');

  await page.goto(`${baseUrl}/calculateur.html`, { waitUntil: 'networkidle' });
  await page.locator('input[name="mode"][value="manual"]').check();
  await page.locator('#next').click();
  await page.locator('#addManual').click();
  await page.locator('[data-manual="0|name"]').fill('Salaire');
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
  for (let step = 0; step < 6; step += 1) await page.locator('#next').click();
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

  await page.goto(`${baseUrl}/sauvegarde.html`, { waitUntil: 'networkidle' });
  await page.locator('#backupCode').fill('REBOOT-calculator-code-2026');
  await page.locator('#backupCodeConfirm').fill('REBOOT-calculator-code-2026');
  await page.locator('#backupAcknowledgement').check();
  const calculatorBackupPromise = page.waitForEvent('download');
  await page.locator('#createBackup').click();
  const calculatorBackup = await calculatorBackupPromise;
  const calculatorBackupPath = await calculatorBackup.path();
  if (!calculatorBackupPath) throw new Error('Calculator backup was not downloaded');
  await page.evaluate(() => RebootSecureStorage.clear('reboot-calculator-v1', 'reboot-site-v02'));
  await page.locator('#archiveFile').setInputFiles(calculatorBackupPath);
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
    buffer: Buffer.from('Date;Libellé;Montant\n05/06/2026;Salaire;3000\n05/07/2026;Salaire;3000\n03/06/2026;Loyer;-1000\n03/07/2026;Loyer;-1000\n')
  });
  await page.locator('#next').click();
  await page.locator('#next').click();
  await page.locator('select[data-group="g0|category"]').selectOption('salary');
  await page.locator('input[data-group="g0|confirmed"]').check();
  await page.locator('select[data-group="g1|category"]').selectOption('charge_monthly');
  await page.locator('input[data-group="g1|confirmed"]').check();
  await page.locator('#back').click();
  await page.locator('#back').click();
  await page.locator('#csvFile').setInputFiles({
    name: 'releve-mis-a-jour.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date;Libellé;Montant\n05/08/2026;Salaire;3000\n05/09/2026;Salaire;3000\n03/08/2026;Loyer;-1200\n03/09/2026;Loyer;-1200\n')
  });
  await page.locator('#next').click();
  await page.locator('#next').click();
  await assertContains(page.locator('select[data-group="g1|category"]').locator('xpath=ancestor::div[contains(@class,"group-card")]'), 'Montant à vérifier');
  await page.locator('[data-apply-observed="g1"]').click();
  if ((await page.locator('input[data-group="g1|acceptedAmount"]').inputValue()) !== '1200.00') throw new Error('Updated CSV amount was not adopted');
  console.log('PASS CSV reimport keeps classifications and proposes changed amounts');

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
} finally {
  await browser.close();
}
