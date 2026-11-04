# FUSION — Gaming Lounge management & POS

FUSION runs FUSION Gaming Lounge: tables (snooker, pool, table tennis, PS5…), counter shifts, sales, expenses, inventory, customers and reports. It is a **web app**: the club opens one URL in a browser and signs in.

- **Web app:** React 19, TypeScript, Vite, Tailwind CSS 4, Framer Motion, Recharts, jsPDF. Hosted on **Vercel**, deployed from **GitHub**.
- **Backend:** Supabase (PostgreSQL, Auth, one Edge Function). An internet connection is required.
- **Security:** the database is the authority. Browsers can only read through Row Level Security and call validated database functions. The app contains only the public Supabase URL and publishable key; the secret key never leaves Supabase and your own computer.

**Deploying:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (GitHub → Vercel, migrations, Edge Function, backups, rollback) · More: [docs/DATABASE.md](docs/DATABASE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

---

## 1. Set up a club (once)

1. **Supabase project:** create one at <https://supabase.com>. Turn **off** *Allow new users to sign up* (Authentication → Sign In / Providers).
2. **Database:** apply the migrations in `supabase/migrations/` with `npx supabase db push` (see DEPLOYMENT.md §8). Optionally run `supabase/seed.sql` for starter floors and rates.
3. **Edge Function:** `npx supabase functions deploy admin-users --use-api --no-verify-jwt`.
4. **First administrator:** on your own computer, fill `.env.admin` (from `.env.admin.example`) and run `npm run setup:admin`; delete `.env.admin` afterwards.
5. **Web app:** push to GitHub, import into Vercel, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (DEPLOYMENT.md §4–6).
6. Sign in at the Vercel URL, then in **Settings** add floors, categories and rates per minute, and tables; in **Inventory** add products; in **Staff** create staff accounts.

## 2. Daily use

| Task | Who | Where |
|---|---|---|
| Open / close my counter, record expenses, see my Cash, Bank, Snacks, Total, Expenses, Net | Staff | **My counter** |
| Start / pause / resume / end a table (open play, fixed minutes, or prepaid amount; hourly-priced categories: a duration in 30-minute steps) | Staff, Admin | **Tables** |
| Extend an hourly-priced session (re-priced from the total time) | Staff, Admin | **Tables** → the session, or the time's-up alert |
| Add snacks to a running table's tab | Staff, Admin | Click the table card → *Tab* |
| Checkout (table charge + tab, custom rate per minute, discount in PKR or %, Cash, Bank Transfer or **Split** — part cash, part bank — receipt) | Staff with an open counter | *End* → Checkout |
| Sell snacks and drinks without a table (cart, quantities, Cash, Bank Transfer or Split) | Staff with *Counter sales* (admins see stock and every snack sale) | **Snacks** (or *Counter sale* on Tables / Dashboard) |
| A fixed-time or fixed-amount booking runs out: popup + alarm; silence it, then end or continue the session | Staff, Admin | Any page (alert) · **Tables** |
| Sales per table for a period (Today / Yesterday / Weekly / Monthly / Custom) | Admin | **Tables → Table Sales Report** |
| Watch every staff member's figures live; close a forgotten counter | Admin | **Dashboard → Staff today** |
| Shift history, invoices, daily figures (Today / Weekly / Monthly / Custom) | Admin | **History** |
| Financial summary for a period (Today / Yesterday / Week / Month / Custom), staff-wise and shift-wise, **Export PDF** | Admin | **Reports** |
| Business expenses (rent, utilities, repairs…) and every counter expense, with charts | Admin | **Expenses** |
| Products sold in a period, cost of goods and gross profit | Admin | **Inventory → Sales & profit** |
| Finalise a business day's summary | Admin | **History → Close day** |
| Reserve a table and start it when the customer arrives | Admin | **Pre-bookings** |
| Regulars: most visits, most playing time, highest spending | Admin | **Customers → Rankings** |
| How long detailed invoices are kept (1, 7 or 30 days) | Admin | **Settings → Data retention** |
| Start all business records from zero (password, optional backup, type RESET BUSINESS DATA) | Admin | **Settings → Data management** |
| Switch Admin → Staff (staff member's password) / Staff → Admin (Admin master password) | Everyone | Account button (bottom of the sidebar) |

Every time of day in FUSION is shown in 12-hour form (e.g. 07:15 PM).

### Billing rules
Configured in **Settings → Billing rules** and applied identically by the timer, checkout, receipt and reports:

- Each category has a **pricing mode** (Settings → Categories & rates):
  - **Per minute** (e.g. Snooker, Pool): rupees per minute (tables may override), up to four decimals; open play, fixed time or fixed amount.
  - **Hourly + under-1-hour rate** (e.g. PS5 PKR 600/hour, PKR 800/hour under 1 hour): while fewer than 60 minutes are billed, all of the time is charged at the under-1-hour rate (15 min = PKR 200, 45 min = PKR 600); from 60 billed minutes all of it at the hourly rate (1 h = PKR 600, 1.5 h = PKR 900). Open play, fixed time and fixed amount work as on per-minute tables (a prepaid amount buys time at the hourly rate once it covers an hour: PKR 400 = 30 min, PKR 700 = 70 min); a booking never bills less than its price; *Continue* re-prices the whole time. The under-1-hour rate must be higher than the hourly rate. No per-minute custom rate (a discount still applies); a table's own per-minute rate does not apply.
  - **Hourly + special 30-minute rate** (e.g. PS5 PKR 600/hour with 30 minutes at PKR 400): time is sold in 30-minute steps. Exactly 30 minutes costs the special price; an hour or more costs the hourly rate × hours (1.5 h = PKR 900 — the special price is never added on top). Staff pick the duration and see the price before starting. **Extending** (Tables → the session, or the time's-up alert) adds 30-minute steps and re-prices the whole time (1 h + 30 min = 1.5 h = PKR 900, not 600 + 400). No open play, prepaid amount, per-minute "continue" or per-minute custom rate for these categories; a discount still applies.
- A session **keeps the prices it started with**, so changing a category's prices never changes a running session, its extensions or any invoice.
- Played time = elapsed time − paused time. Time is billed in blocks (default 1 minute), rounded **up** (default), **to nearest**, or **down**, with an optional minimum charge.
- Table charge = billed minutes × rate per minute, rounded half-up to a whole rupee.
- **Fixed time** bookings charge the booked minutes; **fixed amount** bookings convert PKR into whole seconds of play (e.g. PKR 400 at PKR 10/min = 40 min). Leaving early still pays the booking.
- **Time's up:** when a booking is used up, its clock stops at 0:00 and billing **holds at the booked amount** — however long staff take to react. A popup and an alarm appear on every computer showing that table, each table on its own. *Silence alarm* stops the sound everywhere (also after a refresh) and changes nothing else. Staff then **End** the session (the booked amount is charged) or **Continue**: play goes on and extra time is billed per minute from that moment (without the minimum); the minutes the session was held are never charged.
- **Custom rate per minute (regulars):** at checkout a cashier with the *Discounts & custom rates* permission can enter another rate. It re-prices all of the played time with the same rules (a booking's time pro rata), e.g. 100 min at 10/min = 1,000 → at 9/min = 900. The discount (PKR or %) then applies to that bill: 900 − 30 = 870. The invoice and receipt show the custom rate and the standard rate it replaced; the counter, ledger, History and customer statistics record the amount actually paid, and only the discount counts as a discount.
- *End* freezes the bill; *Reopen* resumes the clock without charging the time spent at checkout.
- **Split payment:** at checkout choose **Split** and type the cash part or the bank part — the other is filled in as the rest of the total (both must be above zero). The invoice keeps the cash part; the counter, Dashboard, History, Reports, Close day, snack and table sales count each part as cash or bank. The receipt shows *Paid by Cash + Bank* with both amounts.

### Counters, accounting and history
- A staff member opens **their own counter** before taking payments or recording expenses. Every payment, void and expense is posted — in the same database transaction — to that counter shift and to a permanent per-day ledger. **Total sales = Cash + Bank Transfer**; **Snack sales** are shown separately but are already inside Cash/Bank; **Net = Total − Expenses**.
- Closing a counter saves its final figures (checked against the ledger and the invoices). A closed shift never changes: its sales cannot be voided and its expenses cannot be edited. Table sessions still running when a counter closes are handed over and paid at whichever counter checks them out.
- Administrators manage the business and **cannot take payments** — the database refuses it.
- Staff can never read another staff member's sales, shifts or expenses (Row Level Security).

### Close day
Finalises a business day's Cash, Bank, Total, Expenses and Net in `daily_summaries`, once every counter that traded that day is closed. **It deletes nothing.** Closing again after late activity refreshes the summary (never double-counts).

### Reports, expenses and product profit
- **Reports** read the permanent shift ledger. Final figures come only from **closed** counters (plus amounts archived before counters existed); open counters are listed separately as live, provisional figures. Net = Total sales − counter expenses − business expenses. The PDF is built from the same data as the page.
- **Business expenses** are recorded by an administrator with a date and category. They count in Reports and Expenses but never change a counter's cash, the shift ledger or History. Counter expenses are still recorded and voided by staff at their counter.
- **Gross profit** (Inventory → Sales & profit) = product sales after their share of invoice discounts − the cost price recorded at each sale. Table time is never product revenue, and business expenses are not deducted. Products sold before cost tracking (migration 0900) show sales but no profit; FUSION does not guess past costs.

### Phones and tablets
**Install it like an app:** in Chrome on Android choose *Add to Home screen* / *Install app*; in Safari on iPhone, *Share → Add to Home Screen*. It appears as **FUSION GAMES** with the FUSION logo and opens full screen.

The same app, with the same accounts and permissions, works in a phone or tablet browser (Chrome, Safari, Edge). On a **phone** a tab bar at the foot of the screen holds the role's main pages — staff: Dashboard, Tables, Snacks, (My) Counter; admin: Dashboard, Tables, Reports, History — and **More** opens every other page plus the account (switch portal, change password, sign out). Dialogs and the table panel open as sheets from the bottom, tables of figures become cards, and the Snacks cart keeps its total and **Checkout** at the foot of the screen. **Tablets** keep the sidebar rail used on narrow desktop windows; wide tables scroll sideways inside their card. Desktop screens are unchanged. Receipts print through the phone's own print dialog (or save as PDF).

### Snacks and table sales
- **Snacks** sells to customers who are not playing: the sale belongs to the staff member's open counter like any counter sale, takes the stock (never below zero), counts in snack sales, Reports and Inventory → Sales & profit, and is never assigned to a table.
- **Table Sales Report** (Tables → Table Sales Report, admin) shows, per table, the paid sessions, cash, bank transfer and total — table time plus snacks put on that table's tab, after discounts. Snack-only sales are not table sales. It reads the invoices themselves, so once the retention policy removes old invoices their table sales are gone too: no hidden totals are kept.

### Reset business data
**Settings → Data management → Reset business data** (administrators only) permanently deletes every table session, pre-booking, invoice and invoice line (table and snack sales), counter shift and its accounting, expense, closed day, product sales history, customer and visit history, and the cleanup log. Receipt numbers start again at 1 and units-sold counts at 0. Logins, roles, floors, tables, categories and prices, products (and their stock, unless you choose to zero it), settings and data retention stay. The database checks the administrator's password and the typed phrase *RESET BUSINESS DATA*, does everything in one transaction (all or nothing) and lets only one reset run at a time. Before confirming you may **Export backup** (a JSON file of every record that will be deleted) or **Skip backup & continue**. It never runs on a schedule; the automatic cleanup below is separate.

### Automatic invoice cleanup (retention)
Detailed invoices (sales + sale items) older than the chosen period — **Monthly (30 days) by default**, or Weekly / Daily — are removed hourly by a server-side job, but only from **closed** counter shifts, whoever made the sale. Shift summaries, the daily ledger, expenses, customers and their statistics, product sales and every Cash / Bank / Total / Net figure are permanent, so History and Reports stay correct. Each run is logged (Settings → Data retention). Deleted rows free space for reuse straight away; PostgreSQL does not shrink the database file immediately, so the size shown in Supabase falls only after routine maintenance.

### Upgrading from an earlier version
The `…0700` migration attaches every existing sale to an *imported* closed shift (one per cashier per day), builds the ledger and customer statistics from them, and keeps totals saved by the old "Close Day & Archive" as legacy amounts. Nothing is deleted. Redeploy the Edge Function.

The `…0800` migration switches every rate to **per minute**: stored hourly rates (categories, table overrides and the snapshots on past sessions and invoices) are divided by 60 and kept to four decimals, so prices bill exactly as before (PKR 600/hour → 10/min; 400/hour → 6.6667/min — set a round figure in Settings if you prefer). No stored amount is recalculated and nothing is deleted.

The `…1300` migration adds split payments (`sales.split_cash_amount`), the "hourly + under-1-hour rate" pricing mode (`under_hour_rate` on `table_categories` and `sessions`) and fixes Reset business data, which the live API's *safeupdate* guard refused (an update without a WHERE clause). Three nullable columns, no new tables; nothing is deleted or rewritten.

The `…1200` migration adds Reset business data (two columns on `settings` recording the last reset, and admin-only functions). Nothing runs automatically; nothing is deleted by the migration.

The `…1100` migration adds the "hourly + special 30-minute rate" pricing mode (columns on `table_categories` and `sessions`, extension). Existing categories stay per minute; nothing is deleted.

The `…1000` migration adds the time's-up hold (two columns on `sessions`), snack-sales and table-sales report functions. Nothing is deleted.

The `…0900` migration adds business expenses, cost-at-sale on invoice lines and the permanent product sales table (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#8-apply-database-migrations-safely)). Nothing is deleted.

## 3. Development

```powershell
npm install
```
```powershell
npm run dev
```
`npm run dev` serves the web app at <http://localhost:5173> using `.env` (see `.env.example`). It talks to the Supabase project in `.env`, so it is real data.

| Script | What it does |
|---|---|
| `npm run dev` | Web app with hot reload |
| `npm run build` | Production web build into `dist/web` (what Vercel runs). Fails if the Supabase settings are missing or a secret key was used |
| `npm run preview` | Serves `dist/web` locally with the same security headers as Vercel |
| `npm run typecheck` | Strict TypeScript for the app, tests and desktop shell |
| `npm test` | Unit tests + database tests (real migrations in PGlite) |
| `npm run test:e2e` | Builds, then drives the web app in Google Chrome (and a desktop smoke test) against a local Supabase-compatible test server |
| `npm run setup:admin` / `npm run reset:password` | Create an administrator / set a forgotten password (your computer only, needs `.env.admin`) |
| `npm run dev:desktop`, `npm run dist:win` | Optional Windows desktop build (same app in Electron, configured from `.env` at build time) |

### Project layout

```
src/renderer/    The app: React UI — features/{auth,tables,pos,counter,shifts,history,reports,expenses,bookings,dashboard,sales,inventory,customers,staff,settings}
src/renderer/src/lib/platform.ts   Web vs desktop differences (config, printing, window buttons)
src/shared/      Billing rules, receipt renderer, formatting, key validation (shared by app, desktop shell and tests)
src/main, src/preload   Optional Electron desktop shell
supabase/        Migrations (schema, RLS, functions, grants), Edge Function, seed
scripts/         create-admin.mjs (first admin / password reset), build-e2e.mjs, make-icons.mjs
tests/unit       Billing, formatting, receipt escaping, key validation, report PDF
tests/db         Sessions, checkout, stock, permissions/RLS, counter shifts, close day, retention, reports, expenses, product profit, upgrades, TS↔SQL billing parity
tests/e2e        Browser end-to-end flows + screenshots; desktop smoke test
vercel.json      Vercel build settings, page routing and security headers
```

## 4. Production notes

- **Printing:** receipts open the browser's print dialog (80 mm, 58 mm or A4 — Settings → This computer). For dialog-free printing on a counter PC, start Chrome with `--kiosk-printing`.
- **Backups:** see DEPLOYMENT.md §14. Invoices older than the retention period keep only their totals by design; export monthly Reports PDFs as a business record.
- **Timezone:** the business timezone and day-start hour are in **Settings → Business day** (default Asia/Karachi, midnight). Every date filter uses the club's business day, not the computer's clock.
