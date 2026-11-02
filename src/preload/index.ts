import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type FusionBridge } from '@shared/ipc'

/**
 * The renderer's only door to the system: a fixed set of narrow functions.
 * No generic invoke/send, no Node APIs, no ipcRenderer object is exposed.
 */
const bridge: FusionBridge = {
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
    onMaximizedChange: (listener) => {
      const wrapped = (_e: IpcRendererEvent, maximized: unknown) => listener(Boolean(maximized))
      ipcRenderer.on(IPC.windowMaximizedChanged, wrapped)
      return () => ipcRenderer.removeListener(IPC.windowMaximizedChanged, wrapped)
    }
  },
  config: {
    get: () => ipcRenderer.invoke(IPC.configGet),
    test: (url, key) => ipcRenderer.invoke(IPC.configTest, String(url), String(key)),
    save: (url, key) => ipcRenderer.invoke(IPC.configSave, String(url), String(key)),
    clear: () => ipcRenderer.invoke(IPC.configClear)
  },
  secureStore: {
    get: (key) => ipcRenderer.invoke(IPC.storeGet, String(key)),
    set: (key, value) => ipcRenderer.invoke(IPC.storeSet, String(key), String(value)),
    remove: (key) => ipcRenderer.invoke(IPC.storeRemove, String(key))
  },
  printer: {
    printReceipt: (receipt, options) => ipcRenderer.invoke(IPC.printReceipt, receipt, options),
    list: () => ipcRenderer.invoke(IPC.listPrinters)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo)
  }
}

contextBridge.exposeInMainWorld('fusion', bridge)
