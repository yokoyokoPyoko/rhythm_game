import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/rhythm_game/',
  build: { outDir: 'docs', emptyOutDir: true },
  plugins: [react()],
})