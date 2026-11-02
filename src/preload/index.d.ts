import type { FusionBridge } from '@shared/ipc'

declare global {
  interface Window {
    fusion: FusionBridge
  }
}

export {}
