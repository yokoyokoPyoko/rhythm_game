import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './recordings',
  use: {
    baseURL: process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/',
    headless: true,
    browserName: 'chromium',
    video: 'on',
  },
});