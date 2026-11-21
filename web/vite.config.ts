/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev server proxies to the Rust backend (cargo run in server/).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8449', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8449', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
