# FUSION security model

## Principles

1. **The database decides.** Route guards and hidden buttons in the app are convenience only. Every permission, floor restriction, discount right, archive and admin action is enforced again inside PostgreSQL.
2. **No privileged secret in the app.** The web app contains only the public Supabase URL and publishable/anon key (set as Vercel environment variables at build time; the build refuses secret keys). The service-role key lives in the Edge Function (injected by Supabase) and, temporarily, on the owner's machine for `npm run setup:admin` / `npm run reset:password`.
3. **Least privilege.** `anon` has no table or function access. `authenticated` can `SELECT` through RLS and execute an explicit allow-list of functions; all writes go through validated `SECURITY DEFINER` functions with `search_path = ''`.

## Authentication

- Supabase Auth (bcrypt). Staff sign in with a username, mapped to `<username>@fusion.local` (no emails are sent). Public sign-up is disabled in the project, there is no registration page and no demo account; a self-registered login would have no FUSION profile and could read or change nothing.
- Wrong passwords: Supabase Auth rate-limits sign-ins per IP, and the sign-in screen waits 2 s, 4 s, 8 s… (up to 30 s) after the third failure.
- Changing your password (Settings → Account & security, or the account menu) asks for the current password and signs the account out everywhere else. A forgotten admin password is reset only with the secret key on the owner's computer (`npm run reset:password`); there is no public reset page.
- Accounts are created, reset and (de)activated only via the `admin-users` Edge Function, which verifies the caller's token and admin role and then calls SQL functions with the caller's own JWT (so the database re-checks admin rights).
- Deactivation takes effect immediately (`is_active` is checked by every policy and function) and also bans the Auth user so no new token can be issued.
- **Portal switching** is a real sign-in: Admin → Staff requires the selected staff member's password; Staff → Admin requires the Admin master password (the admin account's password). The React Query cache is cleared on every account change, so no data leaks between accounts.
- The admin portal locks itself after configurable inactivity (default 15 min).
- In the browser, supabase-js keeps the session in this site's local storage. The strict Content-Security-Policy (only the app's own scripts may run) and the admin idle lock limit what that exposure could lead to. In the optional desktop build, tokens are stored encrypted with Windows DPAPI.

## Authorization

| Data | Admin | Staff |
|---|---|---|
| Tables, sessions, tabs | all floors, full history | own floor (or all floors if unassigned); only open sessions and those finished today |
| Customers | all | look-up by name/phone at checkout (2+ letters, max 8 results); full list only with *Edit customers* |
| Products | everything incl. cost & profit | `search_products` only (no cost price) |
| Sales (invoices) | all | **own sales only**, with *See own sales* or *Delete sales*; voids only while their own counter is open |
| Counter shifts, ledger, expenses | all | **own only** — never another staff member's, whatever the floor |
| Taking payments | **never** (the database refuses) | only with their own counter open |
| Pre-bookings, customer statistics, retention log | yes | no |
| Reports, business expenses, product sales and profit | yes | no (business expenses are not readable by staff; counter expenses remain own-only) |
| Daily summaries, reports, lifetime totals | yes | no |
| Settings, rates, staff | yes | no |

Permissions: apply_discount (discounts and custom rates per minute at checkout), delete_sales (today, own floor), cancel_session, counter_sale, manage_customers, adjust_stock, view_own_sales.

`tests/db/security.test.ts` verifies: anon can read nothing; staff cannot read cost prices, summaries or other users; floor isolation; no client can write any table directly; internal helper functions are not callable; every admin function refuses staff; staff cannot promote themselves; the last admin cannot be removed; deactivation is immediate.

## Web hardening (Vercel)

Set in `vercel.json` and tested end-to-end (`npm run preview` sends the same headers):

- **Content-Security-Policy:** `script-src 'self'` (no inline or third-party scripts), `connect-src` only the app and `*.supabase.co`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `upgrade-insecure-requests`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, location, payment off), `Cross-Origin-Opener-Policy: same-origin`, HSTS.
- Fonts are bundled with the app (no font CDN); the page is marked `noindex`.
- Receipts print from a sandboxed frame without scripts; receipt HTML is escaped data.
- The production build fails if the Supabase settings are missing or contain a secret key.

## Optional desktop build (Electron) hardening

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, DevTools disabled in packaged builds, no application menu.
- The renderer is served from a private `app://fusion` origin with a strict **Content-Security-Policy** (`script-src 'self'`; `connect-src` only the app and the configured Supabase project).
- The preload exposes a fixed set of narrow functions (`window.fusion`), never `ipcRenderer` or Node APIs. The main process accepts IPC only from the main window's top-level `app://fusion` frame and validates every payload (zod for receipts; key/size limits for the secure store).
- Navigation away from the app, new windows, `<webview>` and all permission requests are blocked.
- Receipts are rendered from validated data with HTML escaping, in a hidden window with JavaScript disabled.
- Electron fuses (via electron-builder): RunAsNode off, NODE_OPTIONS and `--inspect` off, asar integrity validation and only-load-from-asar on, cookie encryption on.

## Deployment checklist

- [ ] Public sign-up disabled in Supabase Auth (checked: off).
- [ ] All nine migrations applied; `admin-users` function deployed.
- [ ] Settings → Data retention shows *Automatic cleanup runs every hour* (pg_cron).
- [ ] First admin created; `.env.admin` deleted.
- [ ] Vercel has only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; no secret in GitHub (see DEPLOYMENT.md §2).
- [ ] The GitHub repository is private; your Supabase, Vercel and GitHub accounts use two-factor authentication.
- [ ] Backups in place (DEPLOYMENT.md §14).

## Known limitations

- Sale deletion and session cancellation are permission-gated. A void removes the invoice but is recorded on its counter shift (count and amount voided), and table sessions stay, marked *voided* / *cancelled*. A closed shift can never be changed. Grant these permissions only to trusted staff.
- Detailed invoices older than the retention period are deleted by design; their totals, the shift summaries and customer statistics are permanent.
- Staff names (not floors or permissions) are visible to any signed-in user, for the portal-switch list.
- The service-role key is necessarily present in Supabase's Edge Function environment; protect your Supabase dashboard account with 2FA.
