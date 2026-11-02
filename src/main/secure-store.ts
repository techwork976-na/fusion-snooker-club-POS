import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Encrypted key/value store for the Supabase auth session. Values are
 * encrypted with the OS keychain (DPAPI on Windows) before touching disk. If
 * encryption is unavailable the session is kept in memory only, so a
 * plaintext token is never written.
 */
const KEY_PATTERN = /^(sb-[a-z0-9-]{1,80}|fusion\.[a-z0-9.-]{1,60})$/
const MAX_VALUE_BYTES = 128 * 1024

const memory = new Map<string, string>()
const filePath = () => join(app.getPath('userData'), 'secure-store.json')

function readAll(): Record<string, string> {
  try {
    return existsSync(filePath()) ? (JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, string>) {
  writeFileSync(filePath(), JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
}

export function isValidStoreKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key)
}

export function isValidStoreValue(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_VALUE_BYTES
}

export function storeGet(key: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return memory.get(key) ?? null
  const encrypted = readAll()[key]
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
}

export function storeSet(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    memory.set(key, value)
    return
  }
  const data = readAll()
  data[key] = safeStorage.encryptString(value).toString('base64')
  writeAll(data)
}

export function storeRemove(key: string): void {
  memory.delete(key)
  const data = readAll()
  if (key in data) {
    delete data[key]
    writeAll(data)
  }
}
