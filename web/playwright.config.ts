import { defineConfig } from '@playwright/test'

const PORT = 8549
const baseURL = process.env.SIRGIT_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL },
  webServer: process.env.SIRGIT_URL
    ? undefined
    : {
        command: `cargo run --quiet --manifest-path ../server/Cargo.toml -- --no-open -p ${PORT}`,
        url: `http://127.0.0.1:${PORT}/api/version`,
        reuseExistingServer: true,
        timeout: 60_000,
      },
})
