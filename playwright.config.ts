import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './recordings',
  use: {
    headless: true,
    browserName: 'chromium',
    video: 'on',
  },
});