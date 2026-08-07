import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();

async function assertContains(locator, expected) {
  const text = await locator.textContent();
  if (!text?.includes(expected)) throw new Error(`Expected "${expected}" in "${text}"`);
}

try {
  await page.goto(`${baseUrl}/app.html`, { waitUntil: 'networkidle' });
  if (!(await page.evaluate(() => Boolean(window.crypto?.subtle)))) throw new Error('Web Crypto is unavailable in the Docker browser context');
  await page.locator('#welcomeDialog').waitFor({ state: 'visible' });
  console.log('PASS first visit opens configuration');

  await page.locator('#startLocalButton').click();
  await page.locator('#settingsDialog').waitFor({ state: 'visible' });
  await page.locator('#weeklyBudget').fill('600');
  await page.locator('#rebootDay').selectOption('6');
  await page.locator('#settingsForm button[value="default"]').click();
  await page.locator('#settingsDialog').waitFor({ state: 'hidden' });
  await assertContains(page.locator('#budgetTotal'), '600,00');
  console.log('PASS budget and reboot day are saved');

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
} finally {
  await browser.close();
}
