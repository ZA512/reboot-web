const ENTRY_DATABASE = 'reboot-local-v1';
const ENTRY_LEGACY_STORAGE_KEY = 'reboot-local-v1';

async function hasConfiguredLocalTracker() {
  const state = await RebootSecureStorage.read(ENTRY_DATABASE, ENTRY_LEGACY_STORAGE_KEY);
  return Number(state?.baseWeeklyBudgetMinor || state?.weeklyBudgetMinor) > 0
    && state.rebootDay !== null
    && state.rebootDay !== undefined
    && state.rebootDay !== '';
}

const METHOD_PREVIEW = new URLSearchParams(window.location.search).get('method') === '1';

if (!METHOD_PREVIEW) {
  hasConfiguredLocalTracker().then((configured) => {
    if (configured) window.location.replace('app.html');
  }).catch(() => {
    // An unreadable local store must never block access to the onboarding page.
  });
}
