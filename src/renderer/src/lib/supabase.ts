import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isDesktop } from './platform'

let client: SupabaseClient | null = null

/**
 * In the desktop app, auth tokens are persisted through the main process,
 * encrypted with the OS keychain. In the browser, supabase-js keeps them in
 * this site's local storage (the page's strict Content-Security-Policy and the
 * fact that every request is still authorised by the database limit what that
 * exposure can lead to). The accounts kept for one-click switching are stored
 * the same way (lib/accounts.ts).
 */
const desktopStorage = {
  getItem: (key: string) => window.fusion.secureStore.get(key),
  setItem: (key: string, value: string) => window.fusion.secureStore.set(key, value),
  removeItem: (key: string) => window.fusion.secureStore.remove(key)
}

export function initSupabase(url: string, anonKey: string): SupabaseClient {
  client = createClient(url, anonKey, {
    auth: {
      storage: isDesktop ? desktopStorage : undefined,
      storageKey: 'sb-fusion-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    },
    global: { headers: { 'x-client-info': 'fusion-pos' } }
  })
  return client
}

export function supabase(): SupabaseClient {
  if (!client) throw new Error('Supabase is not initialised')
  return client
}
