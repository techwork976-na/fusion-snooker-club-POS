# Deploying FUSION (GitHub → Vercel, Supabase)

FUSION is now a **web app**. The club opens one URL in a browser; there is nothing to install on the club's computers.

There are **three separate things** to deploy, and they never update each other automatically:

| Part | Where it runs | How it is updated |
|---|---|---|
| **Web app** (everything in `src/`) | Vercel | Push to GitHub → Vercel builds and publishes it |
| **Database** (tables, rules, functions in `supabase/migrations/`) | Supabase | You run `npx supabase db push` yourself |
| **Edge Function** `admin-users` (staff accounts) | Supabase | You run `npx supabase functions deploy` yourself |

> Pushing code to GitHub **does not** change the database or the Edge Function. When an update includes a new migration, apply the migration first, then let Vercel publish the web app.

All commands below are for **PowerShell on Windows**, run from the project folder (`C:\Users\dell\Desktop\snooker by claude`). You need Node.js 22.12 or newer (`node -v`) and Git (`git --version`). Docker is **not** needed.

---

## 1. Prepare the GitHub repository

1. Create an **empty, private** repository on <https://github.com/new> (no README, no .gitignore — the project has its own). Keep it private: it contains your business logic.
2. In the project folder:
   ```powershell
   git init -b main
   ```
   ```powershell
   git add -A
   ```
   ```powershell
   git status
   ```
   Check the list: there must be **no** `.env`, `.env.admin`, `node_modules`, `dist`, `out`, `release` or `supabase/.temp` in it (they are in `.gitignore`).
   ```powershell
   git commit -m "FUSION web app"
   ```
   ```powershell
   git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPO.git
   ```
   ```powershell
   git push -u origin main
   ```

## 2. Files that must never be committed

| File | Why |
|---|---|
| `.env` | Your local settings (public values, but personal to your machine) |
| `.env.admin` | Contains the **secret** service-role key |
| `supabase/.temp/` | Your Supabase CLI link details |
| `out/`, `dist/`, `release/`, `node_modules/` | Build output and downloaded packages |

They are all in `.gitignore`. Only `.env.example` and `.env.admin.example` (placeholders) are tracked.

**If a secret was ever committed:** adding it to `.gitignore` afterwards does **not** remove it from Git history. Treat it as leaked: rotate it in Supabase (Project Settings → API Keys → create a new secret key and delete the old one; for the database password, Project Settings → Database → Reset password), then clean the history or start a fresh repository.

## 3. Local development (`.env`)

```powershell
Copy-Item .env.example .env
```
Fill in, from Supabase → Project Settings → API Keys / Data API:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your publishable (sb_publishable_…) or anon key
```

Only these two **public** values. Never the secret / service-role key — the build refuses secret keys. Then:

```powershell
npm install
```
```powershell
npm run dev
```
Open <http://localhost:5173>. (A `.env` for this PC has already been created with your project's public URL and anon key.)

> `npm run dev` talks to the **live** Supabase project — it is real data. For experiments, create a second Supabase project and point `.env` at it.

## 4. Vercel environment variables

In Vercel → your project → **Settings → Environment Variables**, add for **Production** (and **Preview**, see step 12):

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://YOUR-PROJECT-REF.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the publishable or anon key |

`VITE_` variables are copied into the browser code on purpose; that is why only public values belong here. If either is missing or is a secret key, **the build fails** and the previous version stays online — a misconfigured deployment can never go live.

## 5. Connect GitHub to Vercel

1. Sign in at <https://vercel.com> with your GitHub account.
2. **Add New → Project → Import** your FUSION repository.
3. **Framework Preset: Other.** Leave Build Command, Output Directory and Install Command empty — `vercel.json` sets them (`npm run build`, `dist/web`, and an install that skips the desktop Electron download).
4. Add the two environment variables (step 4) before the first deploy.

## 6. Deploy the web app

Click **Deploy**. When it finishes, Vercel shows the URL, e.g. `https://fusion-gaming-lounge.vercel.app`. That is the address the club uses. Optionally add your own domain under Settings → Domains.

