/**
 * Supabase connection validation, shared by the web build, the desktop app and
 * the build tooling (no Node or browser-only APIs). Only the public anon /
 * publishable key is ever accepted; secret keys are refused so they can never
 * be bundled into code that runs in a browser.
 */
const KEY_PATTERN = /^[A-Za-z0-9._-]{20,4096}$/

export function validateServerConfig(url: string, anonKey: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Enter the full project URL, e.g. https://abcd1234.supabase.co'
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    return 'The project URL must use https://'
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return 'Use the project URL only, without a path.'
  }
  if (!KEY_PATTERN.test(anonKey)) return 'The key does not look valid.'
  if (anonKey.startsWith('sb_secret_') || isServiceRoleJwt(anonKey)) {
    return 'That is a secret service key. Use the anon / publishable key instead — secret keys must never be put in the app.'
  }
  return null
}

export function isServiceRoleJwt(key: string): boolean {
  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { role?: string }
    return payload.role === 'service_role'
  } catch {
    return false
  }
}
