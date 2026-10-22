// T-096 REQ-UI-003 REQ-SEC-001 — runs once before the locale projects: signs in every seeded password user so the
// first-use password update a temporary credential triggers completes before parallel workers share the account.
// Without it, a freshly imported realm fails the concurrent sign-ins with "invalid username or password" while one
// worker is still on the update-password step.
import { test as setup } from '@playwright/test';
import { seededUsers, signIn } from './auth';

setup('seeded users complete their first sign-in', async ({ browser }) => {
  for (const user of seededUsers()) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/en');
    await signIn(page, 'en', user.username);
    await context.close();
  }
});
