import { defineConfig } from '@playwright/test';
import { Blob } from 'node:buffer';

if (typeof globalThis.File === 'undefined') {
  class FakeFile extends Blob {
    name: string;
    lastModified: number;
    buffer: Buffer;
    constructor(bits: any[], name: string, options: any = {}) {
      super(bits, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
      const chunks = bits.map(b => typeof b === 'string' ? Buffer.from(b) : Buffer.isBuffer(b) ? b : Buffer.from(b));
      this.buffer = Buffer.concat(chunks);
    }
    async arrayBuffer() {
      return this.buffer.buffer.slice(this.buffer.byteOffset, this.buffer.byteOffset + this.buffer.byteLength);
    }
    get size() {
      return this.buffer.length;
    }
    get webkitRelativePath() { return ''; }
  }
  globalThis.File = FakeFile as any;
}

export default defineConfig({
  testDir: './tests',
  outputDir: './recordings',
  use: {
    baseURL: process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/',
    headless: true,
    browserName: 'chromium',
    video: 'on',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/rhythm_game/',
    reuseExistingServer: true,
    timeout: 30000,
  },
  timeout: 45000,
});
