import { app, BrowserWindow, ipcMain, Menu, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { printOptionsSchema, receiptSchema } from '@shared/receipt'
import icon from '../../build/icon.png?asset'
import { clearServerConfig, loadServerConfig, saveServerConfig, testServerConfig } from './config'
import { listPrinters, printReceipt } from './printing'
import { APP_ORIGIN, applyDevCsp, registerPrivilegedScheme, serveRenderer } from './protocol'
import { isValidStoreKey, isValidStoreValue, storeGet, storeRemove, storeSet } from './secure-store'

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined

// Unpackaged builds only: lets automated tests use an isolated profile.
if (!app.isPackaged && process.env['FUSION_USER_DATA_DIR']) {
  app.setPath('userData', process.env['FUSION_USER_DATA_DIR'])
}
const trustedOrigins = new Set([APP_ORIGIN, ...(devUrl ? [new URL(devUrl).origin] : [])])


let mainWindow: BrowserWindow | null = null

registerPrivilegedScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

/** scheme://host — WHATWG URL reports custom-scheme origins as "null". */
function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.host ? `${u.protocol}//${u.host}` : null
  } catch {
    return null
  }
}

/** Only the main window's own top-level page may use the bridge. */
function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false
  const frame = event.senderFrame
  if (!frame || frame.parent) return false
  const origin = originOf(frame.url)
  return origin !== null && trustedOrigins.has(origin)
}

function handle<A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Blocked: untrusted sender')
    return fn(event, ...(args as A))
  })
}

function on(channel: string, fn: (event: IpcMainEvent) => void) {
  ipcMain.on(channel, (event) => {
    if (trusted(event)) fn(event)
  })
}

function registerIpc() {
  on(IPC.windowMinimize, () => mainWindow?.minimize())
  on(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  on(IPC.windowClose, () => mainWindow?.close())
  handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)

  handle(IPC.configGet, () => loadServerConfig())
  handle(IPC.configTest, (_e, url: unknown, key: unknown) =>
    typeof url === 'string' && typeof key === 'string'
      ? testServerConfig(url.trim(), key.trim())
      : { ok: false, message: 'Invalid input.' }
  )
  handle(IPC.configSave, (_e, url: unknown, key: unknown) =>
    typeof url === 'string' && typeof key === 'string'
      ? saveServerConfig(url.trim(), key.trim())
      : { ok: false, message: 'Invalid input.' }
  )
  handle(IPC.configClear, () => clearServerConfig())

  handle(IPC.storeGet, (_e, key: unknown) => (isValidStoreKey(key) ? storeGet(key) : null))
  handle(IPC.storeSet, (_e, key: unknown, value: unknown) => {
    if (!isValidStoreKey(key) || !isValidStoreValue(value)) throw new Error('Invalid secure-store write')
    storeSet(key, value)
  })
  handle(IPC.storeRemove, (_e, key: unknown) => {
    if (isValidStoreKey(key)) storeRemove(key)
  })

  handle(IPC.printReceipt, async (_e, receipt: unknown, options: unknown) => {
    const r = receiptSchema.safeParse(receipt)
    const o = printOptionsSchema.safeParse(options ?? {})
    if (!r.success || !o.success) return { ok: false, error: 'The receipt data was rejected.' }
    return printReceipt(r.data, o.data)
  })
  handle(IPC.listPrinters, (e) => listPrinters(e.sender))
  handle(IPC.appInfo, () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged }))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    frame: false,
    show: false,
    title: 'FUSION',
    backgroundColor: '#0c0f0e',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })
  const sendMaximized = () => mainWindow?.webContents.send(IPC.windowMaximizedChanged, mainWindow.isMaximized())
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
}

// Lock down every web contents: no navigation away from the app, no popups,
// no <webview>, and only https links may open in the system browser.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const origin = originOf(url)
    if (!origin || !trustedOrigins.has(origin)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  if (devUrl) applyDevCsp(devUrl)
  else serveRenderer(join(__dirname, '../renderer'))
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
