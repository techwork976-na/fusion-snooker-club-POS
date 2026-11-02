import type { PrintOptions, Receipt } from './receipt'

/** Every channel the renderer may use. The main process rejects all others. */
export const IPC = {
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizedChanged: 'window:maximized-changed',
  configGet: 'config:get',
  configTest: 'config:test',
  configSave: 'config:save',
  configClear: 'config:clear',
  storeGet: 'secure-store:get',
  storeSet: 'secure-store:set',
  storeRemove: 'secure-store:remove',
  printReceipt: 'print:receipt',
  listPrinters: 'print:list-printers',
  appInfo: 'app:info'
} as const

export interface ServerConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  /** Where the configuration came from. */
  source: 'saved' | 'build'
}

export interface ConfigTestResult {
  ok: boolean
  message: string
}

export interface PrinterInfo {
  name: string
  displayName: string
  isDefault: boolean
}

export interface AppInfo {
  version: string
  platform: string
  packaged: boolean
}

/** The complete API exposed to the renderer as `window.fusion`. */
export interface FusionBridge {
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizedChange(listener: (maximized: boolean) => void): () => void
  }
  config: {
    get(): Promise<ServerConfig | null>
    test(url: string, anonKey: string): Promise<ConfigTestResult>
    save(url: string, anonKey: string): Promise<ConfigTestResult>
    clear(): Promise<void>
  }
  secureStore: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    remove(key: string): Promise<void>
  }
  printer: {
    printReceipt(receipt: Receipt, options: PrintOptions): Promise<{ ok: boolean; error?: string }>
    list(): Promise<PrinterInfo[]>
  }
  app: {
    info(): Promise<AppInfo>
  }
}
