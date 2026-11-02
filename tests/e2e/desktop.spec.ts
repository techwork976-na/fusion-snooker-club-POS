/**
 * Smoke test for the optional Windows desktop build (out/): the same renderer
 * inside a hardened Electron window, configured at build time — no Connect
 * screen. The full feature suite runs against the web build (app.spec.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { E2E, FakeSupabase } from './fake-supabase'

test.describe.configure({ mode: 'serial' })

let fake: FakeSupabase
let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  fake = await FakeSupabase.start(E2E.supabasePort)
  await fake.exclusive(() => fake.addUser('owner', 'owner-pass-123', 'admin'))
  userData = mkdtempSync(join(tmpdir(), 'fusion-e2e-'))
  const env: NodeJS.ProcessEnv = { ...process.env, FUSION_USER_DATA_DIR: userData }
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..', '..'), env: env as Record<string, string> })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await fake?.stop()
  rmSync(userData, { recursive: true, force: true })
})

test('secure window: frameless, isolated renderer, minimal bridge', async () => {
  const win = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    const prefs = (w.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences | null }).getLastWebPreferences()
    return { url: w.webContents.getURL(), contextIsolation: prefs?.contextIsolation, nodeIntegration: prefs?.nodeIntegration, sandbox: prefs?.sandbox }
  })
  expect(win.url.startsWith('app://fusion/')).toBe(true)
  expect(win).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  const renderer = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys(window.fusion).sort()
  }))
  expect(renderer).toEqual({ require: 'undefined', process: 'undefined', bridge: ['app', 'config', 'printer', 'secureStore', 'window'] })
  // The secure store only accepts its own keys.
  const rejected = await page.evaluate(() => window.fusion.secureStore.set('../../evil', 'x').then(() => 'stored', () => 'rejected'))
  expect(rejected).toBe('rejected')
})

test('opens straight to sign-in with the built-in server settings', async () => {
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/server connection/i)).toHaveCount(0)
  await page.getByTestId('login-username').fill('owner')
  await page.getByTestId('login-password').fill('owner-pass-123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('today-sales')).toBeVisible()
})

test('window controls minimise, maximise and close the app', async () => {
  await page.getByTestId('win-minimize').click()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore())
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())
  await page.getByTestId('win-maximize').click()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(!before)
  const closed = app.waitForEvent('close')
  await page.getByTestId('win-close').click()
  await closed
})
