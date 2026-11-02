#!/usr/bin/env node
// Builds the web app (dist/e2e) and the desktop app (out/) for the end-to-end
// tests, pointed at the local test server from tests/e2e/fake-supabase.ts.
// These builds contain only test values — never deploy them.
import { spawnSync } from 'node:child_process'
import { env, exit, platform } from 'node:process'

const testEnv = {
  ...env,
  VITE_SUPABASE_URL: 'http://127.0.0.1:54329',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'test-anon-key-for-local-e2e-only',
  VITE_SUPABASE_ANON_KEY: ''
}

for (const args of [
  ['vite', 'build', '--config', 'vite.web.config.ts', '--mode', 'e2e'],
  ['electron-vite', 'build']
]) {
  const result = spawnSync('npx', args, { stdio: 'inherit', env: testEnv, shell: platform === 'win32' })
  if (result.status !== 0) exit(result.status ?? 1)
}
