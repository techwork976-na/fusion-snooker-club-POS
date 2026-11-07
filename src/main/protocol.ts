import { protocol, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { loadServerConfig } from './config'

/**
 * The production renderer is served from a private `app://fusion` origin
 * instead of file://. That gives the page a real origin and lets every
 * response carry a strict Content-Security-Policy whose connect-src allows
 * only this app and the configured Supabase project.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'fusion'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

export function buildCsp(dev: boolean): string {
  const connect = ["'self'"]
  const images = ["'self'", 'data:', 'blob:']
  const config = loadServerConfig()
  if (config) {
    const url = new URL(config.supabaseUrl)
    connect.push(url.origin, `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`)
    // Profile pictures (Supabase Storage).
    images.push(url.origin)
  }
  if (dev) connect.push('ws://localhost:*', 'http://localhost:*')
  return [
    "default-src 'self'",
    // Vite's React refresh preamble is an inline script in development only.
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${images.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

export function serveRenderer(rendererRoot: string): void {
  const root = normalize(rendererRoot)
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const filePath = normalize(join(root, pathname))
    if (!filePath.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
    try {
      const body = await readFile(filePath)
      return new Response(body, {
        headers: {
          'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': buildCsp(false),
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** In development the Vite server serves the page; add the CSP header to it. */
export function applyDevCsp(devUrl: string): void {
  const origin = new URL(devUrl).origin
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(origin)) return callback({ responseHeaders: details.responseHeaders })
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(true)] }
    })
  })
}
