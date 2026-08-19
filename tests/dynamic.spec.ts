import { test, expect } from '@playwright/test';
test('fallback smoke test', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(1000);
  for (let i = 1; i <= 5; i++) {
    await page.screenshot({ path: `screenshots/frame_${i}.png` });
    await page.waitForTimeout(500);
  }
});
