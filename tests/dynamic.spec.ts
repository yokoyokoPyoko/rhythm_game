import { test, expect } from '@playwright/test';
test('dynamic video smoke test', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(2000);
});
