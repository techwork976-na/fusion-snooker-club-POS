/**
 * The web app (the product): a static single-page app built to dist/web and
 * served by Vercel. `npm run dev` / `npm run build` / `npm run preview`.
 *
 * The Supabase project URL and publishable key are read from the environment
 * at build time (`.env` locally, Project Settings → Environment Variables on
 * Vercel). A production build fails if they are missing — or if a secret key
 * was put there by mistake — so a misconfigured deployment never goes live.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { validateServerConfig } from './src/shared/serverConfig'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
const vercel = JSON.parse(readFileSync(resolve(__dirname, 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[]
}

/** The same security headers Vercel sends, so `npm run preview` behaves like production. */
function productionHeaders(supabaseUrl: string | undefined): Record<string, string> {
  const all = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? []
  const out: Record<string, string> = {}
  for (const { key, value } of all) {
    if (key === 'Strict-Transport-Security') continue
    let v = value.replace('; upgrade-insecure-requests', '')
    // A local test server (end-to-end tests) is not on *.supabase.co.
    if (key === 'Content-Security-Policy' && supabaseUrl?.startsWith('http://')) {
      const origin = new URL(supabaseUrl).origin
      v = v.replace('connect-src ', `connect-src ${origin} ${origin.replace('http://', 'ws://')} `)
      // Profile pictures are served by that server's Storage.
      v = v.replace('img-src ', `img-src ${origin} `)
    }
    out[key] = v
  }
  return out
}

/**
 * Production builds only: load public/runtime-guard.js before the app, so React
 * DevTools cannot attach and the browser console stays silent.
 */
function productionHardening(): Plugin {
  return {
    name: 'fusion-production-hardening',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'script', attrs: { src: '/runtime-guard.js' }, injectTo: 'head-prepend' }]
    }
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_')
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY
  if (command === 'build') {
    if (!url || !key) {
      throw new Error(
        'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set for a web build (in .env locally, or in Vercel → Settings → Environment Variables).'
      )
    }
    const invalid = validateServerConfig(url, key)
    if (invalid) throw new Error(`Supabase settings rejected: ${invalid}`)
  }

  return {
    root: resolve(__dirname, 'src/renderer'),
    envDir: __dirname,
    publicDir: resolve(__dirname, 'src/renderer/public'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react(), tailwindcss(), productionHardening()],
    build: {
      outDir: resolve(__dirname, mode === 'e2e' ? 'dist/e2e' : 'dist/web'),
      emptyOutDir: true,
      // No source maps: the original source is never published.
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rolldownOptions: {
        output: {
          // Minified, without console output or debugger statements.
          minify: { compress: { dropConsole: true, dropDebugger: true }, mangle: true },
          // Libraries change rarely: keep them in their own long-cached file so
          // an app update downloads only FUSION's own code. (The PDF libraries
          // stay separate and load only on export.)
          codeSplitting: {
            groups: [
              {
                name: 'vendor',
                test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@tanstack|@supabase|framer-motion|motion-dom|motion-utils|radix-ui|@radix-ui|@floating-ui|recharts|d3-[a-z]+|victory-vendor|lucide-react|zod)[\\/]/,
                priority: 10
              }
            ]
          }
        }
      }
    },
    server: { port: 5173 },
    preview: { port: 4173, strictPort: true, headers: productionHeaders(url) }
  }
})
