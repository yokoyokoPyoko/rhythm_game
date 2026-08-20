import { test, expect } from '@playwright/test';
test('dynamic video test', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(2000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(2000);
});
