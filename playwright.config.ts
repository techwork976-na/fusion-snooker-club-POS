import { defineConfig } from '@playwright/test'

/**
 * `npm run test:e2e` builds dist/e2e and out/ first (scripts/build-e2e.mjs).
 * The web suite runs in the installed Google Chrome (set FUSION_E2E_CHANNEL=msedge
 * for Microsoft Edge) against `vite preview`, which sends Vercel's headers.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'web', testMatch: /app\.spec\.ts/ },
    { name: 'desktop', testMatch: /desktop\.spec\.ts/ }
  ],
  webServer: {
    command: 'npx vite preview --config vite.web.config.ts --mode e2e --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54329',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-anon-key-for-local-e2e-only'
    }
  }
})
