import { test, expect } from '@playwright/test';
test('dynamic video smoke test', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: 'screenshots/dyn_home.png' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.location.hash = '#/editor'; });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'screenshots/dyn_editor.png' });
});