Every later `git push` to `main` publishes a new version at the **same URL**. Club computers get it on their next page load.

`vercel.json` also sends strict security headers (Content-Security-Policy, no framing, HTTPS only) and sends every page path to the app, so refreshing any page works.

## 7. Supabase authentication and accounts

In the Supabase dashboard → **Authentication**:

- **Sign In / Providers → Email:** *Allow new users to sign up* must be **off** (checked: it is off on your project). Accounts are created only by an administrator.
- **Rate limits:** keep the defaults (they limit password guessing per IP). FUSION also slows down repeated wrong passwords on the sign-in screen.
- **Password policy:** set a minimum length of 10 or more.
- **URL Configuration → Site URL:** set it to your Vercel URL (FUSION sends no emails, but this keeps Auth's settings tidy).

**The client's login.** Usernames sign in as `<username>@fusion.local`; no email is ever sent.

- To create an administrator login for the client, run this on **your** computer:
  ```powershell
  Copy-Item .env.admin.example .env.admin
  ```
  Put the project URL and the **secret** key in `.env.admin`, then:
  ```powershell
  npm run setup:admin
  ```
  Then delete `.env.admin`:
  ```powershell
  Remove-Item .env.admin
  ```
- The client changes their own password in **Settings → Account & security → Change password** (or the account menu). Changing it signs the account out on every other computer.
- Staff accounts are created and reset by an administrator on the **Staff** page.
- **Forgotten administrator password:** there is no public reset page — a reset link would be a backdoor. Run `npm run reset:password` on your computer (with `.env.admin` as above), enter the username and a new password, then delete `.env.admin`.

## 8. Apply database migrations safely

Migrations are in `supabase/migrations/` and are applied in filename order. Your project already has `…0100` to `…0800`. This update adds **`…0900_reports_expenses_product_sales.sql`** — **not applied yet**.

What `0900` does (nothing is deleted or recalculated):

- `expenses`: `shift_id` becomes optional and a `category` column is added, so administrators can record business expenses (rent, utilities…) that never touch a counter. Existing expenses are unchanged.
- `sale_items`: new `unit_cost` — the cost price at the moment of sale (empty for older lines; FUSION does not guess past costs).
- New permanent table `product_sales_daily` — product quantities, revenue, discount share and cost per day. It survives invoice cleanup, so product sales history isn't lost. It is filled once from the invoices that still exist.
- New admin-only functions for Reports, Expenses and Inventory sales and profit. Checkout and sale deletion also update the product ledger; nothing else in them changes.
- It works with the current app as well, so apply it **before** publishing the new web app.

Steps:

1. Make a backup first (step 14).
2. Log in and link once (skip if already done on this PC):
   ```powershell
   npx supabase login
   ```
   ```powershell
   npx supabase link --project-ref YOUR-PROJECT-REF
   ```
3. See what would be applied (changes nothing):
   ```powershell
   npx supabase db push --linked --dry-run
   ```
   It should list only `20261103000900_reports_expenses_product_sales.sql`.
4. Apply it:
   ```powershell
   npx supabase db push --linked
   ```
   (Newer CLI versions may ask you to confirm, or to use `--remote` instead of `--linked`.)
5. Verify:
   ```powershell
   npx supabase migration list --linked
   ```
   `20261103000900` must show in the Remote column. Then sign in as admin and open **Reports**, **Expenses** and **Inventory → Sales & profit**.

Each migration runs in one transaction: if anything fails, nothing from it is applied.

## 9. Edge Function

`supabase/functions/admin-users/index.ts` (create, reset, deactivate and delete staff logins) is the only server code holding the secret key, which Supabase provides to it automatically. It is unchanged in this update and version 2 is already deployed. Redeploy only when that file changes:

```powershell
npx supabase functions deploy admin-users --use-api --no-verify-jwt
```

`--no-verify-jwt` is intentional: the function checks the caller's sign-in and admin role itself.

## 10. Scheduled invoice cleanup (retention)

Cleanup runs **inside the database** every hour (pg_cron) — no browser needs to be open. To check:

- In FUSION: **Settings → Data retention** should say *Automatic cleanup runs every hour*, with the latest runs listed.
- Or in Supabase → SQL Editor (read-only):
  ```sql
  select jobname, schedule, active from cron.job;
  select started_at, status, sales_deleted, message from public.retention_runs order by started_at desc limit 5;
  ```
  Your project: job `fusion-sales-retention`, `17 * * * *`, active; the latest run succeeded.

What it removes: invoices (`sales`) and their lines (`sale_items`) older than the chosen period (Daily = keeps today and yesterday, Weekly = 7 days, Monthly = 30 days), and **only from closed counters**, whoever made the sale. It never removes counter shifts, the shift ledger, daily summaries, expenses, customers, customer statistics or product sales. Report and History totals do not change.

## 11. Test the production URL

After the first deploy (and after every update):

1. Open the URL: the **Sign in** screen appears; there is no sign-up and no server setup.
2. Sign in as the administrator. Refresh the page — you stay signed in, on the same page.
3. Dashboard, Tables, History and Settings load with your real data.
4. Reports → Today / Month → **Export PDF** downloads a PDF with the same figures.
5. Expenses → add a small test expense, then void it.
6. Inventory → Sales & profit shows products sold this month.
7. Staff: sign in as a staff member in another browser profile; they see only their floor and their own counter.
8. Settings → This computer → **Print test page** opens the browser's print dialog.
9. Sign out, then refresh: the Sign in screen stays.

Printing note: a web page cannot print silently or choose a printer by itself — the browser's print dialog does. To skip the dialog on a dedicated counter PC, start Chrome with `--kiosk-printing` (it prints straight to the default printer).

## 12. Publish future updates safely

1. Work on a branch:
   ```powershell
   git switch -c my-change
   ```
2. Run the checks locally:
   ```powershell
   npm run typecheck
   ```
   ```powershell
   npm test
   ```
   ```powershell
   npm run test:e2e
   ```
3. Push the branch. Vercel builds a **Preview** deployment at its own URL and leaves production untouched. Test it there.
   - Preview deployments use the **Preview** environment variables. Point them at a separate test Supabase project if you can; otherwise the preview uses your live data.
4. If the change includes a migration, apply it (step 8) **before** merging.
5. Merge the branch into `main` (on GitHub, open a pull request and merge). Vercel publishes it to the production URL.

A build that fails never replaces the running version.

## 13. Roll back a broken web deployment

Vercel → your project → **Deployments** → choose the last good **Production** deployment → **⋯ → Instant Rollback** (or *Promote to Production*). The URL switches back within seconds. Then fix the code and push again.

This rolls back the **web app only**. A migration is not undone by a Vercel rollback. Migrations here only add things, so an older web version keeps working with a newer database.

## 14. Back up and recover business data

- **Supabase backups:** paid plans keep daily backups (Database → Backups) and can add point-in-time recovery. On the free plan, make your own backups.
- **Your own backup** needs PostgreSQL's `pg_dump`. Either install the PostgreSQL client tools for Windows, or use:
  ```powershell
  npx supabase db dump --linked -f backup-schema.sql
  ```
  ```powershell
  npx supabase db dump --linked --data-only -f backup-data.sql
  ```
  (Some CLI versions run `pg_dump` inside Docker; if it asks for Docker, use the PostgreSQL tools with the connection string from Supabase → Connect.) Keep backups outside the project folder and never commit them — they contain customer data.
- **Business record:** export the monthly **Reports PDF** and keep it. It holds the final totals even after old invoices are cleaned up.
- **Recover:** restore a Supabase backup from the dashboard (paid plans). Or create a new project, apply all migrations (step 8), then load your data dump with `psql`. Point Vercel's environment variables at the new project and redeploy.
