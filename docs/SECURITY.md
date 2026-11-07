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
- **Accounts on a device (owner's choice, 2026-11):** each account signs in once with its own password; its Supabase session is then kept on the device so one click switches to it — no password and no idle lock — until **Log out of all accounts**, which ends every kept session on the server (refresh tokens revoked) and clears the device. The database still authorises every request by the one account it comes from (RLS, permissions, floors); switching never widens what an account may do. Anyone using a terminal can therefore use every account signed in on it — the club accepts this for convenience. The React Query cache is cleared on every account change, so no data leaks between accounts.
- The admin portal locks itself after configurable inactivity (default 15 min).
- In the browser, supabase-js keeps the session in this site's local storage. The strict Content-Security-Policy (only the app's own scripts may run) limits what that exposure could lead to. In the optional desktop build, tokens are stored encrypted with Windows DPAPI.

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
| Reset business data, business-data backup export | yes — and only with the administrator's own password (checked by the database) | no |
| Stock changes (restock / correction) | yes, and reads the stock log | with *Restock products*; every change is logged (who, how much, stock after) |

Permissions: apply_discount (discounts and custom rates per minute at checkout), delete_sales (today, own floor), cancel_session, counter_sale, manage_customers, adjust_stock, view_own_sales.

**Stock log.** Every manual stock change — Restock / Correct, and a new product's opening stock — is written to `stock_adjustments` by the database function that makes the change, in the same transaction. The API roles have no privileges on that table (it cannot be read or written directly); administrators read it through `get_stock_adjustments` (Inventory → stock dialog). Stock that moves with sales, voids and cancelled tabs is recorded on the invoices and sessions themselves.

**Secure by default.** Supabase grants the API roles full access to any new table, sequence or function in `public`. Migration 1400 revokes those default privileges, so an object a future migration creates is closed until that migration grants exactly what it needs (as every FUSION migration does).

`tests/db/security.test.ts` and `tests/db/security-hardening.test.ts` verify: anon can read nothing; staff cannot read cost prices, summaries or other users; floor isolation; no client can write any table directly; internal helper functions are not callable; every admin function refuses staff; staff cannot promote themselves; the last admin cannot be removed; deactivation is immediate.

## Web hardening (Vercel)

Set in `vercel.json` and tested end-to-end (`npm run preview` sends the same headers):

- **Content-Security-Policy:** `script-src 'self'` (no inline or third-party scripts), `connect-src` only the app and `*.supabase.co`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `upgrade-insecure-requests`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, location, payment off), `Cross-Origin-Opener-Policy: same-origin`, HSTS.
- Fonts are bundled with the app (no font CDN); the page is marked `noindex`.
- Receipts print from a sandboxed frame without scripts; receipt HTML is escaped data.
- The production build fails if the Supabase settings are missing or contain a secret key.
- **No source, no debug output:** no source maps are built or published; the bundle is minified with every `console.*` call and `debugger` statement removed. `/runtime-guard.js` loads before the app in production builds: it silences the browser console (third-party libraries included) and disables the React DevTools hook, and the charts' Redux DevTools connection is turned off — so a browser extension cannot attach to the live app's components or state. (Code that runs in a browser can always be downloaded; the security boundary is the database.)

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
- [ ] The GitHub repository is private (it holds no secrets, but the whole source and database rules are readable while it is public); your Supabase, Vercel and GitHub accounts use two-factor authentication.
- [ ] Supabase → Authentication → Policies: minimum password length 8 (FUSION requires 8–72 characters when an administrator creates or resets an account; the project setting also covers a user changing their own password).
- [ ] Backups in place (DEPLOYMENT.md §14).

## Known limitations

- Sale deletion and session cancellation are permission-gated. A void removes the invoice but is recorded on its counter shift (count and amount voided), and table sessions stay, marked *voided* / *cancelled*. A closed shift can never be changed. Grant these permissions only to trusted staff.
- Detailed invoices older than the retention period are deleted by design; their totals, the shift summaries and customer statistics are permanent.
- Staff see the names and usernames of the active administrator accounts (for *Switch to Admin portal*); administrators see everyone. Staff never receive other staff members' accounts.
- The service-role key is necessarily present in Supabase's Edge Function environment; protect your Supabase dashboard account with 2FA.
