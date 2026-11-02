import { app, net } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigTestResult, ServerConfig } from '@shared/ipc'
import { validateServerConfig } from './validation'

/**
 * Supabase connection settings. The project URL and the anon/publishable key
 * are public by design (Row Level Security protects the data), so they may be
 * baked in at build time (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).
 * Copies set up before the web version keep a configuration saved in the
 * user-data folder. Privileged keys
 * are never accepted here.
 */
const configPath = () => join(app.getPath('userData'), 'server-config.json')

function normalizeUrl(url: string): string {
  return new URL(url).origin
}

export function loadServerConfig(): ServerConfig | null {
  try {
    if (existsSync(configPath())) {
      const saved = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<ServerConfig>
      if (saved.supabaseUrl && saved.supabaseAnonKey && !validateServerConfig(saved.supabaseUrl, saved.supabaseAnonKey)) {
        return { supabaseUrl: normalizeUrl(saved.supabaseUrl), supabaseAnonKey: saved.supabaseAnonKey, source: 'saved' }
      }
    }
  } catch {
    // Corrupt file: fall through to the build-time defaults.
  }
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
  if (url && key && !validateServerConfig(url, key)) {
    return { supabaseUrl: normalizeUrl(url), supabaseAnonKey: key, source: 'build' }
  }
  return null
}

export async function testServerConfig(url: string, anonKey: string): Promise<ConfigTestResult> {
  const invalid = validateServerConfig(url, anonKey)
  if (invalid) return { ok: false, message: invalid }
  try {
    const res = await net.fetch(`${normalizeUrl(url)}/auth/v1/settings`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (res.ok) return { ok: true, message: 'Connected.' }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The server rejected this key.' }
    return { ok: false, message: `The server answered with status ${res.status}.` }
  } catch {
    return { ok: false, message: 'Could not reach the server. Check the URL and your internet connection.' }
  }
}

export async function saveServerConfig(url: string, anonKey: string): Promise<ConfigTestResult> {
  const result = await testServerConfig(url, anonKey)
  if (!result.ok) return result
  writeFileSync(configPath(), JSON.stringify({ supabaseUrl: normalizeUrl(url), supabaseAnonKey: anonKey }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
  return result
}

export function clearServerConfig(): void {
  try {
    writeFileSync(configPath(), '{}', 'utf8')
  } catch {
    // Nothing saved.
  }
}
